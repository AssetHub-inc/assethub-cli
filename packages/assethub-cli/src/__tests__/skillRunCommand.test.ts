import {spawn} from 'node:child_process'
import {mkdtemp, readFile, readdir, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {afterAll, beforeAll, expect, it} from 'vitest'

const runId = '33333333-3333-4333-8333-333333333333'
const operationId = '44444444-4444-4444-8444-444444444444'
const sha = 'a'.repeat(64)
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

type Seen = {method: string; path: string; key?: string; body: unknown}
const seen: Seen[] = []
let runStatus = 'completed'
let baseUrl = ''
let runsDisabled = false

const server = createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const path = req.url!
  seen.push({
    method: req.method!,
    path,
    key: req.headers['idempotency-key'] as string | undefined,
    body: raw ? JSON.parse(raw) : null,
  })
  const send = (status: number, data: unknown) => {
    res.writeHead(status, {'content-type': 'application/json'})
    res.end(JSON.stringify(status < 400 ? {success: true, data} : data))
  }
  if (path === '/files/img_9.png') {
    res.writeHead(200, {'content-type': 'image/png'})
    res.end(png)
    return
  }
  if (path === '/api/v2/capabilities')
    return send(200, {
      ownerId: 'org-1',
      executionContext: {status: 'available', operations: []},
      evaluators: [],
    })
  if (path === '/api/v2/canvases/42')
    return send(200, {id: 42, name: 'c', ownerId: 'org-1', url: 'https://x/42'})
  if (path.startsWith('/api/v2/workspace-skills/figure-clay?') || path === '/api/v2/workspace-skills/figure-clay')
    return send(200, {
      skill: {skillId: 'figure-clay', revision: 5, contentSha256: sha, title: 'Figure → clay'},
    })
  if (path === '/api/v2/workspace-skills/figure-clay/runs') {
    if (runsDisabled)
      return send(404, {success: false, error: {code: 'NOT_FOUND', message: 'Unknown endpoint'}})
    return send(202, {
      runId,
      skillId: 'figure-clay',
      canvasId: 42,
      pin: {skillId: 'figure-clay', revision: 5, contentSha256: sha},
      budget: {credits: 80},
      status: 'running',
    })
  }
  if (path === `/api/v2/workspace-skills/figure-clay/runs/${runId}`)
    return send(200, {
      runId,
      skillId: 'figure-clay',
      status: runStatus,
      budget: {credits: 80, spentCredits: 40, remainingCredits: 40},
      steps: [{stepId: 's', stage: 'image', attempt: 1, status: 'completed', artifactId: 'a'}],
      verdicts: [{stepId: 's', attempt: 1, pass: true, by: 'ai', reason: null}],
      outputs: [{artifactId: 'a', stepId: 's', kind: 'image', assetId: 'img_9', verified: true}],
      outcome: runStatus === 'completed' ? {status: 'completed'} : null,
      parts: [],
    })
  if (path === `/api/v2/workspace-skills/figure-clay/runs/${runId}/resume`)
    return send(202, {runId, skillId: 'figure-clay', status: 'running'})
  if (path === `/api/v2/workspace-skills/figure-clay/runs/${runId}/verdict`)
    return send(201, {
      runId,
      humanVerdict: {verdict: 'not_right', note: 'arms too thin', by: 'human:u'},
    })
  if (path === '/api/v2/assets/img_9')
    return send(200, {assetId: 'img_9', url: `${baseUrl}/files/img_9.png`, expiresAt: 'x'})
  send(404, {success: false, error: {code: 'NOT_FOUND', message: path}})
})

beforeAll(async () => {
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No address')
  baseUrl = `http://127.0.0.1:${address.port}`
})
afterAll(() => server.close())

/** The one JSON object the CLI prints: a run view, or an error. */
type CliJson = {
  error?: {code: string; message: string; status: number}
  next?: string
  status?: string
  saved?: {assetId: string; path: string}[]
  [field: string]: unknown
}

