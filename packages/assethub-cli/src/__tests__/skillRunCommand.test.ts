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
let rejectedRun = false

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
      steps: [{stepId: 's', stage: 'image', attempt: 1, status: 'completed', artifactId: 'a', ...(rejectedRun ? {assetId: 'img_9'} : {})}],
      verdicts: [{stepId: 's', attempt: 1, pass: !rejectedRun, by: 'ai', reason: rejectedRun ? 'the hands are fused with the sleeve' : null}],
      outputs: rejectedRun ? [] : [{artifactId: 'a', stepId: 's', kind: 'image', assetId: 'img_9', verified: true}],
      outcome: runStatus === 'completed' ? {status: 'completed'} : null,
      parts: [],
    })
  if (path === `/api/v2/workspace-skills/figure-clay/runs/${runId}/stop` && runsDisabled)
    return send(404, {
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'No such endpoint. See https://app.assethub.io/api/v2/openapi.json for the available operations.',
      },
    })
  if (path === `/api/v2/workspace-skills/figure-clay/runs/${runId}/resume`)
    return send(202, {runId, skillId: 'figure-clay', status: 'running'})
  if (path === `/api/v2/workspace-skills/figure-clay/runs/${runId}/verdict`)
    return send(201, {
      runId,
      humanVerdict: {verdict: 'not_right', note: 'arms too thin', by: 'human:u'},
    })
  // A skill shared to staff: its definition lives in the owner's workspace.
  if (path === '/api/v2/workspace-skills/shared-pluffy' || path.startsWith('/api/v2/workspace-skills/shared-pluffy?'))
    return send(403, {success: false, error: {code: 'WORKSPACE_SKILL_FORBIDDEN', message: 'Workspace Skill access is denied'}})
  if (path === '/api/v2/workspace-skills/shares')
    return send(200, {items: [{shareId: 's-1', skillId: 'shared-pluffy', revision: 7, title: 'Pluffy Part Separation', workspace: 'Personal Space'}]})
  if (path === `/api/v2/workspace-skills/shared-pluffy/runs/${runId}`)
    return send(200, {
      runId,
      skillId: 'shared-pluffy',
      status: 'completed',
      budget: {credits: 150, spentCredits: 90, remainingCredits: 60},
      steps: [{stepId: 's', stage: 'image', attempt: 1, status: 'completed', artifactId: 'a'}],
      verdicts: [{stepId: 's', attempt: 1, pass: true, by: 'ai', reason: null}],
      outputs: [{artifactId: 'a', stepId: 's', kind: 'image', assetId: 'img_9', verified: true}],
      outcome: {status: 'completed'},
      parts: [],
    })
  // An official V8 goal skill not installed yet: the step-skill read is
  // forbidden, the list names it as a goal skill, and a start installs it.
  if (path === '/api/v2/workspace-skills/assethub-axe' || path.startsWith('/api/v2/workspace-skills/assethub-axe?'))
    return send(403, {success: false, error: {code: 'WORKSPACE_SKILL_FORBIDDEN', message: 'Workspace Skill access is denied'}})
  if (path === '/api/v2/workspace-skills' || path.startsWith('/api/v2/workspace-skills?'))
    return send(200, {
      items: [{skillId: 'assethub-axe', revision: 1, summary: 'Axe', schemaVersion: 'ag.memory-skill.v8', mode: 'manual', taskKind: null, official: true, staffOnly: true}],
      canEdit: false,
      nextCursor: null,
      showcase: [{skillId: 'assethub-showcase', revision: 3, title: 'Showcase clay', summary: 'Showcase clay'}],
    })
  if (path === '/api/v2/workspace-skills/foreign-skill' || path.startsWith('/api/v2/workspace-skills/foreign-skill?'))
    return send(403, {success: false, error: {code: 'WORKSPACE_SKILL_FORBIDDEN', message: 'Workspace Skill access is denied'}})
  if (path === '/api/v2/workspace-skills/shares/s-1/runs')
    return send(202, {runId, skillId: 'shared-pluffy', canvasId: 42, pin: {skillId: 'shared-pluffy', revision: 7, contentSha256: sha}, budget: {credits: 80}, status: 'running'})
  if (path === '/api/v2/workspace-skills/showcase/assethub-showcase/runs')
    return send(202, {runId, skillId: 'assethub-showcase', canvasId: 42, pin: {skillId: 'assethub-showcase', revision: 3, contentSha256: sha}, budget: {credits: 80}, status: 'running'})
  if (path === `/api/v2/workspace-skills/assethub-showcase/runs/${runId}`)
    return send(200, {
      runId,
      skillId: 'assethub-showcase',
      status: 'running',
      budget: {credits: 80, spentCredits: 0, remainingCredits: 80},
      steps: [],
      verdicts: [],
      outputs: [],
      outcome: null,
      parts: [],
    })
  if (path === '/api/v2/workspace-skills/assethub-axe/runs')
    return send(202, {runId, skillId: 'assethub-axe', canvasId: 42, kind: 'goal', pin: {skillId: 'assethub-axe', revision: 1, contentSha256: sha}, budget: {credits: 5000}, status: 'running'})
  if (path === `/api/v2/workspace-skills/assethub-axe/runs/${runId}`)
    return send(200, {
      runId,
      skillId: 'assethub-axe',
      kind: 'goal',
      status: 'running',
      budget: {credits: 5000, spentCredits: 0, remainingCredits: 5000},
      steps: [],
      verdicts: [],
      outputs: [],
      outcome: null,
      parts: [],
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

const cli = async (args: string[], cwd: string, extraEnv: Record<string, string> = {}) =>
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
          ...extraEnv,
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

it('runs without a spending limit and leaves the limit to the server', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skills-run-'))
  seen.length = 0
  runStatus = 'completed'
  const result = await cli(
    ['run', 'figure-clay', '--image-asset', 'img_1', '--canvas', '42', '--operation-id', operationId],
    dir,
  )
  expect(result.code).toBe(0)
  const start = seen.find(r => r.method === 'POST' && r.path.endsWith('/runs'))!
  expect(start.body).not.toHaveProperty('budgetCredits')
})

it('runs a goal skill with no spending limit to set, and continues it without --add-credits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skills-run-'))
  seen.length = 0
  runStatus = 'completed'
  const result = await cli(
    ['run', 'figure-clay', '--goal', '--image-asset', 'img_1', '--canvas', '42', '--operation-id', operationId],
    dir,
  )
  expect(result.code).toBe(0)
  expect(result.stderr).toContain('Running "figure-clay" on canvas 42.')
  expect(result.stderr).not.toContain('limit')
  const start = seen.find(r => r.method === 'POST' && r.path.endsWith('/runs'))!
  expect(start.body).not.toHaveProperty('budgetCredits')
  seen.length = 0
  await cli(['run-resume', 'figure-clay', runId, '--operation-id', operationId], dir)
  expect(seen.find(r => r.path.endsWith('/resume'))!.body).toEqual({clientOperationId: operationId})
})

