import {createHash} from 'node:crypto'
import {mkdir, open, readFile, unlink} from 'node:fs/promises'
import {basename, dirname, extname, join, resolve} from 'node:path'
import type {Source} from '@assethub/api-client'
import {readState, writeState} from './canvas.js'

type DurableSource = Extract<Source, {uploadId: string} | {resourceId: string}>
type ImportedAsset = {assetId: string; mediaType: 'image'; canvasId: number}
type ImportClient = {
  v2: {
    uploadFile: (input: {
      file: Blob
      fileName: string
      mediaType: 'image'
    }) => Promise<{uploadId?: string}>
    importCanvasAsset: (
      canvasId: number,
      input: {source: DurableSource; name?: string},
    ) => Promise<ImportedAsset>
  }
}
type ImportReceipt = {
  schemaVersion: 'assethub.canvas-import.v1'
  baseUrl: string
  ownerId: string
  canvasId: number
  sourceIdentity: string
  sha256?: string
  name?: string
  uploadId?: string
  resourceId?: string
  result?: ImportedAsset
}
type ImportOptions = {
  client: ImportClient
  baseUrl: string
  ownerId: string
  canvasId: number
  stateDir: string
  filePath?: string
  contentType?: string
  source?: DurableSource
  name?: string
}

const imageContentTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
}

/** Keep staging/import receipts separate from paid generation operation state. */
export async function importCanvasAssetWithState(
  options: ImportOptions,
): Promise<
  ImportedAsset & {statePath: string; sha256?: string; uploadId?: string}
> {
  if (
    !Number.isSafeInteger(options.canvasId) ||
    options.canvasId <= 0 ||
    !options.ownerId
  )
    throw new Error('An owned canvas is required for image import')
  if (Boolean(options.filePath) === Boolean(options.source))
    throw new Error('Provide exactly one file, upload ID, or resource ID')
  const name = options.name?.trim()
  if (name !== undefined && (!name || name.length > 200))
    throw new Error('Import name must be between 1 and 200 characters')
  const bytes = options.filePath
    ? await readFile(resolve(options.filePath))
    : undefined
  const sha256 = bytes
    ? createHash('sha256').update(bytes).digest('hex')
    : undefined
  const sourceIdentity = sha256
    ? `sha256:${sha256}`
    : options.source?.uploadId
      ? `upload:${options.source.uploadId}`
      : options.source?.resourceId
        ? `resource:${options.source.resourceId}`
        : undefined
  if (!sourceIdentity) throw new Error('Import source ID is required')
  const scope = {
    baseUrl: options.baseUrl.replace(/\/+$/, ''),
    ownerId: options.ownerId,
    canvasId: options.canvasId,
    sourceIdentity,
  }
  const key = createHash('sha256').update(JSON.stringify(scope)).digest('hex')
  const statePath = join(options.stateDir, 'canvas-imports', `${key}.json`)
  const readReceipt = async (): Promise<ImportReceipt | undefined> => {
    const value = await readState(statePath)
    if (value === undefined) return undefined
    if (
      !value ||
      typeof value !== 'object' ||
      !('schemaVersion' in value) ||
      value.schemaVersion !== 'assethub.canvas-import.v1' ||
      !('baseUrl' in value) ||
      value.baseUrl !== scope.baseUrl ||
      !('ownerId' in value) ||
      value.ownerId !== scope.ownerId ||
      !('canvasId' in value) ||
      value.canvasId !== scope.canvasId ||
      !('sourceIdentity' in value) ||
      value.sourceIdentity !== sourceIdentity
    )
      throw new Error(
        `Invalid or differently scoped import receipt: ${statePath}`,
      )
    const saved = value as ImportReceipt
    if (
      (saved.uploadId !== undefined &&
        (typeof saved.uploadId !== 'string' || !saved.uploadId)) ||
      (saved.resourceId !== undefined &&
        (typeof saved.resourceId !== 'string' || !saved.resourceId)) ||
      (sha256 !== undefined && saved.sha256 !== sha256)
    )
      throw new Error(`Invalid import source in receipt: ${statePath}`)
    if (name !== undefined && saved.name !== name)
      throw new Error(
        `This source has an import receipt with a different name. Reuse its original name: ${statePath}`,
      )
    return saved
  }
  let saved = await readReceipt()
  if (!saved?.uploadId && !saved?.resourceId) {
    await mkdir(dirname(statePath), {recursive: true, mode: 0o700})
    const lockPath = `${statePath}.upload-lock`
    const lock = await open(lockPath, 'wx', 0o600).catch(error => {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'EEXIST'
      )
        throw new Error(
          `An upload for this source is already in progress. Retry the same command after it finishes. If its process was terminated, verify the PID in ${lockPath} is stopped before removing that lock.`,
        )
      throw error
    })
    try {
      await lock.writeFile(JSON.stringify({pid: process.pid}))
      // Another process may have completed its upload between our initial read and lock acquisition.
      saved = await readReceipt()
      if (!saved?.uploadId && !saved?.resourceId) {
        saved ??= {
          schemaVersion: 'assethub.canvas-import.v1',
          ...scope,
          ...(sha256 ? {sha256} : {}),
          ...(name === undefined ? {} : {name}),
        }
        await writeState(statePath, saved)
        if (bytes && options.filePath) {
          const uploaded = await options.client.v2.uploadFile({
            file: new Blob([bytes], {
              type:
                options.contentType ??
                imageContentTypes[extname(options.filePath).toLowerCase()] ??
                'application/octet-stream',
            }),
            fileName: basename(options.filePath),
            mediaType: 'image',
          })
          if (!uploaded.uploadId)
            throw new Error('Server did not return a durable upload ID')
          saved.uploadId = uploaded.uploadId
        } else if (options.source?.uploadId)
          saved.uploadId = options.source.uploadId
        else if (options.source?.resourceId)
          saved.resourceId = options.source.resourceId
        // Never call durable import before its upload identity has been persisted.
        await writeState(statePath, saved)
      }
    } finally {
      await lock.close()
      await unlink(lockPath)
    }
  }
  const source: DurableSource = saved?.uploadId
    ? {uploadId: saved.uploadId}
    : saved?.resourceId
      ? {resourceId: saved.resourceId}
      : (() => {
          throw new Error('Import receipt has no durable source')
        })()
  // Revalidate on the server even after a successful cached result. Promotion
  // recognizes this same upload after staging cleanup and never creates a new asset.
  const result = await options.client.v2.importCanvasAsset(options.canvasId, {
    source,
    name: saved.name,
  })
  if (
    result.canvasId !== options.canvasId ||
    result.mediaType !== 'image' ||
    !result.assetId ||
    (saved.result && saved.result.assetId !== result.assetId)
  )
    throw new Error(
      `Server returned an inconsistent imported asset; inspect ${statePath}`,
    )
  await writeState(statePath, {...saved, result})
  return {
    ...result,
    statePath,
    ...(sha256 ? {sha256} : {}),
    ...(saved.uploadId ? {uploadId: saved.uploadId} : {}),
  }
}
