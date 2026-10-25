import {mkdir, mkdtemp, readFile, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {prepareMeshReviewSession} from '../meshReview/session.js'
import {syncMeshReview} from '../meshReview/syncMeshReview.js'
import {runMeshReviewCommand} from '../meshReview/command.js'

afterEach(() => vi.unstubAllEnvs())

const auth = {baseUrl: 'https://example.test', apiKey: 'private-key'}
const args = {
  mode: 'run' as const,
  inputs: ['/mesh.glb'],
  project: 'project',
  assetKey: 'mesh',
  out: '/review',
  baseline: undefined,
  config: undefined,
  engineDir: undefined,
  reference: undefined,
  noConcept: 'No approved concept is available.',
  skipHp: false,
  noRender: false,
  noSync: false,
  dryRun: false,
}
const result = {
  runId: 'run',
  status: 'needs_fix',
  summary: {error: 1, warn: 0, info: 0},
  baselineRunId: null,
  unchanged: false,
  rendersUploaded: 1,
}

describe('CLI review lifecycle', () => {
  it('registers and prints the report link before the engine, then completes the same run', async () => {
    const events: string[] = []
    const fail = vi.fn()
    const sync = vi.fn(async () => {events.push('sync'); return result})
    const outcome = await runMeshReviewCommand(args, {
      auth,
      findEngineCli: async () => '/engine/cli.py',
      prepareSession: async () => {
        events.push('registered')
        return {
          out: '/review',
          runId: 'run',
          clientRunKey: 'a'.repeat(64),
          status: 'running',
          markEngineCompleted: async () => {events.push('engine-completed')},
          fail,
        }
      },
      runEngine: async () => {
        events.push('engine')
        return {exitCode: 1, findingsPath: '/review/findings.json'}
      },
      sync,
      log: line => events.push(line),
    })
    expect(events[0]).toBe('registered')
    expect(events[1]).toContain('/control/mesh-reviews/run')
    expect(events.indexOf('engine')).toBeGreaterThan(
      events.findIndex(line => line.includes('/control/mesh-reviews/run')),
    )
    expect(events.indexOf('engine-completed')).toBeGreaterThan(events.indexOf('engine'))
    expect(events.indexOf('sync')).toBeGreaterThan(events.indexOf('engine-completed'))
    expect(sync).toHaveBeenCalledWith(
      expect.objectContaining({clientRunKey: 'a'.repeat(64)}),
    )
    expect(outcome.result).toMatchObject({runId: 'run', status: 'needs_fix'})
    expect(fail).not.toHaveBeenCalled()
  })

  it('records an engine failure and returns its existing report link without syncing findings', async () => {
    const fail = vi.fn(async () => {})
    const sync = vi.fn()
    const outcome = await runMeshReviewCommand(args, {
      auth,
      findEngineCli: async () => '/engine/cli.py',
      prepareSession: async () => ({
        out: '/review',
        runId: 'run',
        clientRunKey: 'a'.repeat(64),
        status: 'running',
        fail,
      }),
      runEngine: async () => ({
        exitCode: 2,
        findingsPath: '/review/findings.json',
      }),
      sync,
      log: () => {},
    })
    expect(fail).toHaveBeenCalledOnce()
    expect(sync).not.toHaveBeenCalled()
    expect(outcome.result).toMatchObject({
      runId: 'run',
      status: 'failed',
      reportUrl: 'https://example.test/control/mesh-reviews/run',
    })
  })

  it('persists a key before an uncertain create, resumes it, and rejects changed source bytes', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'mesh-review-session-test-'))
    const mesh = join(folder, 'mesh.glb')
    const out = join(folder, 'output')
    const engineDir = join(folder, 'engine')
    await mkdir(engineDir)
    const cliPath = join(engineDir, 'cli.py')
    await writeFile(cliPath, 'engine')
    await writeFile(mesh, 'immutable-mesh')
    const requests: string[] = []
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {clientRunKey: string}
        requests.push(body.clientRunKey)
        if (requests.length === 1) throw new Error('uncertain network response')
        return new Response(
          JSON.stringify({
            success: true,
            data: {runId: 'run', status: 'running'},
          }),
          {status: 200},
        )
      },
    )
    const input = {
      args: {...args, inputs: [mesh], out},
      auth,
      cliPath,
      fetchImpl,
    }
    await expect(prepareMeshReviewSession(input)).rejects.toThrow(/network/)
    const session = await prepareMeshReviewSession(input)
    expect(session.runId).toBe('run')
    await session.release?.()
    expect(requests[0]).toBe(requests[1])
    const state = await readFile(join(out, 'mesh-review-session.json'), 'utf8')
    expect(state).not.toContain('private-key')
    await writeFile(mesh, 'changed-mesh')
    await expect(prepareMeshReviewSession(input)).rejects.toThrow(
      /changed|different/,
    )
    expect(requests).toHaveLength(2)
  })
})

