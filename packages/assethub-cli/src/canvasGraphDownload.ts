import {createHash, randomUUID} from 'node:crypto'
import {createWriteStream} from 'node:fs'
import {mkdir, rename, unlink} from 'node:fs/promises'
import {dirname, join, resolve} from 'node:path'
import {Readable, Transform} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import type {ReadableStream} from 'node:stream/web'

/** Refuse anything past this — an artifact-graph zip is capped server-side at
 *  400 MiB of retained blobs, so a larger body is not the file we asked for. */
const MAX_ZIP_BYTES = 1024 * 1024 * 1024

/** The only error messages that leave this module verbatim. A network error
 *  can carry the signed URL, so anything else collapses to a fixed string. */
const SAFE_MESSAGES = new Set([
  'Invalid download URL',
  'Empty file response',
  'File exceeds 1 GiB',
])

export type DownloadedCanvasGraphZip = {
  path: string
  bytes: number
  sha256: string
}

/**
 * Stream one signed artifact-graph zip to disk.
 *
 * The signed URL is used WITHOUT API credentials — it authenticates itself —
 * and follows redirects, because the storage signer may answer with one. Bytes
 * go through a sha256/byte meter into a temp file beside the destination and
 * are renamed into place only once the body ended cleanly, so a half-written
 * zip never sits under the final name. Errors are bounded to a fixed set of
 * messages so a signed URL never lands in the CLI's JSON output.
 */
export const downloadCanvasGraphZip = async ({
  url,
  destinationPath,
  timeoutMs = 120_000,
}: {
  url: string
  destinationPath: string
  timeoutMs?: number
}): Promise<DownloadedCanvasGraphZip> => {
  const destination = resolve(destinationPath)
  const directory = dirname(destination)
  await mkdir(directory, {recursive: true, mode: 0o700})
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  try {
    const parsed = new URL(url)
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      throw new Error('Invalid download URL')
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    if (!response.body) throw new Error('Empty file response')
    const hash = createHash('sha256')
    let bytes = 0
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length
        if (bytes > MAX_ZIP_BYTES) return callback(new Error('File exceeds 1 GiB'))
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    await pipeline(
      Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
      meter,
      createWriteStream(temporary, {flags: 'wx', mode: 0o600}),
    )
    if (bytes === 0) throw new Error('Empty file response')
    await rename(temporary, destination)
    return {path: destination, bytes, sha256: hash.digest('hex')}
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    throw new Error(
      SAFE_MESSAGES.has(message) || /^HTTP \d{3}$/.test(message)
        ? message
        : 'File download failed',
    )
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}
