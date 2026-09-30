import conceptImageAdmission from './fixtures/conceptImageAdmission.json'
import graphPolicyExecution from './fixtures/graphPolicyExecution.json'
import {describe, expect, it, vi} from 'vitest'
import {createAssetHubClient} from '../src/index.js'
import {
  readApiBinaryArtifact,
  buildApiCatalog,
  buildApiRequest,
  callApiOperation,
  describeApiOperation,
  discoverApiOperations,
  parseApiImageOperationResult,
  searchApiOperations,
} from '../src/operations.js'

const operationId = '11111111-1111-4111-8111-111111111111'
const jpegBase64 = '/9j/2Q=='

// @testdoc CLI, MCP and chat's shared generic operation gateway retain explicit mesh settings and the caller's paid idempotency identity.
it('posts explicit graph mesh settings unchanged through the generic operation gateway', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({success: true, data: {runId: 'run-1'}}))
  const client = createAssetHubClient({
    apiKey: 'scoped-key',
    workspaceId: 'workspace',
    fetch: request,
  })
  const operationSpec = {
    paths: {'/production/analyze': {post: {summary: 'Analyze production'}}},
  }
  const body = {
    imageAssetId: 'owned-image',
    agentVersion: 'V3.0.9 Garment Boundaries',
    pipelineDepth: 'composition',
    assemblyPolicy: 'concept-to-character-v1',
    meshGeneration: {
      modelId: 'meshGen.tripo_p2_preview',
      faceLimit: 10000,
      params: {quad: true},
    },
    executionContext: {
      canvasId: 42,
      clientOperationId: operationId,
      source: 'cli',
    },
  }
  await callApiOperation(
    client,
    {
      catalog: buildApiCatalog(operationSpec),
      specs: {v1: {}, v2: operationSpec},
    },
    {operation: 'POST /production/analyze', operationId, body},
  )
  expect(request).toHaveBeenCalledTimes(1)
  const [url, init] = request.mock.calls[0]!
  expect(url).toBe('https://app.assethub.io/api/v2/production/analyze')
  expect(JSON.parse(String(init?.body))).toEqual(body)
  expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(operationId)
  expect(new Headers(init?.headers).get('X-AssetHub-Workspace')).toBe(
    'workspace',
  )
})
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

// @testdoc Catalog search matches every word of a natural phrase in any order, treating path separators as word breaks, so CLI, MCP and chat find an operation by describing it.
it('finds operations by a multi-word phrase, not only by one exact substring', () => {
  const catalog = buildApiCatalog({
    paths: {
      '/image/generate': {post: {summary: 'Generate images'}},
      '/workspace-skills/replay/start': {
        post: {summary: 'Start a workspace skill replay'},
      },
      '/workspace-skills/concept-preparation/start': {
        post: {summary: 'Start concept preparation'},
      },
    },
  })
  const ids = (query: string) =>
    searchApiOperations(catalog, query).map(found => found.operation)

  // Each of these returned nothing when the whole query had to appear as
  // written: "image generate" is not a substring of "POST /image/generate".
  expect(ids('image generate')).toEqual(['POST /image/generate'])
  expect(ids('concept preparation')).toEqual([
    'POST /workspace-skills/concept-preparation/start',
  ])
  expect(ids('workspace skills replay')).toEqual([
    'POST /workspace-skills/replay/start',
  ])
  expect(ids('replay workspace')).toEqual(['POST /workspace-skills/replay/start'])
  // Every word must appear: this is AND, not OR.
  expect(ids('image replay')).toEqual([])
  // One word and the empty query behave exactly as before.
  expect(ids('replay')).toEqual(['POST /workspace-skills/replay/start'])
  expect(ids('')).toHaveLength(3)
})

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

