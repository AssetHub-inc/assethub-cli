import {expect, it, vi} from 'vitest'
import fixture from './fixtures/composerNeckPublicOperation.json'
import {createAssetHubClient} from '../src/index.js'
import {
  buildApiCatalog,
  callApiOperation,
  describeApiOperation,
  searchApiOperations,
} from '../src/operations.js'

// @testdoc The shared API gateway discovers the existing Composer operation and preserves the public neck pointer, workspace and same idempotency key across replay and result recovery.
it('discovers and recovers the public neck option without private authority', async () => {
  const catalog = buildApiCatalog(fixture.openapi)
  expect(searchApiOperations(catalog, 'compose')).toContainEqual(
    expect.objectContaining({operation: fixture.operation}),
  )
  expect(
    describeApiOperation(catalog.get(fixture.operation)!, fixture.openapi)
      .components.schemas.MeshComposeRequest,
  ).toMatchObject({
    properties: {headBodyConnection: fixture.publicOptionSchema},
  })
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => Response.json(fixture.terminal))
  const client = createAssetHubClient({
    apiKey: 'fixture-key',
    workspaceId: fixture.workspaceId,
    fetch,
  })
  const discovery = {catalog, specs: {v1: {}, v2: fixture.openapi}}
  for (let replay = 0; replay < 2; replay++) {
    expect(
      await callApiOperation(client, discovery, {
        operation: fixture.operation,
        operationId: fixture.operationId,
        body: fixture.request,
      }),
    ).toEqual(fixture.terminal)
  }
  expect(
    await callApiOperation(client, discovery, {
      operation: 'GET /runs/{runId}',
      path: {runId: fixture.runId},
    }),
  ).toEqual(fixture.terminal)
  for (const [, init] of fetch.mock.calls.slice(0, 2)) {
    expect(JSON.parse(String(init?.body))).toEqual(fixture.request)
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(
      fixture.operationId,
    )
    expect(new Headers(init?.headers).get('X-AssetHub-Workspace')).toBe(
      fixture.workspaceId,
    )
  }
  expect(fetch.mock.calls.at(-1)?.[1]?.method).toBe('GET')
  expect(fetch.mock.calls.at(-1)?.[1]?.body).toBeUndefined()
  expect(Object.keys(fixture.request.headBodyConnection)).toEqual([
    'enabled',
    'selectionRef',
  ])
})
