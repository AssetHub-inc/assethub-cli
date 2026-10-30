import {createHash} from 'node:crypto'
import {readFile, realpath, stat} from 'node:fs/promises'
import {dirname, extname, join, sep} from 'node:path'
import {writePrivateFileAtomic} from '../hooks/paths.js'
import type {meshReviewCall} from './syncMeshReview.js'

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

/** Never open a path from findings unless it is inside the caller's explicit review inputs. */
export async function findVisualSource(doc: unknown, roots: string[], explicit: string[]) {
  if (!record(doc) || !record(doc.config) || !record(doc.config.conceptReview) || !record(doc.config.conceptReview.source)) return null
  const source = doc.config.conceptReview.source
  if (source.referenceKind !== 'concept' || typeof source.referenceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.referenceSha256)) return null
  const execution = doc.config.reviewExecution
  const recorded = record(execution) && Array.isArray(execution.conceptReferenceSources) ? execution.conceptReferenceSources : []
  const candidates = [...explicit, ...recorded.flatMap(item => record(item) && item.sha256 === source.referenceSha256 && typeof item.path === 'string' ? [item.path] : [])]
  const allowed = await Promise.all([...roots, ...explicit].map(path => realpath(path).catch(() => null)))
  for (const candidate of candidates) {
    const path = await realpath(candidate).catch(() => null)
    if (!path || !allowed.some(root => root && inside(path, root))) continue
    const contentType = ({'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp'} as Record<string, string>)[extname(path).toLowerCase()]
    if (!contentType) continue
    const info = await stat(path).catch(() => null)
    if (!info?.isFile() || info.size < 1 || info.size > 10 * 1024 * 1024) continue
    const bytes = await readFile(path)
    if (sha256(bytes) === source.referenceSha256) return {bytes, sha256: source.referenceSha256, contentType}
  }
  return null
}

/** Persist the exact quote before dispatch; an uncertain response reuses the same run and limits. */
export async function startAutomaticVisual(input: {
  base: string; runId: string; headers: Record<string, string>; fetchImpl: typeof fetch;
  findingsPath: string; doc: unknown; roots: string[]; explicit: string[];
  credentialScope: string; call: typeof meshReviewCall;
  onQuote: (credits: number) => void
}): Promise<'started' | 'no_source' | 'unavailable'> {
  const source = await findVisualSource(input.doc, input.roots, input.explicit)
  if (!source) return 'no_source'
  const url = `${input.base}/runs/${encodeURIComponent(input.runId)}/visual`
  const receiptPath = join(dirname(input.findingsPath), 'mesh-review-visual.json')
  try {
    const saved: unknown = await readFile(receiptPath, 'utf8').then(JSON.parse, error => {if (error?.code === 'ENOENT') return null; throw error})
    const validAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100_000
    if (saved !== null && (!record(saved) || saved.runId !== input.runId || saved.base !== input.base || saved.credentialScope !== input.credentialScope || saved.sha256 !== source.sha256 || saved.contentType !== source.contentType || !validAmount(saved.visualMaxCredits) || !validAmount(saved.briefMaxCredits))) throw new Error('Saved visual request does not match this review')
    const savedQuote = record(saved) ? {visualMaxCredits: saved.visualMaxCredits, briefMaxCredits: saved.briefMaxCredits} : undefined
    const prepared = (await input.call(input.fetchImpl, url, {method: 'POST', headers: input.headers, body: JSON.stringify({action: 'prepare', sha256: source.sha256, contentType: source.contentType, ...(savedQuote ? {savedQuote} : {})})})).data
    if (!record(prepared) || typeof prepared.signedUrl !== 'string' || !validAmount(prepared.visualMaxCredits) || !validAmount(prepared.briefMaxCredits)) throw new Error('Invalid visual quote')
    const visualMaxCredits = record(saved) ? saved.visualMaxCredits as number : prepared.visualMaxCredits
    const briefMaxCredits = record(saved) ? saved.briefMaxCredits as number : prepared.briefMaxCredits
    await writePrivateFileAtomic(receiptPath, JSON.stringify({runId: input.runId, base: input.base, credentialScope: input.credentialScope, sha256: source.sha256, contentType: source.contentType, visualMaxCredits, briefMaxCredits}, null, 2))
    input.onQuote(visualMaxCredits + briefMaxCredits)
    const form = new FormData()
    form.append('cacheControl', '3600')
    form.append('', new Blob([new Uint8Array(source.bytes)], {type: source.contentType}))
    await input.fetchImpl(prepared.signedUrl, {method: 'PUT', body: form}).catch(() => undefined)
    await input.call(input.fetchImpl, url, {method: 'POST', headers: input.headers, body: JSON.stringify({action: 'start', sha256: source.sha256, contentType: source.contentType, visualMaxCredits, briefMaxCredits})})
    return 'started'
  } catch {
    return 'unavailable'
  }
}