// @testdoc Canonical image operation results retain bytes for native consumers while exposing only byte-free metadata to text and structured outputs.
it.each([
  {kind: 'resourceId', resourceId: 'owned-image'},
  {kind: 'graphArtifact', graphId: 'graph-1', artifactId: 'rejected-head'},
])(
  'parses canonical image operation results and sanitizes metadata: %j',
  source => {
    const result = parseApiImageOperationResult({
      success: true,
      data: {
        schemaVersion: 'assethub.image-inputs.v1',
        images: [
          {
            source,
            mediaType: 'image/jpeg',
            data: jpegBase64,
            width: 16,
            height: 8,
          },
        ],
      },
    })

    expect(result.images).toEqual([
      expect.objectContaining({data: jpegBase64, width: 16, height: 8}),
    ])
    expect(result.metadata).toEqual({
      success: true,
      data: {
        schemaVersion: 'assethub.image-inputs.v1',
        images: [
          {
            source,
            mediaType: 'image/jpeg',
            width: 16,
            height: 8,
          },
        ],
      },
    })
    expect(JSON.stringify(result.metadata)).not.toContain(jpegBase64)
  },
)

// @testdoc Recognized image results reject malformed bytes, sources and batch bounds instead of allowing untrusted payloads into native image content.
it.each([
  {images: []},
  ...[
    {kind: 'graphArtifact', graphId: '../foreign', artifactId: 'head'},
    {kind: 'graphArtifact', graphId: 'graph-1', artifactId: ''},
    {kind: 'graphArtifact', graphId: 'graph-1', artifactId: 'a'.repeat(301)},
    {
      kind: 'graphArtifact',
      graphId: 'graph-1',
      artifactId: 'head',
      url: 'https://example.com/head.png',
    },
  ].map(source => ({
    images: [
      {source, mediaType: 'image/jpeg', data: jpegBase64, width: 16, height: 8},
    ],
  })),
  {
    images: [
      {
        source: {kind: 'resourceId', resourceId: 'owned-image'},
        mediaType: 'image/jpeg',
        data: 'not-base64',
        width: 16,
        height: 8,
      },
    ],
  },
  {
    images: [
      {
        source: {kind: 'uploadId', uploadId: 'not-a-uuid'},
        mediaType: 'image/jpeg',
        data: jpegBase64,
        width: 16,
        height: 8,
      },
    ],
  },
  {
    images: Array.from({length: 5}, () => ({
      source: {kind: 'resourceId', resourceId: 'owned-image'},
      mediaType: 'image/jpeg',
      data: jpegBase64,
      width: 16,
      height: 8,
    })),
  },
])('rejects malformed canonical image result %#', data => {
  expect(() =>
    parseApiImageOperationResult({
      success: true,
      data: {schemaVersion: 'assethub.image-inputs.v1', ...data},
    }),
  ).toThrow('Invalid AssetHub image operation result')
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

// @testdoc Advertised NDJSON writes dispatch once with the same actor/key, retain outputs, and never treat failed/truncated streams as success.
it.each([
  {
    name: 'raw success',
    lines: [
      {
        type: 'workflow-step-result',
        payload: {output: {assetIds: ['image-1']}},
      },
      {type: 'workflow-finish', payload: {workflowStatus: 'success'}},
    ],
    ok: true,
  },
  {
    name: 'public success',
    lines: [{type: 'result', assetIds: ['image-1']}],
    ok: true,
  },
  {
    name: 'terminal failure',
    lines: [{type: 'workflow-finish', payload: {workflowStatus: 'failed'}}],
    ok: false,
  },
  {
    name: 'truncated',
    lines: [
      {
        type: 'workflow-step-result',
        payload: {output: {assetIds: ['image-1']}},
      },
    ],
    ok: false,
  },
  {
    name: 'result then error',
    lines: [{type: 'result', assetIds: ['image-1']}, {type: 'error'}],
    ok: false,
  },
  {name: 'invalid event', lines: [null], ok: false},
  {name: 'empty', lines: [], ok: false},
  {
    name: 'oversized',
    lines: [
      {type: 'result', assetIds: ['image-1'], padding: 'x'.repeat(1_048_576)},
    ],
    ok: false,
  },
])('consumes $name workflow response without replay', async ({lines, ok}) => {
  const bytes = new TextEncoder().encode(
    lines.map(line => JSON.stringify(line)).join('\r\n'),
  )
  const fetch = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.slice(0, 17))
            controller.enqueue(bytes.slice(17))
            controller.close()
          },
        }),
        {headers: {'Content-Type': 'application/x-ndjson; charset=utf-8'}},
      ),
  )
  const client = createAssetHubClient({
    apiKey: 'scoped-key',
    workspaceId: 'workspace',
    fetch,
  })
  const streamSpec = {
    paths: {
      '/image/edit': {
        post: {responses: {'200': {content: {'application/x-ndjson': {}}}}},
      },
    },
  }
  const result = callApiOperation(
    client,
    {
      catalog: buildApiCatalog(streamSpec, 'v1', 'V1 '),
      specs: {v1: streamSpec, v2: {paths: {}}},
    },
    {operation: 'V1 POST /image/edit', operationId, body: {prompt: 'edit'}},
  )
  if (ok)
    await expect(result).resolves.toEqual({
      success: true,
      data: {events: lines},
    })
  else await expect(result).rejects.toThrow()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0]).toMatchObject([
    'https://app.assethub.io/api/v1/image/edit',
    {
      redirect: 'error',
      headers: {
        Authorization: 'Bearer scoped-key',
        'X-AssetHub-Workspace': 'workspace',
        'Idempotency-Key': operationId,
      },
    },
  ])
})

