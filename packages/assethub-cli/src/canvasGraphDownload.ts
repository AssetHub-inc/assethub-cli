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
  'Too many redirects',
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
 * and follows up to five redirects, because the storage signer may answer with
 * one; each hop is checked (no HTTPS-to-HTTP, no public-to-private host). Bytes
 * go through a sha256/byte meter into a temp file beside the destination and
 * are renamed into place only once the body ended cleanly, so a half-written
 * zip never sits under the final name. Errors are bounded to a fixed set of
 * messages so a signed URL never lands in the CLI's JSON output.
 */
const MAX_REDIRECTS = 5

const isPrivateHost = (hostname: string): boolean => {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0') return true
  if (/^(fc|fd|fe8|fe9|fea|feb)/.test(host) && host.includes(':')) return true
  const octets = host.split('.').map(Number)
  if (octets.length !== 4 || octets.some(n => !Number.isInteger(n))) return false
  const [a, b] = octets
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

const checkedUrl = (value: string, from?: URL): URL => {
  const parsed = new URL(value)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Error('Invalid download URL')
  // A redirect may not downgrade to plain HTTP or move from a public host into
  // a private network or this machine.
  if (from?.protocol === 'https:' && parsed.protocol !== 'https:') throw new Error('Invalid download URL')
  if (from && !isPrivateHost(from.hostname) && isPrivateHost(parsed.hostname)) throw new Error('Invalid download URL')
  return parsed
}

/** The storage signer may answer with a redirect; every hop is checked before it is followed. */
const fetchFollowingSafeRedirects = async (url: string, signal: AbortSignal): Promise<Response> => {
  let current = checkedUrl(url)
  for (let hop = 0; ; hop++) {
    const response = await fetch(current.toString(), {signal, redirect: 'manual'})
    const location = response.headers.get('location')
    if (response.status < 300 || response.status >= 400 || !location) return response
    if (hop >= MAX_REDIRECTS) throw new Error('Too many redirects')
    await response.body?.cancel()
    current = checkedUrl(new URL(location, current).toString(), current)
  }
}

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
    const response = await fetchFollowingSafeRedirects(url, AbortSignal.timeout(timeoutMs))
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
