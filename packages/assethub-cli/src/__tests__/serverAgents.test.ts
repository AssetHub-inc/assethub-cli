import {spawn} from 'node:child_process'
import {createServer, type IncomingMessage} from 'node:http'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {catalogAgentByInternal, findCatalogAgent, parseAgentCatalog} from '../partExtractorCatalog.js'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(fn => fn()))
})

const agent = (label: string, internalVersion: string, extra: Record<string, unknown> = {}) => ({
  agentVersion: label.split(' ')[0],
  internalVersion,
  label,
  defaultAgent: false,
  supportedOnGraphEndpoint: internalVersion.startsWith('ah_agent_graph_'),
  ...extra,
})

const AGENTS = [
  agent('V1.5', 'ah_part_extractor_v65', {defaultAgent: true}),
  agent('V5.0.14 Character Assembly', 'ah_agent_graph_harpy_assembly_v5_0_14'),
  agent('V5.0.15 Character Assembly', 'ah_agent_graph_harpy_assembly_v5_0_15', {supportedBodyConstructions: ['clothed-scaffold-v1']}),
]

type Fake = {baseUrl: string; posted: Record<string, unknown>[]; agentRequests: () => number}

const startFake = async (agentsResponse: unknown | 'fail'): Promise<Fake> => {
  const posted: Record<string, unknown>[] = []
  let agentRequests = 0
  const server = createServer(async (req: IncomingMessage, res) => {
    const path = req.url!
    let body = ''
    for await (const chunk of req) body += chunk
    const canvas = {id: 42, name: 'c', ownerId: 'org-a', url: `http://${req.headers.host}/workflow/42`}
    let data: unknown
    if (path.endsWith('/production/agents')) {
      agentRequests += 1
      if (agentsResponse === 'fail') {
        res.writeHead(500, {'content-type': 'application/json'})
        res.end(JSON.stringify({success: false, error: {message: 'boom'}}))
        return
      }
      data = agentsResponse
    } else if (path.endsWith('/capabilities'))
      data = {ownerId: 'org-a', executionContext: {status: 'available', operations: ['production.analyze']}, evaluators: []}
    else if (path.endsWith('/canvases/42')) data = canvas
    else if (path.endsWith('/production/analyze')) {
      const parsed = JSON.parse(body) as Record<string, unknown>
      posted.push(parsed)
      data = {
        engine: 'artifact-graph',
        graphId: 'g',
        orderId: 'g',
        runId: 'g',
        agentVersion: String(parsed.agentVersion),
        status: 'analyzing',
        execution: {
          schemaVersion: 'assethub.execution.v1',
          runId: 'g',
          operation: 'production.analyze',
          status: 'queued',
          canvas,
          jobIds: [],
          orderIds: ['g'],
          outputs: [],
          history: {status: 'recorded'},
          usage: {reservedCredits: 25, chargedCredits: 0},
          createdAt: '2026-09-08T00:00:00Z',
          resolvedInput: {agentVersion: parsed.agentVersion},
          context: {canvasId: 42, clientOperationId: 'op', source: 'cli'},
          input: {agentVersion: parsed.agentVersion},
        },
      }
    } else {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, {'content-type': 'application/json'})
    res.end(JSON.stringify({success: true, data}))
  })
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  cleanup.push(() => new Promise<void>(done => server.close(() => done())))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  return {baseUrl: `http://127.0.0.1:${address.port}`, posted, agentRequests: () => agentRequests}
}

