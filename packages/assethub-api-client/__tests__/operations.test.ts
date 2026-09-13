import {describe, expect, it, vi} from 'vitest'
import {createAssetHubClient} from '../src/index.js'
import {
  buildApiCatalog,
  buildApiRequest,
  callApiOperation,
  describeApiOperation,
  discoverApiOperations,
  searchApiOperations,
} from '../src/operations.js'

const operationId = '11111111-1111-4111-8111-111111111111'
const spec = {
  paths: {
    '/mesh/compose': {
      post: {
        summary: 'Compose saved parts',
        requestBody: {$ref: '#/components/schemas/Parts'},
      },
    },
    '/canvases/{canvasId}/nodes': {get: {summary: 'Read native nodes'}},
  },
  components: {
    schemas: {
      Parts: {properties: {parts: {$ref: '#/components/schemas/Part'}}},
      Part: {type: 'string'},
      Unrelated: {type: 'number'},
    },
  },
}

// @testdoc Shared discovery preserves exact versioned operation IDs and includes only the operation's referenced schema closure.
it('shares catalog search and exact referenced contracts', () => {
  const catalog = buildApiCatalog(spec)
  expect(searchApiOperations(catalog, 'compose')).toEqual([
    {
      operation: 'POST /mesh/compose',
      summary: 'Compose saved parts',
      cost: undefined,
    },
  ])
  expect(
    describeApiOperation(catalog.get('POST /mesh/compose')!, spec),
  ).toMatchObject({
    path: '/api/v2/mesh/compose',
    components: {
      schemas: {Parts: spec.components.schemas.Parts, Part: {type: 'string'}},
    },
  })
  expect(
    Object.keys(
      describeApiOperation(catalog.get('POST /mesh/compose')!, spec).components
        .schemas,
    ),
  ).toEqual(['Parts', 'Part'])
  expect([...buildApiCatalog(spec, 'v1', 'V1 ').keys()]).toContain(
    'V1 POST /mesh/compose',
  )
})

// @testdoc Supplied path values cannot turn a discovered operation into traversal, encoded separators or a different URL.
it.each([
  '',
  '.',
  '..',
  'one/two',
  'one\\two',
  '%2fprivate',
  'one?admin=true',
  'one#fragment',
])('rejects unsafe path parameter %j', value => {
  expect(() =>
    buildApiRequest(
      buildApiCatalog(spec),
      {
        operation: 'GET /canvases/{canvasId}/nodes',
        path: {canvasId: value},
      },
      'https://app.example.test',
      operationId,
    ),
  ).toThrow(/path parameter/)
})

// @testdoc An advertised document cannot escape the API prefix, even before path substitution.
it.each([
  '//foreign.test/path',
  '/../admin',
  '/%2e%2e/admin',
  '/a\\b',
  '/a?x=1',
  '/a#x',
])('rejects unsafe advertised route %j', path => {
  expect(() => buildApiCatalog({paths: {[path]: {get: {}}}})).toThrow(/path/)
})

// @testdoc Shared request mapping preserves exact bodies, query encoding and operation identity while rejecting accidental extra paths or GET bodies.
it('maps a known request and validates its identity', () => {
  const catalog = buildApiCatalog(spec)
  const request = buildApiRequest(
    catalog,
    {
      operation: 'GET /canvases/{canvasId}/nodes',
      path: {canvasId: '42'},
      query: {query: 'head & body', limit: 2},
    },
    'https://app.example.test',
    operationId,
  )
  expect(request.url.href).toBe(
    'https://app.example.test/api/v2/canvases/42/nodes?query=head+%26+body&limit=2',
  )
  expect(() =>
    buildApiRequest(
      catalog,
      {
        operation: 'GET /canvases/{canvasId}/nodes',
        path: {canvasId: '42', extra: 'x'},
      },
      'https://app.example.test',
      operationId,
    ),
  ).toThrow(/Unknown path/)
  expect(() =>
    buildApiRequest(
      catalog,
      {
        operation: 'GET /canvases/{canvasId}/nodes',
        path: {canvasId: '42'},
        body: {},
      },
      'https://app.example.test',
      operationId,
    ),
  ).toThrow(/GET does not accept/)
  expect(() =>
    buildApiRequest(
      catalog,
      {
        operation: 'POST /mesh/compose',
        operationId,
        body: {
          executionContext: {
            clientOperationId: '22222222-2222-4222-8222-222222222222',
          },
        },
      },
      'https://app.example.test',
      operationId,
    ),
  ).toThrow(/must equal/)
  expect(() =>
    buildApiRequest(
      catalog,
      {operation: 'TRACE /mesh/compose'},
      'https://app.example.test',
      operationId,
    ),
  ).toThrow(/Unknown operation/)
})