// @testdoc Shared run recovery transport preserves the complete verified execution receipt under the same actor/workspace, without issuing a second generation.
it('preserves the verified graph policy through the shared operation gateway', async () => {
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    Response.json(graphPolicyExecution),
  )
  const client = createAssetHubClient({
    apiKey: 'scoped-key',
    workspaceId: 'workspace',
    fetch,
  })
  const runSpec = {paths: {'/runs/{runId}': {get: {summary: 'Read run'}}}}
  const result = await callApiOperation(
    client,
    {catalog: buildApiCatalog(runSpec), specs: {v1: {}, v2: runSpec}},
    {
      operation: 'GET /runs/{runId}',
      path: {runId: graphPolicyExecution.data.runId},
    },
  )
  expect(result).toEqual(graphPolicyExecution)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0]).toMatchObject([
    `https://app.assethub.io/api/v2/runs/${graphPolicyExecution.data.runId}`,
    {
      method: 'GET',
      headers: {
        Authorization: 'Bearer scoped-key',
        'X-AssetHub-Workspace': 'workspace',
      },
    },
  ])
})

// @testdoc The shared image operation preserves the exact automatic Skill receipt without adding authority to the request or retrying generation.
it('preserves Concept admission through the shared operation gateway', async () => {
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    Response.json(conceptImageAdmission),
  )
  const client = createAssetHubClient({
    apiKey: 'scoped-key',
    workspaceId: 'workspace',
    fetch,
  })
  const imageSpec = {
    paths: {'/image/generate': {post: {summary: 'Generate image'}}},
  }
  const body = {prompt: 'Current concept brief'}
  const result = await callApiOperation(
    client,
    {catalog: buildApiCatalog(imageSpec), specs: {v1: {}, v2: imageSpec}},
    {operation: 'POST /image/generate', operationId, body},
  )
  expect(result).toEqual(conceptImageAdmission)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0]).toMatchObject([
    'https://app.assethub.io/api/v2/image/generate',
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'Idempotency-Key': operationId,
        'X-AssetHub-Workspace': 'workspace',
      },
    },
  ])
})

