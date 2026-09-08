import {createHash, randomUUID} from 'node:crypto'
import {
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import {basename, dirname, join} from 'node:path'
import type {Canvas} from '@assethub/api-client'

type CanvasScope = {
  stateDir: string
  cwd: string
  baseUrl: string
  ownerId: string
}
type CanvasClient = {
  v2: {
    createCanvas: (
      body: {name: string},
      options: {idempotencyKey: string},
    ) => Promise<Canvas>
    getCanvas: (id: number) => Promise<Canvas>
  }
}

export const writeState = async (
  path: string,
  value: unknown,
): Promise<void> => {
  await mkdir(dirname(path), {recursive: true, mode: 0o700})
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value), {mode: 0o600, flag: 'wx'})
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

export const readState = async (path: string): Promise<unknown | undefined> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return undefined
    throw error
  }
}

const scopeHash = async (scope: CanvasScope): Promise<string> =>
  createHash('sha256')
    .update(
      JSON.stringify([
        scope.baseUrl.replace(/\/+$/, ''),
        scope.ownerId,
        await realpath(scope.cwd),
      ]),
    )
    .digest('hex')

/** A stable operation identity lets the server deduplicate even a crashed first invocation. */
const creationId = (hash: string): string =>
  `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`

export const saveCanvasSelection = async (
  scope: CanvasScope,
  canvasId: number,
): Promise<void> => {
  if (!Number.isSafeInteger(canvasId) || canvasId <= 0)
    throw new Error('Canvas ID must be a positive integer')
  await writeState(
    join(scope.stateDir, 'canvases', `${await scopeHash(scope)}.json`),
    {canvasId},
  )
}

export const resolveCanvasSelection = async (
  options: CanvasScope & {
    client: CanvasClient
    canvasId?: number
    create?: boolean
  },
): Promise<Canvas> => {
  const {client} = options
  let canvasId = options.canvasId
  const hash = await scopeHash(options)
  if (canvasId == null) {
    const stored = await readState(
      join(options.stateDir, 'canvases', `${hash}.json`),
    )
    if (stored != null) {
      if (
        typeof stored !== 'object' ||
        !('canvasId' in stored) ||
        !Number.isSafeInteger(stored.canvasId)
      ) {
        throw new Error(
          'Invalid saved canvas selection; select one with canvas use <id>',
        )
      }
      canvasId = Number(stored.canvasId)
    }
  }
  if (canvasId != null) {
    if (!Number.isSafeInteger(canvasId) || canvasId <= 0)
      throw new Error('Canvas ID must be a positive integer')
    const canvas = await client.v2.getCanvas(canvasId)
    if (canvas.ownerId !== options.ownerId)
      throw new Error('Canvas belongs to a different organization')
    return canvas
  }
  if (options.create === false)
    throw new Error('No canvas selected; use --canvas <id> or canvas use <id>')
  // Check local persistence before starting a remote mutation. The same scope
  // always posts the same name and key, including after a lost response.
  const directory = join(options.stateDir, 'canvases')
  await mkdir(directory, {recursive: true, mode: 0o700})
  const probe = join(directory, `${hash}.${randomUUID()}.probe`)
  await writeFile(probe, '', {mode: 0o600, flag: 'wx'})
  await unlink(probe)
  const canvas = await client.v2.createCanvas(
    {name: `CLI ${basename(await realpath(options.cwd))} ${hash.slice(0, 8)}`},
    {idempotencyKey: creationId(hash)},
  )
  if (canvas.ownerId !== options.ownerId)
    throw new Error('Created canvas belongs to a different organization')
  await saveCanvasSelection(options, canvas.id)
  return canvas
}
