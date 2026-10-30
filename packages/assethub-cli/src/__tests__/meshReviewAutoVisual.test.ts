import {createHash} from 'node:crypto'
import {mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, expect, it, vi} from 'vitest'
import {findVisualSource, startAutomaticVisual} from '../meshReview/autoVisual.js'
import type {meshReviewCall} from '../meshReview/syncMeshReview.js'

const dirs: string[] = []
afterEach(async () => {for (const dir of dirs.splice(0)) await rm(dir, {recursive: true, force: true})})
const setup = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mesh-auto-test-'))
  dirs.push(dir)
  const file = join(dir, 'concept.png')
  const bytes = Buffer.from('immutable source')
  await writeFile(file, bytes)
  const hash = createHash('sha256').update(bytes).digest('hex')
  const doc = {config: {conceptReview: {source: {referenceKind: 'concept', referenceSha256: hash}}, reviewExecution: {conceptReferenceSources: [{path: file, sha256: hash}]}}}
  return {dir, file, hash, doc}
}

// @testdoc Only the exact original referenced by the review and within the caller's inputs may be uploaded.
it('finds a source only inside authorized review inputs with the recorded hash', async () => {
  const {dir, file, doc} = await setup()
  expect((await findVisualSource(doc, [dir], []))?.sha256).toBe(doc.config.conceptReview.source.referenceSha256)
  expect(await findVisualSource(doc, [], [])).toBeNull()
  await writeFile(file, 'changed')
  expect(await findVisualSource(doc, [dir], [])).toBeNull()
  const outside = await setup()
  const link = join(dir, 'external.png')
  await symlink(outside.file, link)
  expect(await findVisualSource(outside.doc, [dir], [])).toBeNull()
})

// @testdoc An uncertain paid start reuses the saved run, source and accepted ceilings even if the live quote changes.
it('persists the quote before dispatch and reuses it after an uncertain response', async () => {
  const {dir, doc} = await setup()
  let quote = 63
  const starts: unknown[] = []
  const call = vi.fn(async (_fetch: typeof fetch, _url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {action: string}
    if (body.action === 'prepare') return {data: {signedUrl: 'https://storage.test/source', visualMaxCredits: quote, briefMaxCredits: 2}}
    starts.push(body)
    if (starts.length === 1) throw new Error('response lost')
    return {data: {}}
  }) as unknown as typeof meshReviewCall
  const fetchImpl = vi.fn(async () => new Response('', {status: 200})) as unknown as typeof fetch
  const input = {base: 'https://example.test/api/v2/production/mesh-reviews', runId: 'run', headers: {}, fetchImpl, findingsPath: join(dir, 'findings.json'), doc, roots: [dir], explicit: [], credentialScope: 'key:hash', call, onQuote: vi.fn()}
  expect(await startAutomaticVisual(input)).toBe('unavailable')
  const receipt = JSON.parse(await readFile(join(dir, 'mesh-review-visual.json'), 'utf8'))
  expect(receipt).toMatchObject({runId: 'run', visualMaxCredits: 63, briefMaxCredits: 2})
  quote = 99
  expect(await startAutomaticVisual(input)).toBe('started')
  expect(starts[1]).toEqual(starts[0])
})