it('starts an official V8 goal skill whose step-skill read is forbidden, without --goal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skills-run-'))
  seen.length = 0
  const result = await cli(
    ['run', 'assethub-axe', '--image-asset', 'img_1', '--canvas', '42', '--operation-id', operationId],
    dir,
  )
  expect(result.code).toBe(0)
  expect(seen.some(r => r.method === 'POST' && r.path === '/api/v2/workspace-skills/assethub-axe/runs')).toBe(true)
})

it('runs a skill shared to staff through its share, named by skill id or share id', async () => {
  for (const name of ['shared-pluffy', 's-1']) {
    const dir = await mkdtemp(join(tmpdir(), 'skills-run-'))
    seen.length = 0
    const result = await cli(
      ['run', name, '--image-asset', 'img_1', '--canvas', '42', '--operation-id', operationId],
      dir,
    )
    expect(result.code).toBe(0)
    const start = seen.find(r => r.method === 'POST' && r.path.endsWith('/runs'))!
    expect(start.path).toBe('/api/v2/workspace-skills/shares/s-1/runs')
    expect(start.body).toMatchObject({expectedRevision: 7, clientOperationId: operationId})
    expect(result.stderr).toContain('Running "Pluffy Part Separation" (revision 7)')
  }
})

it('installs and runs a showcase skill at its listed revision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skills-run-'))
  seen.length = 0
  const result = await cli(
    ['run', 'assethub-showcase', '--image-asset', 'img_1', '--canvas', '42', '--operation-id', operationId],
    dir,
  )
  expect(result.code).toBe(0)
  const start = seen.find(r => r.method === 'POST' && r.path.endsWith('/runs'))!
  expect(start.path).toBe('/api/v2/workspace-skills/showcase/assethub-showcase/runs')
  expect(start.body).toMatchObject({revision: 3})
  expect(start.body).not.toHaveProperty('expectedRevision')
})

it('keeps the 403 for a forbidden skill that is not in the runnable list', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skills-run-'))
  seen.length = 0
  const result = await cli(
    ['run', 'foreign-skill', '--image-asset', 'img_1', '--canvas', '42', '--operation-id', operationId],
    dir,
  )
  expect(result.code).toBe(2)
  expect(result.json.error.code).toBe('WORKSPACE_SKILL_FORBIDDEN')
  expect(seen.some(r => r.method === 'POST' && r.path.endsWith('/runs'))).toBe(false)
})

