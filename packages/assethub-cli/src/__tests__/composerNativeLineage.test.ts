import {spawn} from 'node:child_process'
import {createServer, type IncomingMessage} from 'node:http'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {afterEach, expect, it} from 'vitest'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {await Promise.all(cleanup.splice(0).map(fn => fn()))})
const transform = [2, 3, 4, 0, 0, 0, 1, 1, 1, 1]
const originalTransform = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1]
const runCli = (baseUrl: string, stateDir: string, args: string[]) => new Promise<{code: number | null; json: Record<string, unknown>; stderr: string}>((resolve, reject) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../dist/index.js', import.meta.url)), ...args], {
    env: {...process.env, ASSETHUB_API_KEY: 'test-only-key', ASSETHUB_API_BASE_URL: baseUrl, ASSETHUB_CLI_STATE_DIR: stateDir, ASSETHUB_CLI_CONFIG: join(stateDir, 'auth.json')},
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', value => {stdout += value})
  child.stderr.on('data', value => {stderr += value})
  child.once('error', reject)
  child.once('exit', code => {try {resolve({code, json: JSON.parse(stdout), stderr})} catch {reject(new Error(`${stdout}\n${stderr}`))}})
})
const readBody = async (request: IncomingMessage) => {
  let raw = ''
  for await (const chunk of request) raw += chunk
  return JSON.parse(raw) as Record<string, unknown>
}

// @testdoc Native requested input contains only the node pointer: explicit export and refinement must reuse frozen owned sources and the latest saved scene without resubmitting images or replaying internal execution fields.
it.each([
  {command: 'run', previousOperation: 'mesh.compose', override: false},
  {command: 'run', previousOperation: 'mesh.compose', override: true},
  {command: 'refine', previousOperation: 'mesh.compose', override: false},
  {command: 'refine', previousOperation: 'mesh.refine', override: false},
])('reuses native $previousOperation sources for composer $command (override=$override)', async ({command, previousOperation, override}) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'assethub-native-lineage-'))
  cleanup.push(() => rm(stateDir, {recursive: true, force: true}))
  const canvas = {id: 42, name: 'Native Composer', ownerId: 'org-a', url: 'https://api.test/workflow/42'}
  const posted: Record<string, unknown>[] = []
  const paths: string[] = []
  const frozen = {parts: [{assetId: 'mesh_old'}], fullBodyImageAssetId: 'saved-reference', agentVersion: 'part_composer_v4_turntable', mode: previousOperation === 'mesh.refine' ? 'placement' : 'quick',
    transforms: {mesh_old: originalTransform}, nativeRunMode: 'quick-agent', nativeNodeId: 'shape:composer', nativeScene: {internal: true}, nativeNodeInputFingerprint: 'private-fingerprint', operationKey: 'old-command',
    quickRunId: 'run_old', quickScene: {internal: true}, referenceTransform: originalTransform,
  }
  const previous = {schemaVersion: 'assethub.execution.v1', runId: 'native-run', operation: previousOperation, status: 'needs_review', canvas,
    requestedInput: {executionContext: {canvasId: 42, canvasNode: {nodeId: 'shape:composer'}}}, input: {parts: [{assetId: 'stale-mesh'}]}, resolvedInput: frozen,
    composition: {parts: [{assetId: 'mesh_latest', sourceAssetId: 'mesh_old', name: 'Body', canonicalKey: 'body', volumeCentroid: [1, 2, 3], transform}], transforms: {mesh_latest: transform}, referenceTransform: transform},
  }
  const server = createServer(async (request, response) => {
    paths.push(`${request.method} ${request.url}`)
    let data: unknown
    if (request.url === '/api/v2/runs/native-run') data = previous
    else if (request.url === '/api/v2/capabilities') data = {ownerId: 'org-a', executionContext: {status: 'available', operations: ['mesh.compose', 'mesh.refine']}, evaluators: []}
    else if (request.url === '/api/v2/canvases/42') data = canvas
    else if (request.method === 'GET' && request.url === '/api/v2/mesh/refine') data = {defaultMode: 'standard', modes: [{id: 'standard', available: true, maxRounds: 2, budgetMs: 30000}, {id: 'placement', available: true, maxRounds: 3, budgetMs: 90000}]}
    else if (request.method === 'POST' && ['/api/v2/mesh/compose', '/api/v2/mesh/refine'].includes(request.url ?? '')) {
      const body = await readBody(request)
      posted.push(body)
      data = {execution: {...previous, runId: 'new-run', operation: command === 'refine' ? 'mesh.refine' : 'mesh.compose', status: 'completed', requestedInput: body, input: body, resolvedInput: body, context: body.executionContext, outputs: [], jobIds: [], orderIds: [], graphRefs: [], history: {status: 'recorded'}, usage: {reservedCredits: 0, chargedCredits: 0}, createdAt: '2026-09-11T00:00:00Z'}}
    } else {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(200, {'content-type': 'application/json'})
    response.end(JSON.stringify({success: true, data}))
  })
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  cleanup.push(() => new Promise<void>(done => server.close(() => done())))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing server address')
  const result = await runCli(`http://127.0.0.1:${address.port}`, stateDir, ['composer', command, '--from-run', 'native-run',
    ...(command === 'refine' ? ['--instruction', 'Align the saved parts'] : []),
    ...(override ? ['--transforms-json', JSON.stringify({mesh_latest: originalTransform})] : []),
  ])
  expect(result.code, JSON.stringify(result.json)).toBe(0)
  expect(posted).toHaveLength(1)
  expect(posted[0]).toMatchObject({parts: [{assetId: 'mesh_latest', name: 'Body', canonicalKey: 'body'}], fullBodyImageAssetId: 'saved-reference', transforms: {mesh_latest: override ? originalTransform : transform}, executionContext: {canvasId: 42, parentRunId: 'native-run'}})
  for (const key of ['nativeRunMode', 'nativeNodeId', 'nativeScene', 'nativeNodeInputFingerprint', 'operationKey', 'quickRunId', 'quickScene']) expect(posted[0]).not.toHaveProperty(key)
  if (command === 'run') {
    expect(posted[0]!.parts).toEqual([{assetId: 'mesh_latest', name: 'Body', canonicalKey: 'body'}])
    expect(posted[0]).not.toHaveProperty('referenceTransform')
  } else expect(posted[0]).toMatchObject({referenceTransform: transform, mode: previousOperation === 'mesh.refine' ? 'placement' : 'standard', parts: [{volumeCentroid: [1, 2, 3]}]})
  expect(paths.some(path => /upload|assets|\/image/.test(path))).toBe(false)
})