// @testdoc The shared CLI/MCP/chat gateway discovers foreground history actions and preserves exact binary evidence bytes through authenticated transport.
it('executes advertised Composer history and binary artifact contracts through the shared gateway', async () => {
  const document = {
    paths: {
      '/mesh/refine/foreground': {
        post: {
          summary: 'Composer foreground',
          requestBody: {
            content: {'application/json': {schema: {type: 'object'}}},
          },
        },
      },
      '/runs/{runId}/history': {get: {summary: 'Composer history'}},
      '/runs/{runId}/history/{eventId}/{sha256}': {
        get: {
          summary: 'Composer evidence bytes',
          responses: {
            '200': {
              content: {
                'application/octet-stream': {
                  schema: {type: 'string', format: 'binary'},
                },
              },
            },
          },
        },
      },
    },
  }
  const fetch = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/openapi'))
        return Response.json(
          String(url).includes('/v2/') ? document : {paths: {}},
        )
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer test-key',
        'X-AssetHub-Workspace': 'workspace',
      })
      if (String(url).endsWith('/foreground'))
        return Response.json({success: true, data: {skillRunId: operationId}})
      if (String(url).includes('/history/'))
        return new Response(new Uint8Array([0, 255, 10]), {
          headers: {'Content-Type': 'application/octet-stream'},
        })
      return Response.json({
        success: true,
        data: {runId: operationId, events: []},
      })
    },
  )
  const client = createAssetHubClient({
    apiKey: 'test-key',
    workspaceId: 'workspace',
    baseUrl: 'http://127.0.0.1:43210',
    fetch,
  })
  const discovery = await discoverApiOperations(client)
  expect(searchApiOperations(discovery.catalog, 'Composer')).toHaveLength(3)
  const body = {
    action: 'admit',
    input: {
      sessionId: operationId,
      skillSelection: {mode: 'off', skillIds: []},
    },
  }
  expect(
    await callApiOperation(client, discovery, {
      operation: 'POST /mesh/refine/foreground',
      operationId,
      body,
    }),
  ).toMatchObject({data: {skillRunId: operationId}})
  expect(fetch.mock.calls.at(-1)?.[1]?.body).toBe(JSON.stringify(body))
  const result = await callApiOperation(client, discovery, {
    operation: 'GET /runs/{runId}/history/{eventId}/{sha256}',
    path: {runId: operationId, eventId: operationId, sha256: 'a'.repeat(64)},
    query: {projectId: 42},
  })
  expect(result).toEqual({
    success: true,
    data: {
      schemaVersion: 'assethub.binary-artifact.v1',
      encoding: 'base64',
      mediaType: 'application/octet-stream',
      byteLength: 3,
      data: 'AP8K',
    },
  })
})

describe('binary evidence consumption', () => {
  it.each(['application/json', 'application/octet-stream'])(
    'withholds %s bytes in metadata mode',
    async mediaType => {
      const result = await readApiBinaryArtifact(
        new Response('private-sentinel', {
          headers: {'content-type': mediaType, 'content-length': '16'},
        }),
        'metadata',
      )
      expect(result).toEqual({
        success: true,
        data: {
          schemaVersion: 'assethub.binary-artifact.v1',
          mediaType,
          byteLength: 16,
          contentIncluded: false,
        },
      })
      expect(JSON.stringify(result)).not.toContain('private-sentinel')
      expect(result.data).not.toHaveProperty('data')
    },
  )
  it('rejects an absent stream and a length mismatch', async () => {
    await expect(
      readApiBinaryArtifact(new Response(null), 'metadata'),
    ).rejects.toThrow('body')
    await expect(
      readApiBinaryArtifact(
        new Response('a', {headers: {'content-length': '2'}}),
        'metadata',
      ),
    ).rejects.toThrow('length')
  })
  it('cancels declared oversize without reading bytes', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({cancel}), {
      headers: {'content-length': String(64 * 1024 * 1024 + 1)},
    })
    await expect(readApiBinaryArtifact(response, 'metadata')).rejects.toThrow(
      '64 MiB',
    )
    expect(cancel).toHaveBeenCalledOnce()
  })
  it.each(['metadata', 'base64'] as const)(
    'cancels streamed oversize in %s mode',
    async mode => {
      const cancel = vi.fn()
      let count = 0
      const response = new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024))
            count++
          },
          cancel,
        }),
      )
      await expect(readApiBinaryArtifact(response, mode)).rejects.toThrow(
        '64 MiB',
      )
      expect(cancel).toHaveBeenCalledOnce()
      expect(count).toBeGreaterThanOrEqual(65)
    },
  )
})
