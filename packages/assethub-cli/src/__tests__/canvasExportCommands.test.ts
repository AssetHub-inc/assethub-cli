/**
 * `assethub org search|canvases` and `assethub graph export-canvas`.
 *
 * No network: every test stubs `global.fetch` and asserts on the requests
 * actually sent, which is the contract with the four internal-only routes.
 * Polling loops run under fake timers so the suite stays fast; the download
 * lands in a real temp directory so the streamed file, its name and its
 * sha256 are checked for real.
 */
import {createHash} from 'node:crypto'
import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import process, {stdout} from 'node:process'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {commandGraph, commandOrg} from '../index.js'

type Flags = Record<string, string | boolean | string[]>
type CommandContext = Parameters<typeof commandOrg>[2]

const auth: CommandContext['auth'] = {
  apiKey: 'test-key',
  baseUrl: 'https://api.test',
  profile: 'default',
  source: 'flag',
}

// Neither command touches the typed client — they talk to fetch directly —
// but `CommandContext` requires one.
const client = {} as CommandContext['client']

const makeCtx = (flags: Flags): CommandContext => ({client, flags, auth, args: []})

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'},
  })

const ok = (data: unknown): Response => jsonResponse(200, {success: true, data})

const printedValues = (): unknown[] => {
  const writeMock = stdout.write as unknown as {mock: {calls: unknown[][]}}
  return writeMock.mock.calls.map(call => JSON.parse(String(call[0])))
}

const lastPrinted = (): unknown => {
  const values = printedValues()
  return values[values.length - 1]
}

const requestOf = (index: number): {url: string; init: RequestInit} => {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit]
  return {url, init}
}

let fetchMock: ReturnType<typeof vi.fn>
const cleanup: Array<() => Promise<unknown>> = []

beforeEach(() => {
  vi.useFakeTimers()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  process.exitCode = undefined
})

afterEach(async () => {
  process.exitCode = undefined
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const fn of cleanup.splice(0)) await fn()
})

/** Drains microtasks and timers until the command settles. */
const settle = async (done: Promise<void>): Promise<void> => {
  let settled = false
  done.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  while (!settled) {
    await vi.advanceTimersByTimeAsync(3000)
  }
  await done
}

const runOrg = (subcommand: string, positionals: string[], flags: Flags) =>
  settle(commandOrg(subcommand, positionals, makeCtx(flags)))

const runExport = (flags: Flags) =>
  settle(commandGraph('export-canvas', [], makeCtx(flags)))

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'canvas-export-cli-'))
  cleanup.push(() => rm(dir, {recursive: true, force: true}))
  return dir
}

const readyJob = (jobId: string, projectId: number, url: string | null) => ({
  jobId,
  projectId,
  graphId: `graph-${projectId}`,
  status: 'ready',
  rev: 3,
  sizeBytes: 9,
  blobCount: 1,
  error: null,
  createdAt: '2026-09-11T00:00:00.000Z',
  completedAt: '2026-09-11T00:01:00.000Z',
  download:
    url == null
      ? null
      : {url, fileName: `graph-${projectId}-rev3.zip`, expiresAt: '2026-09-11T01:01:00.000Z'},
})

describe('org search', () => {
  it('GETs /orgs/search with the query encoded and prints the hits', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({orgs: [{orgId: 'org-a', name: 'Acme', type: 'enterprise', memberEmails: []}]}),
    )

    await runOrg('search', ['org', 'search', 'acme studio'], {})

    const {url, init} = requestOf(0)
    expect(url).toBe('https://api.test/api/v2/orgs/search?q=acme%20studio')
    expect(init.method).toBe('GET')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key')
    expect(lastPrinted()).toEqual({
      orgs: [{orgId: 'org-a', name: 'Acme', type: 'enterprise', memberEmails: []}],
    })
    expect(process.exitCode).toBeUndefined()
  })

  it('requires the query positional', async () => {
    await expect(runOrg('search', ['org', 'search'], {})).rejects.toThrow(/query/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('prints a non-internal key’s 404 as-is and exits 2', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(404, {
        success: false,
        error: {code: 'NOT_FOUND', message: 'Not found'},
      }),
    )

    await runOrg('search', ['org', 'search', 'acme'], {})

    expect(lastPrinted()).toEqual({
      error: {code: 'NOT_FOUND', message: 'Not found', status: 404},
    })
    expect(process.exitCode).toBe(2)
  })
})