describe('authenticated advertised operations', () => {
  const setup = () => {
    const requests: Array<{url: string; init?: RequestInit}> = []
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({url: String(url), init})
      if (String(url).endsWith('/openapi'))
        return Response.json(
          String(url).includes('/v2/')
            ? spec
            : {
                paths: {
                  '/production/status/{orderId}': {
                    get: {summary: 'Read order'},
                  },
                },
              },
        )
      return Response.json({success: true, data: {runId: 'saved-run'}})
    })
    const client = createAssetHubClient({
      apiKey: 'scoped-key',
      workspaceId: 'workspace',
      baseUrl: 'https://app.example.test/prefix',
      fetch,
    })
    return {client, requests, fetch}
  }

  // @testdoc Discovery uses this client's authenticated documents; hidden routes cannot be invoked through a generic fallback.
  it('discovers filtered documents and dispatches a mutation with the supplied key', async () => {
    const {client, requests} = setup()
    const discovery = await discoverApiOperations(client)
    expect([...discovery.catalog.keys()]).toEqual([
      'POST /mesh/compose',
      'GET /canvases/{canvasId}/nodes',
      'V1 GET /production/status/{orderId}',
    ])
    const body = {
      parts: ['mesh_1', 'mesh_2'],
      executionContext: {canvasId: 42, clientOperationId: operationId},
    }
    expect(
      await callApiOperation(client, discovery, {
        operation: 'POST /mesh/compose',
        operationId,
        body,
      }),
    ).toEqual({success: true, data: {runId: 'saved-run'}})
    const dispatched = requests.at(-1)!
    expect(dispatched.url).toBe(
      'https://app.example.test/prefix/api/v2/mesh/compose',
    )
    expect(dispatched.init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      body: JSON.stringify(body),
      headers: {
        Authorization: 'Bearer scoped-key',
        'X-AssetHub-Workspace': 'workspace',
        'Idempotency-Key': operationId,
      },
    })
    await expect(
      callApiOperation(client, discovery, {
        operation: 'POST /private/admin',
        operationId,
      }),
    ).rejects.toThrow(/Unknown operation/)
    expect(requests).toHaveLength(3)
    expect(
      requests
        .slice(0, 2)
        .every(
          request =>
            new Headers(request.init?.headers).get('Authorization') ===
            'Bearer scoped-key',
        ),
    ).toBe(true)
  })

  // @testdoc Missing or malformed mutation IDs never reach the transport; GET operations do not need a caller-generated ID.
  it('requires an explicit mutation ID and executes a v1 read', async () => {
    const {client, requests} = setup()
    const discovery = await discoverApiOperations(client)
    await expect(
      callApiOperation(client, discovery, {
        operation: 'POST /mesh/compose',
        body: {},
      }),
    ).rejects.toThrow(/operationId/)
    await expect(
      callApiOperation(client, discovery, {
        operation: 'POST /mesh/compose',
        operationId: 'invalid',
        body: {},
      }),
    ).rejects.toThrow(/operationId/)
    expect(requests).toHaveLength(2)
    await callApiOperation(client, discovery, {
      operation: 'V1 GET /production/status/{orderId}',
      path: {orderId: 'saved-order'},
    })
    expect(requests.at(-1)?.url).toBe(
      'https://app.example.test/prefix/api/v1/production/status/saved-order',
    )
  })

  // @testdoc Provider/API rejection remains the existing typed error with run/request identity and is never replayed by the gateway.
  it('preserves the error envelope without retrying a write', async () => {
    const {client, fetch, requests} = setup()
    const discovery = await discoverApiOperations(client)
    fetch.mockImplementationOnce(async (url, init) => {
      requests.push({url: String(url), init})
      return Response.json(
        {
          success: false,
          error: {
            code: 'EXECUTION_RECOVERY_REQUIRED',
            message: 'Inspect original run',
            requestId: 'request-1',
            details: {runId: 'original-run'},
          },
        },
        {status: 409},
      )
    })
    await expect(
      callApiOperation(client, discovery, {
        operation: 'POST /mesh/compose',
        operationId,
        body: {},
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'EXECUTION_RECOVERY_REQUIRED',
      requestId: 'request-1',
      runId: 'original-run',
    })
    expect(requests).toHaveLength(3)
  })
})