const cli = async (args: string[], cwd: string) =>
  new Promise<{code: number | null; json: CliJson; stderr: string}>(
    (done, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../../dist/index.js', import.meta.url)), 'skills', ...args], {
        cwd,
        env: {
          ...process.env,
          ASSETHUB_API_KEY: 'test-key',
          ASSETHUB_ACCESS_TOKEN: '',
          ASSETHUB_API_BASE_URL: baseUrl,
          ASSETHUB_CLI_CONFIG: join(cwd, 'config.json'),
          ASSETHUB_CLI_STATE_DIR: join(cwd, 'state'),
          ASSETHUB_NO_AUTO_UPDATE: '1',
        },
      })
      let out = '',
        err = ''
      child.stdout.on('data', chunk => (out += chunk))
      child.stderr.on('data', chunk => (err += chunk))
      child.once('error', reject)
      child.once('close', code =>
        done({code, json: out ? JSON.parse(out) : null, stderr: err}),
      )
      child.stdin.end()
    },
  )

it('runs a skill pinned to the version read, waits, and saves the result next to nothing it overwrites', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skills-run-'))
  await writeFile(join(dir, 'cat.png'), 'original')
  seen.length = 0
  runStatus = 'completed'
  const result = await cli(
    [
      'run', 'figure-clay',
      '--image-asset', 'img_1',
      '--canvas', '42',
      '--budget', '80',
      '--ask', 'keep the scarf',
      '--operation-id', operationId,
      '--wait',
      '--out-dir', dir,
    ],
    dir,
  )
  expect(result.stderr).toContain('Running "Figure → clay" (revision 5) with a limit of 80 credits')
  expect(result.stderr).toContain('Try 1: Making the image - done.')
  expect(result.stderr).toContain('AI check (try 1): looks right.')
  expect(result.code).toBe(0)
  const start = seen.find(r => r.method === 'POST' && r.path.endsWith('/runs'))!
  expect(start.key).toBe(operationId)
  expect(start.body).toEqual({
    clientOperationId: operationId,
    canvasId: 42,
    sourceImageAssetId: 'img_1',
    budgetCredits: 80,
    ask: 'keep the scarf',
    expectedRevision: 5,
    expectedContentSha256: sha,
    executionContext: {canvasId: 42, clientOperationId: operationId, source: 'cli'},
  })
  expect(result.json).toMatchObject({
    operationId,
    status: 'completed',
    saved: [{assetId: 'img_9', path: join(dir, 'result.figure-clay.png')}],
  })
  expect(result.json.next).toContain('run-verdict figure-clay')
  expect(await readFile(join(dir, 'cat.png'), 'utf8')).toBe('original')
  expect(await readFile(join(dir, 'result.figure-clay.png'))).toEqual(png)
})

it('refuses to run without a spending limit, before any request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skills-run-'))
  seen.length = 0
  const result = await cli(['run', 'figure-clay', '--image-asset', 'img_1', '--canvas', '42'], dir)
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain('--budget')
  expect(seen).toEqual([])
})

it('says plainly when this account cannot run skills', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skills-run-'))
  runsDisabled = true
  try {
    const result = await cli(
      ['run', 'figure-clay', '--image-asset', 'img_1', '--canvas', '42', '--budget', '10'],
      dir,
    )
    expect(result.code).toBe(2)
    expect(result.json.error.message).toBe('Running skills is not available on this account yet.')
  } finally {
    runsDisabled = false
  }
})

it('resumes the same run with more credits and points a paused run back at resume', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skills-run-'))
  seen.length = 0
  runStatus = 'budget_exhausted'
  const result = await cli(
    ['run-resume', 'figure-clay', runId, '--add-credits', '30', '--operation-id', operationId],
    dir,
  )
  expect(result.code).toBe(0)
  const resume = seen.find(r => r.path.endsWith('/resume'))!
  expect(resume.key).toBe(operationId)
  expect(resume.body).toEqual({clientOperationId: operationId, addCredits: 30})
  expect(result.json.next).toContain(`run-resume figure-clay ${runId}`)
  expect(await readdir(dir)).not.toContain('result.figure-clay.png')
})

it('records Needs changes as not_right with the note', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skills-run-'))
  seen.length = 0
  const result = await cli(
    ['run-verdict', 'figure-clay', runId, '--verdict', 'not-right', '--note', 'arms too thin'],
    dir,
  )
  expect(result.code).toBe(0)
  expect(seen.at(-1)!.body).toEqual({verdict: 'not_right', note: 'arms too thin'})
})