const cli = async (fake: Fake, args: string[]) => {
  const dir = await mkdtemp(join(tmpdir(), 'assethub-cli-agents-'))
  cleanup.push(() => rm(dir, {recursive: true, force: true}))
  return new Promise<{code: number | null; stdout: string; stderr: string; json: {error?: {message: string}}}>((done, reject) => {
    const child = spawn(
      process.execPath,
      [resolve('packages/assethub-cli/dist/index.js'), ...args, '--base-url', fake.baseUrl, '--api-key', 'test-key-not-secret'],
      {
        env: {
          ...process.env,
          ASSETHUB_API_KEY: 'test-key-not-secret',
          ASSETHUB_API_BASE_URL: fake.baseUrl,
          ASSETHUB_CLI_STATE_DIR: dir,
          ASSETHUB_CLI_CONFIG: join(dir, 'auth.json'),
          ASSETHUB_NO_AUTO_UPDATE: '1',
          ASSETHUB_NO_UPDATE_CHECK: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.once('error', reject)
    child.once('exit', code => {
      try {
        done({code, stdout, stderr, json: JSON.parse(stdout)})
      } catch {
        reject(new Error(`Invalid stdout: ${stdout}; stderr: ${stderr}`))
      }
    })
  })
}

const analyze = (...extra: string[]) => ['production', 'analyze', '--source-id', 'image-asset', '--canvas', '42', ...extra]

describe('part extractor catalog (pure)', () => {
  it('derives flags from server metadata and honours top-level recommendedAgentVersion', () => {
    const catalog = parseAgentCatalog({agents: AGENTS, recommendedAgentVersion: 'V5.0.14'})!
    expect(catalog.preferred?.internalVersion).toBe('ah_agent_graph_harpy_assembly_v5_0_14')
    expect(catalogAgentByInternal(catalog, 'ah_part_extractor_v65')?.characterAssembly).toBe(false)
    expect(findCatalogAgent(catalog, '  v5.0.15   CHARACTER assembly ')?.characterAssembly).toBe(true)
    const body = parseAgentCatalog({agents: [agent('X', 'x_custom', {supportedBodyConstructions: ['a']})]})!
    expect(body.agents[0]!.characterAssembly).toBe(true)
    expect(parseAgentCatalog({agents: [{value: 'legacy-shape'}]})).toBeUndefined()
    expect(parseAgentCatalog('nope')).toBeUndefined()
  })
})

describe('part extractor resolved from the server list', () => {
  it('accepts a server-only agent and treats it as a Character Assembly', async () => {
    const fake = await startFake({agents: AGENTS})
    const result = await cli(fake, analyze('--part-extractor', 'v5.0.15 character assembly', '--body-construction', 'clothed-scaffold-v1'))
    expect(result.code, result.stderr).toBe(0)
    expect(fake.posted[0]).toMatchObject({agentVersion: 'ah_agent_graph_harpy_assembly_v5_0_15', bodyConstruction: 'clothed-scaffold-v1'})
    expect(fake.agentRequests()).toBe(1)
  })

  it('still resolves the CLI aliases against the server list', async () => {
    const fake = await startFake({agents: AGENTS})
    const result = await cli(fake, analyze('--part-extractor', '5.0.14'))
    expect(result.code, result.stderr).toBe(0)
    expect(fake.posted[0]).toMatchObject({agentVersion: 'ah_agent_graph_harpy_assembly_v5_0_14'})
  })

  it('uses the recommended agent when the flag is omitted and says so on stderr', async () => {
    const fake = await startFake({agents: AGENTS.map(entry => ({...entry, recommended: entry.label.startsWith('V5.0.15')}))})
    const result = await cli(fake, analyze())
    expect(result.code, result.stderr).toBe(0)
    expect(fake.posted[0]).toMatchObject({agentVersion: 'ah_agent_graph_harpy_assembly_v5_0_15'})
    expect(result.stderr).toContain('Using part extractor V5.0.15 Character Assembly (recommended on the server)')
    expect(result.stdout).not.toContain('Using part extractor')
  })

  it('falls back to the server default agent, then to the CLI default', async () => {
    const withDefault = await startFake({agents: AGENTS})
    const first = await cli(withDefault, analyze())
    expect(first.code, first.stderr).toBe(0)
    expect(withDefault.posted[0]).toMatchObject({agentVersion: 'ah_part_extractor_v65'})
    expect(first.stderr).toContain('(default on the server)')

    const noList = await startFake({agents: [agent('V2.0 alpha', 'ah_part_extractor_v20_alpha')].map(entry => ({...entry, defaultAgent: false}))})
    // Nothing recommended or default: the CLI default (V1.5) is not listed, so it is refused with the server's names.
    const second = await cli(noList, analyze())
    expect(second.code).not.toBe(0)
    expect(second.json.error?.message).toContain('Use one of: V2.0 alpha')
  })

  it('falls back to the built-in table with a warning when the endpoint fails', async () => {
    const fake = await startFake('fail')
    const result = await cli(fake, analyze('--part-extractor', 'v5.0.14'))
    expect(result.code, result.stderr).toBe(0)
    expect(result.stderr).toContain("could not read the server's part extractor list")
    expect(fake.posted[0]).toMatchObject({agentVersion: 'ah_agent_graph_harpy_assembly_v5_0_14'})
    // Offline, an unknown name is still refused by the table.
    const unknown = await cli(fake, analyze('--part-extractor', 'V9 Nope'))
    expect(unknown.code).not.toBe(0)
    expect(unknown.json.error?.message).toContain('Unknown part extractor: V9 Nope')
  })

  it('rejects an unknown name with the names the server lists, before any paid request', async () => {
    const fake = await startFake({agents: AGENTS})
    const result = await cli(fake, analyze('--part-extractor', 'V9 Nope'))
    expect(result.code).not.toBe(0)
    expect(result.json.error?.message).toBe(
      'Unknown part extractor: V9 Nope. Use one of: V1.5, V5.0.14 Character Assembly, V5.0.15 Character Assembly.',
    )
    expect(fake.posted).toEqual([])
  })

  it('gates character-assembly flags on the server metadata', async () => {
    const fake = await startFake({agents: AGENTS})
    const result = await cli(fake, analyze('--part-extractor', 'V1.5', '--body-construction', 'clothed-scaffold-v1'))
    expect(result.code).not.toBe(0)
    expect(result.json.error?.message).toContain('Character Assembly')
    expect(fake.posted).toEqual([])
  })

  it('does not fetch the list for commands that do not pick an extractor', async () => {
    const fake = await startFake({agents: AGENTS})
    await cli(fake, ['capabilities']).catch(() => undefined)
    expect(fake.agentRequests()).toBe(0)
  })
})