it('resumes existing findings instead of running a second engine', async () => {
  const runEngine = vi.fn()
  const release = vi.fn(async () => {})
  const sync = vi.fn(async () => result)
  const out = await runMeshReviewCommand(args, {
    auth,
    findEngineCli: async () => '/engine/cli.py',
    prepareSession: async () => ({
      out: '/review',
      runId: 'run',
      clientRunKey: 'a'.repeat(64),
      status: 'running',
      findingsPath: '/review/findings.json',
      fail: vi.fn(),
      release,
    }),
    runEngine,
    sync,
    log: () => {},
  })
  expect(runEngine).not.toHaveBeenCalled()
  expect(sync).toHaveBeenCalledOnce()
  expect(release).toHaveBeenCalledOnce()
  expect(out.result).toMatchObject({resumed: true, runId: 'run'})
})

it('records a thrown engine error and releases its exclusive session', async () => {
  const fail = vi.fn(async () => {})
  const release = vi.fn(async () => {})
  await expect(
    runMeshReviewCommand(args, {
      auth,
      findEngineCli: async () => '/engine/cli.py',
      prepareSession: async () => ({
        out: '/review',
        runId: 'run',
        clientRunKey: 'a'.repeat(64),
        status: 'running',
        fail,
        release,
      }),
      runEngine: async () => {
        throw new Error('engine crashed')
      },
      sync: vi.fn(),
      log: () => {},
    }),
  ).rejects.toThrow('engine crashed')
  expect(fail).toHaveBeenCalledOnce()
  expect(release).toHaveBeenCalledOnce()
})

it('does not start analysis after the local command was interrupted', async () => {
  const signal = AbortSignal.abort()
  const fail = vi.fn(async () => {})
  const runEngine = vi.fn()
  const outcome = await runMeshReviewCommand(args, {
    auth,
    signal,
    findEngineCli: async () => '/engine/cli.py',
    prepareSession: async () => ({
      out: '/review',
      runId: 'run',
      clientRunKey: 'a'.repeat(64),
      status: 'running',
      fail,
    }),
    runEngine,
    sync: vi.fn(),
    log: () => {},
  })
  expect(runEngine).not.toHaveBeenCalled()
  expect(fail).toHaveBeenCalledOnce()
  expect(outcome.exitCode).toBe(130)
  expect(outcome.result.hint).toContain('Local analysis was interrupted')
})

const sessionFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'mesh-review-identity-'))
  const engine = join(root, 'engine')
  await mkdir(engine)
  const cliPath = join(engine, 'cli.py')
  await writeFile(cliPath, 'engine')
  const mesh = join(root, 'mesh.glb')
  await writeFile(mesh, 'mesh')
  const fetchImpl = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: {runId: 'run', status: 'running'},
        }),
      ),
  )
  return {
    root,
    mesh,
    cliPath,
    fetchImpl,
    args: {...args, inputs: [mesh], out: join(root, 'review')},
  }
}

it('pins ordered reference roles and rejects another credential scope', async () => {
  const f = await sessionFixture()
  const front = join(f.root, 'front.png'),
    side = join(f.root, 'side.png')
  await writeFile(front, 'front')
  await writeFile(side, 'side')
  const first = await prepareMeshReviewSession({
    ...f,
    args: {...f.args, reference: `${front},${side}`, noConcept: undefined},
    auth,
  })
  await first.release?.()
  await expect(
    prepareMeshReviewSession({
      ...f,
      args: {...f.args, reference: `${side},${front}`, noConcept: undefined},
      auth,
    }),
  ).rejects.toThrow(/changed/)
  await expect(
    prepareMeshReviewSession({
      ...f,
      args: {...f.args, reference: `${front},${side}`, noConcept: undefined},
      auth: {...auth, apiKey: 'another-key'},
    }),
  ).rejects.toThrow(/workspace changed/)
  expect(f.fetchImpl).toHaveBeenCalledOnce()
})