describe('org canvases', () => {
  it('GETs the org’s workflow canvases', async () => {
    fetchMock.mockResolvedValueOnce(ok({canvases: [{projectId: 7, lastExport: null}]}))

    await runOrg('canvases', ['org', 'canvases'], {org: 'org-a'})

    expect(requestOf(0).url).toBe('https://api.test/api/v2/orgs/org-a/workflow-canvases')
    expect(lastPrinted()).toEqual({canvases: [{projectId: 7, lastExport: null}]})
  })

  it('requires --org', async () => {
    await expect(runOrg('canvases', ['org', 'canvases'], {})).rejects.toThrow(/--org/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('graph export-canvas', () => {
  it('chunks --canvas into POSTs of at most 50 and prints the queued jobs', async () => {
    const ids = Array.from({length: 60}, (_, index) => index + 1)
    fetchMock
      .mockResolvedValueOnce(
        ok({jobs: ids.slice(0, 50).map(id => ({jobId: `j${id}`, projectId: id, graphId: `g${id}`}))}),
      )
      .mockResolvedValueOnce(
        ok({jobs: ids.slice(50).map(id => ({jobId: `j${id}`, projectId: id, graphId: `g${id}`}))}),
      )

    await runExport({org: 'org-a', canvas: ids.join(',')})

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const first = requestOf(0)
    expect(first.url).toBe('https://api.test/api/v2/artifact-graph/canvas-exports')
    expect(first.init.method).toBe('POST')
    expect(JSON.parse(String(first.init.body))).toEqual({
      orgId: 'org-a',
      projectIds: ids.slice(0, 50),
    })
    expect(JSON.parse(String(requestOf(1).init.body))).toEqual({
      orgId: 'org-a',
      projectIds: ids.slice(50),
    })
    const printed = lastPrinted() as {jobs: unknown[]; omitted: number[]}
    expect(printed.jobs).toHaveLength(60)
    expect(printed.omitted).toEqual([])
    expect(process.exitCode).toBeUndefined()
  })

  it('names the ids the API dropped and exits 1 — a partial batch is not a success', async () => {
    // 9 is missing / foreign / not a workflow canvas: the API queues 7 only.
    fetchMock.mockResolvedValueOnce(ok({jobs: [{jobId: 'j7', projectId: 7, graphId: 'g7'}]}))

    await runExport({org: 'org-a', canvas: '7,9'})

    expect(lastPrinted()).toEqual({
      jobs: [{jobId: 'j7', projectId: 7, graphId: 'g7'}],
      omitted: [9],
    })
    expect(process.exitCode).toBe(1)
  })

  it('with --wait, still downloads what was queued but exits 1 for the omitted ids', async () => {
    const outDir = await tempDir()
    fetchMock
      .mockResolvedValueOnce(ok({jobs: [{jobId: 'j7', projectId: 7, graphId: 'g7'}]}))
      .mockResolvedValueOnce(ok(readyJob('j7', 7, 'https://signed.test/g7/3.zip')))
      .mockResolvedValueOnce(ok(readyJob('j7', 7, 'https://signed.test/g7/3.zip')))
      .mockResolvedValueOnce(new Response('zip', {status: 200}))

    await runExport({org: 'org-a', canvas: '7,9', wait: true, 'out-dir': outDir})

    expect(await readdir(outDir)).toEqual(['7-rev3.zip'])
    expect(lastPrinted()).toMatchObject({omitted: [9], failed: []})
    expect(process.exitCode).toBe(1)
  })

  it('deduplicates ids and refuses a non-integer without calling the API', async () => {
    fetchMock.mockResolvedValueOnce(ok({jobs: []}))
    await runExport({org: 'org-a', canvas: '7, 8 ,7'})
    expect(JSON.parse(String(requestOf(0).init.body))).toEqual({
      orgId: 'org-a',
      projectIds: [7, 8],
    })

    fetchMock.mockClear()
    await expect(runExport({org: 'org-a', canvas: '7,abc'})).rejects.toThrow(
      /positive integers/,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('with --wait, polls every job to a terminal status and downloads each ready zip', async () => {
    const outDir = await tempDir()
    const zipBytes = 'zip bytes'
    fetchMock
      .mockResolvedValueOnce(ok({jobs: [{jobId: 'j7', projectId: 7, graphId: 'g7'}]}))
      .mockResolvedValueOnce(ok({...readyJob('j7', 7, null), status: 'running', download: null}))
      .mockResolvedValueOnce(ok(readyJob('j7', 7, 'https://signed.test/g7/3.zip?token=STALE')))
      // Re-read right before the download: the URL the poll saw may have
      // been signed up to an hour earlier on a long batch.
      .mockResolvedValueOnce(ok(readyJob('j7', 7, 'https://signed.test/g7/3.zip?token=SECRET')))
      .mockImplementationOnce(async (url: string, init: RequestInit) => {
        expect(url).toBe('https://signed.test/g7/3.zip?token=SECRET')
        expect(init.redirect).toBe('follow')
        expect(init.headers).toBeUndefined()
        return new Response(zipBytes, {status: 200, headers: {'content-type': 'application/zip'}})
      })

    await runExport({org: 'org-a', canvas: '7', wait: true, 'out-dir': outDir})

    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(requestOf(1).url).toBe('https://api.test/api/v2/artifact-graph/canvas-exports/j7')
    expect(requestOf(3).url).toBe('https://api.test/api/v2/artifact-graph/canvas-exports/j7')
    expect(await readdir(outDir)).toEqual(['7-rev3.zip'])
    expect(await readFile(join(outDir, '7-rev3.zip'), 'utf8')).toBe(zipBytes)
    const printed = lastPrinted() as {
      jobs: {status: string}[]
      downloaded: {jobId: string; path: string; bytes: number; sha256: string}[]
      failed: unknown[]
    }
    expect(printed.jobs[0]?.status).toBe('ready')
    expect(printed.downloaded).toEqual([
      {
        jobId: 'j7',
        projectId: 7,
        rev: 3,
        path: join(outDir, '7-rev3.zip'),
        bytes: zipBytes.length,
        sha256: createHash('sha256').update(zipBytes).digest('hex'),
      },
    ])
    expect(printed.failed).toEqual([])
    // The signed URL never reaches stdout; the rest of `download` does.
    expect(JSON.stringify(printed)).not.toContain('SECRET')
    expect(printed.jobs[0]).toMatchObject({
      download: {fileName: 'graph-7-rev3.zip', expiresAt: '2026-09-11T01:01:00.000Z'},
    })
    expect(process.exitCode).toBeUndefined()
  })

  it('a job that fails exits 1 and downloads nothing', async () => {
    const outDir = await tempDir()
    fetchMock
      .mockResolvedValueOnce(ok({jobs: [{jobId: 'j7', projectId: 7, graphId: 'g7'}]}))
      .mockResolvedValueOnce(
        ok({...readyJob('j7', 7, null), status: 'failed', error: 'room unreadable'}),
      )

    await runExport({org: 'org-a', canvas: '7', wait: true, 'out-dir': outDir})

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(await readdir(outDir)).toEqual([])
    expect(lastPrinted()).toMatchObject({
      jobs: [{jobId: 'j7', status: 'failed', error: 'room unreadable'}],
      downloaded: [],
      failed: [],
    })
    expect(process.exitCode).toBe(1)
  })

  it('a download that fails is recorded under failed, does not abort the batch, and exits 1', async () => {
    const outDir = await tempDir()
    fetchMock
      .mockResolvedValueOnce(
        ok({
          jobs: [
            {jobId: 'j7', projectId: 7, graphId: 'g7'},
            {jobId: 'j8', projectId: 8, graphId: 'g8'},
          ],
        }),
      )
      .mockResolvedValueOnce(ok(readyJob('j7', 7, 'https://signed.test/g7/3.zip?token=SECRET')))
      .mockResolvedValueOnce(ok(readyJob('j8', 8, 'https://signed.test/g8/3.zip')))
      // Each download is preceded by a re-read of its job for a fresh URL.
      .mockResolvedValueOnce(ok(readyJob('j7', 7, 'https://signed.test/g7/3.zip?token=SECRET')))
      .mockResolvedValueOnce(new Response('PRIVATE FAILURE BODY', {status: 503}))
      .mockResolvedValueOnce(ok(readyJob('j8', 8, 'https://signed.test/g8/3.zip')))
      .mockResolvedValueOnce(new Response('zip', {status: 200}))

    await runExport({org: 'org-a', canvas: '7,8', wait: true, 'out-dir': outDir})

    expect(await readdir(outDir)).toEqual(['8-rev3.zip'])
    const printed = lastPrinted() as {downloaded: {jobId: string}[]; failed: unknown[]}
    expect(printed.downloaded.map(file => file.jobId)).toEqual(['j8'])
    expect(printed.failed).toEqual([{jobId: 'j7', projectId: 7, error: 'HTTP 503'}])
    expect(JSON.stringify(printed)).not.toContain('SECRET')
    expect(JSON.stringify(printed)).not.toContain('PRIVATE FAILURE BODY')
    expect(process.exitCode).toBe(1)
  })

  it('a job that never terminates within --timeout exits 3 with the partial list', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({jobs: [{jobId: 'j7', projectId: 7, graphId: 'g7'}]}))
      .mockImplementation(async () =>
        ok({...readyJob('j7', 7, null), status: 'running', download: null}),
      )

    await runExport({org: 'org-a', canvas: '7', wait: true, timeout: '2'})

    expect(lastPrinted()).toMatchObject({
      jobs: [{jobId: 'j7', status: 'running'}],
      timedOut: true,
    })
    expect(process.exitCode).toBe(3)
  })

  it('surfaces a 400 from the API as exit 2', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, {
        success: false,
        error: {code: 'VALIDATION_ERROR', message: 'projectIds too long'},
      }),
    )

    await runExport({org: 'org-a', canvas: '7'})

    expect(lastPrinted()).toEqual({
      error: {code: 'VALIDATION_ERROR', message: 'projectIds too long', status: 400},
    })
    expect(process.exitCode).toBe(2)
  })
})
