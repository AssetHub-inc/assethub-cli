import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {resolveCanvasSelection, saveCanvasSelection} from '../canvas.js'

const folders: string[] = []
const temporary = async () => {
  const path = await mkdtemp(join(tmpdir(), 'assethub-canvas-'))
  folders.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map(path => rm(path, {recursive: true, force: true})),
  )
})

describe('CLI canvas selection', () => {
  it('concurrent first commands submit the same creation identity and reuse the saved canvas', async () => {
    const stateDir = await temporary()
    const requests: string[] = []
    const canvases = new Map<string, number>()
    const client = {
      v2: {
        createCanvas: async (
          body: {name: string},
          options: {idempotencyKey: string},
        ) => {
          requests.push(options.idempotencyKey)
          const id = canvases.get(options.idempotencyKey) ?? 42
          canvases.set(options.idempotencyKey, id)
          return {
            id,
            name: body.name,
            url: 'https://api.test/workflow/42',
            ownerId: 'org-a',
          }
        },
        getCanvas: async (id: number) => ({
          id,
          name: 'canvas',
          url: 'https://api.test/workflow/42',
          ownerId: 'org-a',
        }),
      },
    }
    const options = {
      client,
      stateDir,
      cwd: stateDir,
      baseUrl: 'https://api.test',
      ownerId: 'org-a',
    }
    const results = await Promise.all([
      resolveCanvasSelection(options),
      resolveCanvasSelection(options),
    ])
    expect(results.map(canvas => canvas.id)).toEqual([42, 42])
    expect(new Set(requests).size).toBe(1)
    await resolveCanvasSelection(options)
    expect(requests.length).toBeLessThanOrEqual(2)
  })

  it('an explicit missing canvas fails without creating a replacement', async () => {
    const stateDir = await temporary()
    let created = 0
    const client = {
      v2: {
        createCanvas: async () => {
          created++
          throw new Error('unexpected create')
        },
        getCanvas: async () => {
          throw new Error('Canvas not found')
        },
      },
    }
    await expect(
      resolveCanvasSelection({
        client,
        stateDir,
        cwd: stateDir,
        baseUrl: 'https://api.test',
        ownerId: 'org-a',
        canvasId: 99,
      }),
    ).rejects.toThrow('Canvas not found')
    expect(created).toBe(0)
  })

  it('never reuses another organization selection in the same working directory', async () => {
    const stateDir = await temporary()
    const scope = {
      stateDir,
      cwd: stateDir,
      baseUrl: 'https://api.test',
      ownerId: 'org-a',
    }
    await saveCanvasSelection(scope, 42)
    const client = {
      v2: {
        createCanvas: async () => ({
          id: 77,
          name: 'b',
          url: 'https://api.test/workflow/77',
          ownerId: 'org-b',
        }),
        getCanvas: async () => {
          throw new Error('must not read org-a selection')
        },
      },
    }
    expect(
      (await resolveCanvasSelection({...scope, ownerId: 'org-b', client})).id,
    ).toBe(77)
  })
})