it('rejects outputs containing inputs and rejects silently omitted symbolic inputs', async () => {
  const f = await sessionFixture()
  await expect(
    prepareMeshReviewSession({...f, args: {...f.args, out: f.root}, auth}),
  ).rejects.toThrow(/must not contain/)
  const folder = join(f.root, 'delivery')
  await mkdir(folder)
  await symlink(f.mesh, join(folder, 'mesh.glb'))
  await expect(
    prepareMeshReviewSession({...f, args: {...f.args, inputs: [folder]}, auth}),
  ).rejects.toThrow(/Symbolic review inputs/)
  expect(f.fetchImpl).not.toHaveBeenCalled()
})

it('uses one default session and excludes a concurrent engine owner', async () => {
  const f = await sessionFixture()
  vi.stubEnv('ASSETHUB_CLI_STATE_DIR', join(f.root, 'state'))
  const options = {...f, args: {...f.args, out: undefined}, auth}
  const first = await prepareMeshReviewSession(options)
  await expect(prepareMeshReviewSession(options)).rejects.toThrow(
    /Do not start a second engine/,
  )
  await first.release?.()
  const resumed = await prepareMeshReviewSession(options)
  expect(resumed.out).toBe(first.out)
  expect(resumed.clientRunKey).toBe(first.clientRunKey)
  await resumed.release?.()
})

it('pins exact findings and evidence before upload, rejecting edits with unchanged counts', async () => {
  const f = await sessionFixture()
  const fetchImpl = vi.fn(
    async (url: string | URL | Request) =>
      new Response(
        JSON.stringify({
          success: true,
          data: String(url).endsWith('/complete')
            ? {
                runId: 'run',
                status: 'passed',
                summary: {error: 0, warn: 0, info: 0},
                baselineRunId: null,
                unchanged: false,
              }
            : {runId: 'run', status: 'running', uploads: []},
        }),
      ),
  )
  const session = await prepareMeshReviewSession({...f, auth, fetchImpl})
  const path = join(session.out, 'findings.json')
  const doc = {
    schema: 'mesh-review/v1',
    inputs: [],
    config: {},
    findings: [],
    summary: {error: 0, warn: 0, info: 0},
  }
  await writeFile(path, JSON.stringify(doc))
  await session.markEngineCompleted?.()
  await expect(
    syncMeshReview({
      findingsPath: path,
      project: 'project',
      assetKey: 'mesh',
      baseUrl: auth.baseUrl,
      apiKey: auth.apiKey,
      fetchImpl,
    }),
  ).rejects.toThrow(/Do not start a second engine/)
  await session.release?.()
  const input = {
    findingsPath: path,
    project: 'project',
    assetKey: 'mesh',
    baseUrl: auth.baseUrl,
    apiKey: auth.apiKey,
    fetchImpl,
  }
  expect(await syncMeshReview(input)).toMatchObject({
    runId: 'run',
    status: 'passed',
  })
  const calls = fetchImpl.mock.calls.length
  await writeFile(path, JSON.stringify({...doc, config: {changed: true}}))
  await expect(syncMeshReview(input)).rejects.toThrow(
    /Findings or rendered evidence changed|completion receipt/,
  )
  expect(fetchImpl).toHaveBeenCalledTimes(calls)
})

// @testdoc A new session cannot claim findings left by a different or unsynced analysis.
it('rejects stale findings before registering a new run', async () => {
  const f = await sessionFixture()
  await mkdir(f.args.out, {recursive: true})
  await writeFile(join(f.args.out, 'findings.json'), '{}')
  await expect(prepareMeshReviewSession({...f, auth})).rejects.toThrow(/no owning review session/)
  expect(f.fetchImpl).not.toHaveBeenCalled()
})

// @testdoc Only a successful engine completion receipt makes findings resumable; edits invalidate it.
it('resumes only engine-completed findings with the same bytes', async () => {
  const f = await sessionFixture()
  const session = await prepareMeshReviewSession({...f, auth})
  const findings = join(session.out, 'findings.json')
  await writeFile(findings, '{"schema":"mesh-review/v1"}')
  await session.release?.()
  await expect(prepareMeshReviewSession({...f, auth})).rejects.toThrow(/completion receipt/)
  await session.markEngineCompleted?.()
  const resumed = await prepareMeshReviewSession({...f, auth})
  expect(resumed.findingsPath).toBe(findings)
  await resumed.release?.()
  await writeFile(findings, '{}')
  await expect(prepareMeshReviewSession({...f, auth})).rejects.toThrow(/completion receipt/)
})

// @testdoc An interrupt during preparation prevents registering a server run.
it('does not register an already interrupted review', async () => {
  const f = await sessionFixture()
  await expect(prepareMeshReviewSession({...f, auth, signal: AbortSignal.abort()})).rejects.toThrow()
  expect(f.fetchImpl).not.toHaveBeenCalled()
})