it('reads an official V8 skill that is not installed yet from the runnable list', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skills-get-'))
  const result = await cli(['get', 'assethub-axe'], dir)
  expect(result.code).toBe(0)
  expect(result.json).toMatchObject({
    skillId: 'assethub-axe',
    summary: 'Axe',
    source: 'workspace',
    goal: true,
    official: true,
    staffOnly: true,
    fullMethod: false,
  })
})

it('reads a skill shared to staff from the runnable list', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skills-get-'))
  const result = await cli(['get', 'shared-pluffy'], dir)
  expect(result.code).toBe(0)
  expect(result.json).toMatchObject({
    skillId: 'shared-pluffy',
    source: 'staff-share',
    shareId: 's-1',
    fullMethod: false,
  })
})

it('keeps the 403 on skills get for a forbidden skill that is not in the runnable list', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skills-get-'))
  const result = await cli(['get', 'foreign-skill'], dir)
  expect(result.code).toBe(2)
  expect(result.json.error.code).toBe('WORKSPACE_SKILL_FORBIDDEN')
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

it('says a run command is not yet available when the server hides the route from this key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skills-run-'))
  runsDisabled = true
  try {
    const result = await cli(['run-stop', 'figure-clay', runId], dir)
    expect(result.code).toBe(2)
    expect(result.json.error).toMatchObject({
      code: 'NOT_FOUND',
      message: 'This feature is not yet available for this account.',
    })
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

it('finds a run again from a new session: run-list, then run-status saves into the original folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skills-run-'))
  seen.length = 0
  runStatus = 'running'
  const started = await cli(
    ['run', 'figure-clay', '--image-asset', 'img_1', '--canvas', '42', '--budget', '80', '--out-dir', dir],
    dir,
  )
  expect(started.code).toBe(0)

  // A new session knows nothing but the folder it is in.
  const listed = await cli(['run-list'], dir)
  expect(listed.code).toBe(0)
  const items = listed.json.items as Array<Record<string, unknown>>
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({
    skillId: 'figure-clay',
    skillTitle: 'Figure → clay',
    runId,
    status: 'running',
    outDir: dir,
  })
  expect(String(items[0].next)).toContain(`run-status figure-clay ${runId}`)

  runStatus = 'completed'
  const finished = await cli(['run-status', 'figure-clay', runId], dir)
  expect(finished.code).toBe(0)
  expect(finished.json.saved).toEqual([{assetId: 'img_9', path: join(dir, 'result.figure-clay.png')}])

  const elsewhere = await mkdtemp(join(tmpdir(), 'skills-run-'))
  const env = {ASSETHUB_CLI_STATE_DIR: join(dir, 'state')}
  const fromOtherFolder = await cli(['run-list'], elsewhere, env)
  expect(fromOtherFolder.json.items).toEqual([])
  const all = await cli(['run-list', '--all'], elsewhere, env)
  expect((all.json.items as unknown[]).length).toBe(1)
})

it('saves the parts that passed when another part failed the run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skills-run-'))
  runStatus = 'failed'
  try {
    const result = await cli(['run-status', 'figure-clay', runId, '--out-dir', dir], dir)
    expect(result.code).toBe(1)
    expect(result.json.saved).toEqual([{assetId: 'img_9', path: join(dir, 'result.figure-clay.png')}])
    expect(await readFile(join(dir, 'result.figure-clay.png'))).toEqual(png)
  } finally {
    runStatus = 'completed'
  }
})

it('saves the rejected try and points the assistant at fixing it here when the AI check said no', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skills-run-'))
  runStatus = 'failed'
  rejectedRun = true
  try {
    const result = await cli(['run-status', 'figure-clay', runId, '--attempts', '--out-dir', dir], dir)
    expect(result.code).toBe(1)
    expect(result.json.rejected).toEqual({attempt: 1, reason: 'the hands are fused with the sleeve'})
    expect(result.json.attempts).toEqual([
      {
        assetId: 'img_9',
        attempt: 1,
        check: 'rejected',
        reason: 'the hands are fused with the sleeve',
        path: join(dir, 'result.figure-clay.try1-rejected.png'),
      },
    ])
    expect(result.json.next).toContain('When the AI check says no')
    expect(await readFile(join(dir, 'result.figure-clay.try1-rejected.png'))).toEqual(png)
  } finally {
    rejectedRun = false
    runStatus = 'completed'
  }
})

it('saves a staff-shared run although the skill itself belongs to another workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skills-run-'))
  const result = await cli(['run-status', 'shared-pluffy', runId, '--out-dir', dir], dir)
  expect(result.code).toBe(0)
  expect(result.json.saved).toEqual([{assetId: 'img_9', path: join(dir, 'result.pluffy-part-separation.png')}])
  expect(await readFile(join(dir, 'result.pluffy-part-separation.png'))).toEqual(png)
})
