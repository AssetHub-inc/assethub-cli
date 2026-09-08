import {createHash} from 'node:crypto'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, expect, it} from 'vitest'

import {importCanvasAssetWithState} from '../canvasAssetImport.js'

const folders: string[] = []
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map(folder => rm(folder, {recursive: true, force: true})),
  )
})

// The API can commit an asset before its response is lost: restarting must reuse the saved upload ID.
it('recovers an uncertain image import without reuploading and isolates other owner scopes', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'assethub-canvas-import-'))
  folders.push(folder)
  const filePath = join(folder, 'original.png')
  const bytes = Buffer.from('original image bytes')
  await writeFile(filePath, bytes)
  let uploadCount = 0
  let loseResponse = true
  const imported = new Map<
    string,
    {assetId: string; mediaType: 'image'; canvasId: number}
  >()
  const requests: string[] = []
  const client = {
    v2: {
      uploadFile: async () => ({
        uploadId: `upload-${++uploadCount}`,
        fileRef: {
          type: 'supabase' as const,
          bucket: 'staging',
          path: 'file.png',
        },
      }),
      importCanvasAsset: async (
        canvasId: number,
        body: {source: {uploadId?: string; resourceId?: string}; name?: string},
      ) => {
        const identity = body.source.uploadId ?? body.source.resourceId!
        requests.push(identity)
        const result = imported.get(identity) ?? {
          assetId: `asset-${identity}`,
          mediaType: 'image' as const,
          canvasId,
        }
        imported.set(identity, result)
        if (loseResponse) {
          loseResponse = false
          throw new Error('response lost after server commit')
        }
        return result
      },
    },
  }
  const options = {
    client,
    baseUrl: 'https://api.example/',
    ownerId: 'org-a',
    canvasId: 42,
    stateDir: join(folder, 'state'),
    filePath,
    name: 'B6 original',
  }
  await expect(importCanvasAssetWithState(options)).rejects.toThrow(
    'response lost',
  )
  const resumed = await importCanvasAssetWithState(options)
  expect(uploadCount).toBe(1)
  expect(requests).toEqual(['upload-1', 'upload-1'])
  expect(imported.size).toBe(1)
  expect(resumed.assetId).toBe('asset-upload-1')
  expect(resumed.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
  const saved = JSON.parse(await readFile(resumed.statePath, 'utf8'))
  expect(saved).toMatchObject({
    uploadId: 'upload-1',
    result: {assetId: 'asset-upload-1'},
  })
  expect(saved).not.toHaveProperty('apiKey')
  const explicit = await importCanvasAssetWithState({
    client,
    baseUrl: options.baseUrl,
    ownerId: 'org-a',
    canvasId: 42,
    stateDir: options.stateDir,
    source: {uploadId: 'upload-1'},
  })
  expect(explicit.assetId).toBe(resumed.assetId)
  expect(uploadCount).toBe(1)
  await importCanvasAssetWithState({...options, ownerId: 'org-b'})
  expect(uploadCount).toBe(2)
  expect(await readFile(filePath)).toEqual(bytes)
})
