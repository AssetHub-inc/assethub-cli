import {beforeEach, describe, expect, it, vi} from 'vitest'
import {
  createAssetHubClient,
  type AccountResult,
  type AccountUsageResult,
  type AnimationPresetsResult,
  type CreditAlert,
  type JobCancellationResult,
  type JobListResult,
  type JobQueryResult,
  type CompletedLargeUpload,
  type FileImportResult,
  type LargeUploadReservation,
  type ModelCatalogResult,
  type PublicJob,
  type MeshConvertResult,
  type ProductionAgentsResult,
  type ProductionAutomationBatchStatusResult,
  type ProductionAutomationResult,
  type ProductionExecuteResult,
  type ProductionRunResult,
  type QueuedCapabilityResult,
  type QueuedImageEditResult,
  type QueuedImageResult,
  type QueuedMeshResult,
  type QueuedMultiviewResult,
  type QueuedPartsSeparationResult,
  type QueuedRigCheckResult,
  type WebhookDelivery,
  type WebhookSubscriptionWithSecret,
} from '../src/index.js'

const API_KEY = 'ah_test_internal'
const BASE_URL = 'https://api.example.test'
const JOB_ID = '11111111-1111-4111-8111-111111111111'

const fetchMock = vi.fn<typeof fetch>()

const ok = (data: unknown): Response =>
  new Response(JSON.stringify({success: true, data}), {
    status: 200,
    headers: {'content-type': 'application/json'},
  })

const job = {
  id: JOB_ID,
  status: 'running',
  step: 'processing',
  progress: 42,
  createdAt: '2026-08-04T10:00:00.000Z',
  startedAt: '2026-08-04T10:00:01.000Z',
  completedAt: null,
  domain: 'meshGen',
  resourceId: 'mesh-gen-1',
} satisfies PublicJob

const client = () =>
  createAssetHubClient({apiKey: API_KEY, baseUrl: BASE_URL, fetch: fetchMock})

const firstRequest = (): [RequestInfo | URL, RequestInit | undefined] => {
  const call = fetchMock.mock.calls[0]
  if (call == null) throw new Error('Expected a fetch call')
  return call
}

beforeEach(() => {
  fetchMock.mockReset()
})

describe('@assethub/api-client v2 job foundation', () => {
  it('lists jobs with encoded filters and returns the cursor unchanged', async () => {
    const result = {
      items: [job],
      nextCursor: 'next opaque/+=',
    } satisfies JobListResult
    fetchMock.mockResolvedValue(ok(result))

    await expect(
      client().v2.listJobs({
        status: 'running',
        domain: 'meshGen',
        limit: 25,
        cursor: 'opaque token/+==',
      }),
    ).resolves.toEqual(result)

    const [url, init] = firstRequest()
    expect(String(url)).toBe(
      `${BASE_URL}/api/v2/jobs?status=running&domain=meshGen&limit=25&cursor=opaque+token%2F%2B%3D%3D`,
    )
    expect(init).toMatchObject({method: 'GET'})
  })

  it('queries an ordered batch without deduplicating the request body', async () => {
    const missingId = '22222222-2222-4222-8222-222222222222'
    const result = {
      items: [
        job,
        {id: missingId, error: {code: 'NOT_FOUND', message: 'Job not found'}},
        job,
      ],
    } satisfies JobQueryResult
    fetchMock.mockResolvedValue(ok(result))

    await expect(
      client().v2.queryJobs([JOB_ID, missingId, JOB_ID]),
    ).resolves.toEqual(result)

    const [url, init] = firstRequest()
    expect(String(url)).toBe(`${BASE_URL}/api/v2/jobs/query`)
    expect(init).toMatchObject({method: 'POST'})
    expect(JSON.parse(String(init?.body))).toEqual({
      jobIds: [JOB_ID, missingId, JOB_ID],
    })
  })

  it('requests cancellation on an encoded job path', async () => {
    const result = {
      id: 'job/with slash',
      cancellation: {state: 'requested', provider: 'unsupported'},
      job,
    } satisfies JobCancellationResult
    fetchMock.mockResolvedValue(ok(result))

    await expect(client().v2.cancelJob('job/with slash')).resolves.toEqual(
      result,
    )

    const [url, init] = firstRequest()
    expect(String(url)).toBe(
      `${BASE_URL}/api/v2/jobs/job%2Fwith%20slash/cancel`,
    )
    expect(init).toMatchObject({method: 'POST'})
  })
})

describe('@assethub/api-client v2 account foundation', () => {
  it('gets the account balance and plan through the success envelope', async () => {
    const result = {
      balance: 120,
      availableBalance: 100,
      reservedCredits: 20,
      balanceReliable: true,
      synthetic: false,
      pools: {free: 10, subscription: 90, paid: 20},
      plan: {
        tier: 'pro',
        subscription: {
          planId: 'plan-pro',
          startsAt: '2026-08-01T00:00:00.000Z',
          endsAt: '2026-09-01T00:00:00.000Z',
        },
        trialExpiresAt: null,
      },
    } satisfies AccountResult
    fetchMock.mockResolvedValue(ok(result))

    await expect(client().v2.getAccount()).resolves.toEqual(result)

    const [url, init] = firstRequest()
    expect(String(url)).toBe(`${BASE_URL}/api/v2/account`)
    expect(init).toMatchObject({method: 'GET'})
  })

  it('lists account usage with encoded time bounds and opaque cursor', async () => {
    const result = {
      items: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          credits: 50,
          status: 'consumed',
          source: 'api',
          createdAt: '2026-08-04T10:00:00.000Z',
          completedAt: '2026-08-04T10:05:00.000Z',
          operation: 'meshGen',
          endpoint: '/api/v2/generate/mesh',
          creditModelId: 'meshGen.meshy_latest',
          jobId: JOB_ID,
        },
      ],
      nextCursor: null,
    } satisfies AccountUsageResult
    fetchMock.mockResolvedValue(ok(result))

    await expect(
      client().v2.getAccountUsage({
        limit: 100,
        cursor: 'cursor/+',
        from: '2026-08-01T00:00:00+09:00',
        to: '2026-08-04T23:59:59+09:00',
      }),
    ).resolves.toEqual(result)

    const [url, init] = firstRequest()
    expect(String(url)).toBe(
      `${BASE_URL}/api/v2/account/usage?limit=100&cursor=cursor%2F%2B&from=2026-08-01T00%3A00%3A00%2B09%3A00&to=2026-08-04T23%3A59%3A59%2B09%3A00`,
    )
    expect(init).toMatchObject({method: 'GET'})
  })

  it('gets and updates the owner-wide low-credit alert', async () => {
    const configToken = '22222222-2222-4222-8222-222222222222'
    const disabled = {
      configToken: null,
      enabled: false,
      threshold: null,
      state: 'unknown',
      lastEvaluatedBalance: null,
      lastEvaluatedAt: null,
      lastTriggeredEventId: null,
      lastTriggeredAt: null,
    } satisfies CreditAlert
    const enabled = {
      configToken,
      enabled: true,
      threshold: 250,
      state: 'above',
      lastEvaluatedBalance: 900,
      lastEvaluatedAt: '2026-08-04T12:00:00.000Z',
      lastTriggeredEventId: null,
      lastTriggeredAt: null,
    } satisfies CreditAlert
    fetchMock
      .mockResolvedValueOnce(ok(disabled))
      .mockResolvedValueOnce(ok(enabled))
      .mockResolvedValueOnce(ok(disabled))

    await expect(client().v2.getCreditAlert()).resolves.toEqual(disabled)
    await expect(
      client().v2.updateCreditAlert(
        {
          configToken: null,
          enabled: true,
          threshold: 250,
        },
        {idempotencyKey: 'configure-alert-1'},
      ),
    ).resolves.toEqual(enabled)
    await expect(client().v2.deleteCreditAlert(configToken)).resolves.toEqual(
      disabled,
    )

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${BASE_URL}/api/v2/account/credit-alert`,
    )
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({method: 'GET'})
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: {'Idempotency-Key': 'configure-alert-1'},
      method: 'PATCH',
    })
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      configToken: null,
      enabled: true,
      threshold: 250,
    })
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: 'DELETE',
      headers: {'If-Match': `"${configToken}"`},
    })
  })
})

describe('@assethub/api-client v2 file imports', () => {
  it('defaults mediaType server-side and returns private staging metadata', async () => {
    const imported = {
      uploadId: '44444444-4444-4444-8444-444444444444',
      fileRef: {
        type: 'supabase',
        bucket: 'external_api_uploads',
        path: 'org-1/external-api-v2/import.png',
      },
      mediaType: 'image',
      contentType: 'image/png',
      fileName: 'import.png',
      size: 123,
      retentionExpiresAt: '2026-08-07T00:00:00.000Z',
    } satisfies FileImportResult
    fetchMock.mockResolvedValue(ok(imported))

    await expect(
      client().v2.importFile({url: 'https://example.test/import.png'}),
    ).resolves.toEqual(imported)
    expect(JSON.parse(String(firstRequest()[1]?.body))).toEqual({
      url: 'https://example.test/import.png',
    })
  })
})

describe('@assethub/api-client v2 large uploads', () => {
  const uploadId = '44444444-4444-4444-8444-444444444444'
  const reservation = {
    uploadId,
    uploadUrl:
      'https://storage.example.test/object/upload/sign/external_api_uploads/path?token=signed',
    uploadToken: 'signed',
    expiresAt: '2026-08-04T14:00:00.000Z',
    expiresIn: 7200,
    fileRef: {
      type: 'supabase',
      bucket: 'external_api_uploads',
      path: `org/external-api-v2/${uploadId}.glb`,
    },
    mediaType: 'mesh',
    contentType: 'model/gltf-binary',
    fileName: 'asset.glb',
    size: 3,
  } satisfies LargeUploadReservation
  const completed = {
    uploadId,
    fileRef: reservation.fileRef,
    mediaType: 'mesh',
    contentType: 'model/gltf-binary',
    fileName: 'asset.glb',
    size: 3,
    retentionExpiresAt: '2026-08-05T12:00:00.000Z',
  } satisfies CompletedLargeUpload

  it('exposes the low-level reservation and completion calls', async () => {
    fetchMock
      .mockResolvedValueOnce(ok(reservation))
      .mockResolvedValueOnce(ok(completed))
    const api = client()

    await expect(
      api.v2.presignFile({
        fileName: 'asset.glb',
        mediaType: 'mesh',
        size: 3,
      }),
    ).resolves.toEqual(reservation)
    await expect(api.v2.completeFile(uploadId)).resolves.toEqual(completed)

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${BASE_URL}/api/v2/files/presign`,
    )
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      fileName: 'asset.glb',
      mediaType: 'mesh',
      size: 3,
    })
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      `${BASE_URL}/api/v2/files/complete`,
    )
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      uploadId,
    })
  })

  it('runs the three-step upload without forwarding the API key to storage', async () => {
    fetchMock
      .mockResolvedValueOnce(ok(reservation))
      .mockResolvedValueOnce(new Response(null, {status: 200}))
      .mockResolvedValueOnce(ok(completed))

    await expect(
      client().v2.uploadLargeFile({
        file: new Blob(['glb'], {type: 'application/octet-stream'}),
        fileName: 'asset.glb',
        mediaType: 'mesh',
      }),
    ).resolves.toEqual(completed)

    const [, uploadInit] = fetchMock.mock.calls[1] ?? []
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(reservation.uploadUrl)
    expect(uploadInit).toMatchObject({
      method: 'PUT',
      headers: {'x-upsert': 'false'},
    })
    expect(uploadInit?.headers).not.toHaveProperty('Authorization')
    expect(uploadInit?.body).toBeInstanceOf(FormData)
  })

  it('does not call complete after the storage upload fails', async () => {
    fetchMock
      .mockResolvedValueOnce(ok(reservation))
      .mockResolvedValueOnce(new Response(null, {status: 503}))

    await expect(
      client().v2.uploadLargeFile({
        file: new Blob(['glb']),
        fileName: 'asset.glb',
        mediaType: 'mesh',
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: 'SIGNED_UPLOAD_PUT_FAILED',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('@assethub/api-client v2 3D capabilities', () => {
  it('sends multiview sources, model params, and strict validation options', async () => {
    const queued = {
      jobId: 'mesh-job',
      meshGenId: 'mesh-gen',
      status: 'queued',
      modelId: 'meshGen.tripo_p1',
      inputMode: 'multiview',
      imageCount: 2,
    } satisfies QueuedMeshResult
    fetchMock.mockResolvedValue(ok(queued))

    await expect(
      client().v2.generateMesh({
        sources: [
          {resourceId: 'front-image'},
          {url: 'https://example.test/back.png'},
        ],
        modelId: 'meshGen.tripo_p1',
        inputMode: 'multiview',
        params: {texture: true, textureQuality: 'detailed'},
        strictOptions: true,
      }),
    ).resolves.toEqual(queued)
    expect(JSON.parse(String(firstRequest()[1]?.body))).toMatchObject({
      sources: [
        {resourceId: 'front-image'},
        {url: 'https://example.test/back.png'},
      ],
      inputMode: 'multiview',
      params: {texture: true, textureQuality: 'detailed'},
      strictOptions: true,
    })
  })

  it('sends multi-reference image generation options', async () => {
    const queued = {
      jobId: 'image-job',
      imageGenId: 'image-gen',
      status: 'queued',
      modelId: 'imageGen.nanoBanana2.openrouter',
      batchSize: 2,
      referenceImageCount: 2,
      aspectRatio: '16:9',
      resolution: 1024,
      strength: 0.8,
    } satisfies QueuedImageResult
    fetchMock.mockResolvedValue(ok(queued))

    await expect(
      client().v2.generateImage({
        prompt: 'A product turntable',
        sources: [{resourceId: 'image-1'}, {resourceId: 'image-2'}],
        modelId: 'imageGen.nanoBanana2.openrouter',
        batchSize: 2,
        aspectRatio: '16:9',
        resolution: 1024,
        strength: 0.8,
        strictOptions: true,
      }),
    ).resolves.toEqual(queued)
  })

  /**
   * Multiview used to be consumed as an NDJSON stream, so a dropped connection
   * lost a generation that had finished and been charged. The helper now hands
   * back the job that outlives the connection.
   */
  it('returns a multiview job to poll rather than a stream', async () => {
    const queued = {
      jobId: JOB_ID,
      message:
        'Multiview generation job has been queued. Use the job ID to poll for status.',
    } satisfies QueuedMultiviewResult
    fetchMock.mockResolvedValue(ok(queued))

    await expect(
      client().v2.generateMultiview({
        source: {resourceId: 'image-1'},
        goalId: '4-view',
      }),
    ).resolves.toEqual(queued)

    const [url, init] = firstRequest()
    expect(String(url)).toBe(`${BASE_URL}/api/v2/image/multiview`)
    expect(init?.method).toBe('POST')
  })

  /**
   * Image edit used to be consumed as an NDJSON stream, so a dropped connection
   * lost an edit that had finished and been charged. The helper now hands back
   * the job that outlives the connection.
   */
  it('returns an image edit job to poll rather than a stream', async () => {
    const queued = {
      jobId: JOB_ID,
      message:
        'Image edit job has been queued. Use the job ID to poll for status.',
    } satisfies QueuedImageEditResult
    fetchMock.mockResolvedValue(ok(queued))

    await expect(
      client().v2.editImage({
        source: {resourceId: 'image-1'},
        goalId: 'Clean Up',
      }),
    ).resolves.toEqual(queued)

    const [url, init] = firstRequest()
    expect(String(url)).toBe(`${BASE_URL}/api/v2/image/edit`)
    expect(init?.method).toBe('POST')
  })

  /**
   * Parts separation used to be consumed as an NDJSON stream, so a dropped
   * connection lost a separation that had finished and been charged. The
   * helper now hands back the job that outlives the connection.
   */
  it('returns a parts separation job to poll rather than a stream', async () => {
    const queued = {
      jobId: JOB_ID,
      message:
        'Parts separation job has been queued. Use the job ID to poll for status.',
    } satisfies QueuedPartsSeparationResult
    fetchMock.mockResolvedValue(ok(queued))

    await expect(
      client().v2.separateImageParts({
        source: {resourceId: 'image-1'},
        goalId: 'full-body',
      }),
    ).resolves.toEqual(queued)

    const [url, init] = firstRequest()
    expect(String(url)).toBe(`${BASE_URL}/api/v2/agent/parts-separation`)
    expect(init?.method).toBe('POST')
  })

  it('calls text, decimate, complete, convert, rig-check, rig, and retarget routes', async () => {
    const resourceResult = (operation: string) => ({
      jobId: `${operation}-job`,
      meshGenId: `${operation}-mesh`,
      status: 'queued',
      operation,
      message: 'queued',
    })
    const rigCheck = {
      jobId: 'rig-check-job',
      status: 'queued',
      operation: 'rig_check',
      message: 'queued',
    } satisfies QueuedRigCheckResult
    const conversion = {
      ...resourceResult('conversion'),
      operation: 'conversion',
      targetFormat: 'fbx',
    } satisfies MeshConvertResult
    fetchMock
      .mockResolvedValueOnce(ok(resourceResult('text_to_3d')))
      .mockResolvedValueOnce(ok(resourceResult('decimation')))
      .mockResolvedValueOnce(ok(resourceResult('part_completion')))
      .mockResolvedValueOnce(ok(conversion))
      .mockResolvedValueOnce(ok(rigCheck))
      .mockResolvedValueOnce(ok(resourceResult('rig')))
      .mockResolvedValueOnce(ok(resourceResult('animation_retarget')))
    const api = client().v2

    await api.generateMeshFromText({prompt: 'Clockwork fox'})
    await api.decimateMesh({source: {resourceId: 'mesh-1'}, faceLimit: 8000})
    await api.completeMeshParts({
      meshGroupId: 'group-1',
      partNames: ['blade'],
    })
    await api.convertMesh({source: {resourceId: 'mesh-1'}, format: 'fbx'})
    await api.checkRig({source: {resourceId: 'mesh-1'}})
    await api.rigMesh({source: {resourceId: 'mesh-1'}, rigType: 'biped'})
    await api.retargetAnimation({resourceId: 'rig-1', animation: 'walk'})

    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      `${BASE_URL}/api/v2/generate/mesh/text`,
      `${BASE_URL}/api/v2/mesh/decimate`,
      `${BASE_URL}/api/v2/mesh/complete`,
      `${BASE_URL}/api/v2/mesh/convert`,
      `${BASE_URL}/api/v2/rig/check`,
      `${BASE_URL}/api/v2/rig`,
      `${BASE_URL}/api/v2/animations/retarget`,
    ])
    expect(JSON.parse(String(fetchMock.mock.calls[6]?.[1]?.body))).toEqual({
      resourceId: 'rig-1',
      animation: 'walk',
    })
  })

  it('provides a typed queued result for text generation', () => {
    const result = {
      jobId: 'job-1',
      meshGenId: 'mesh-1',
      status: 'queued',
      operation: 'text_to_3d',
      message: 'queued',
    } satisfies QueuedCapabilityResult<'text_to_3d'>
    expect(result.operation).toBe('text_to_3d')
  })
})

describe('@assethub/api-client v2 model discovery', () => {
  const catalog = {
    models: [
      {
        id: 'meshGen.tripo_p1',
        domain: 'meshGen',
        name: 'Tripo P1',
        tags: ['low-poly'],
        credits: 60,
        creditCost: 65,
        creditPlanId: 'meshGen.tripo_p1',
        defaultCreditCost: 85,
        defaultCreditPlanId: 'meshGen.tripo_p1.standard_texture',
        duration: 60,
        type: 'base',
        productVersion: 'P1.0',
        providerFamily: 'tripo',
        provider: null,
        providerModel: null,
        apiAvailable: true,
        availability: {
          status: 'available',
          reason: null,
          contractStatus: 'guaranteed',
          guaranteed: true,
          source: 'live-model-catalog',
        },
        apiCapabilities: ['mesh.generate'],
        options: {kind: 'mesh.generate'},
        deprecated: false,
      },
    ],
    creditPlans: [
      {id: 'meshGen.tripo_p1', credits: 65},
      {id: 'meshGen.tripo_p1.standard_texture', credits: 85},
    ],
  } satisfies ModelCatalogResult

  it('returns the public price table while preserving listModels compatibility', async () => {
    fetchMock
      .mockResolvedValueOnce(ok(catalog))
      .mockResolvedValueOnce(ok(catalog))

    await expect(
      client().v2.listModelCatalog({
        domain: 'meshGen',
        capability: 'mesh.generate',
      }),
    ).resolves.toEqual(catalog)
    await expect(client().v2.listModels({domain: 'meshGen'})).resolves.toEqual(
      catalog.models,
    )

    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      `${BASE_URL}/api/v2/models?domain=meshGen&capability=mesh.generate`,
      `${BASE_URL}/api/v2/models?domain=meshGen`,
    ])
  })
})

describe('@assethub/api-client v2 animation preset discovery', () => {
  const presets = {
    items: [
      {
        id: 'preset:idle',
        label: 'Idle',
        tag: 'Basic',
        model: 'v2.5-20260210',
        rigType: 'biped',
      },
    ],
    nextCursor: null,
    recommendedModels: {biped: 'v1.0-20240301'},
  } satisfies AnimationPresetsResult

  it('lists presets with an encoded filter and with no filter at all', async () => {
    fetchMock.mockResolvedValueOnce(ok(presets)).mockResolvedValueOnce(ok(presets))

    await expect(
      client().v2.listAnimationPresets({
        model: 'v2.5-20260210',
        rigType: 'biped',
      }),
    ).resolves.toEqual(presets)
    await expect(client().v2.listAnimationPresets()).resolves.toEqual(presets)

    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      `${BASE_URL}/api/v2/animations/presets?model=v2.5-20260210&rigType=biped`,
      `${BASE_URL}/api/v2/animations/presets`,
    ])
  })
})

describe('@assethub/api-client v1 Production contracts', () => {
  const effectiveOptions = {
    partExtractionMode: 'high_quality',
    partImageModelVariant: 'nano_banana_2',
    partImageModelScope: 'all_steps',
    partImageModelResolvedVia: 'user',
    transformModelVariant: 'nano_banana_pro',
  } as const

  it('forwards model-selection fields for execute and run', async () => {
    const executeResult = {
      orderId: 'order-1',
      missionId: 'mission-1',
      runId: 'run-execute',
      publicAccessToken: 'token-execute',
      status: 'executing',
      effectiveOptions,
    } satisfies ProductionExecuteResult
    const runResult = {
      orderId: 'order-1',
      missionId: 'mission-1',
      runId: 'run-auto',
      publicAccessToken: 'token-auto',
      tag: 'parts-gen-order-1',
      status: 'running',
      runMode: 'full_auto',
      maxIterations: 2,
      maxIterationsEnabled: false,
      abVariantCount: 1,
      estimatedCostCredits: 25,
      maxCostCredits: 30,
      effectiveOptions: {
        ...effectiveOptions,
        meshModelIds: ['meshGen.tripo_3_1'],
      },
    } satisfies ProductionRunResult
    fetchMock
      .mockResolvedValueOnce(ok(executeResult))
      .mockResolvedValueOnce(ok(runResult))
    const api = client().v1

    await api.executeProduction({
      orderId: 'order-1',
      missionId: 'mission-1',
      confirmedTaskIds: ['task-1'],
      agentVersion: 'V1.5',
      partExtractionMode: 'high_quality',
      partImageModelVariant: 'nano_banana_2',
      partImageModelScope: 'all_steps',
      transformModelVariant: 'nano_banana_pro',
    })
    await api.runProduction({
      orderId: 'order-1',
      missionId: 'mission-1',
      agentVersion: 'V1.5',
      partImageModelVariant: 'nano_banana_2',
      partImageModelScope: 'all_steps',
      transformModelVariant: 'nano_banana_pro',
      allowedModelIds: ['meshGen.tripo_3_1'],
    })

    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      partImageModelVariant: 'nano_banana_2',
      partImageModelScope: 'all_steps',
      transformModelVariant: 'nano_banana_pro',
    })
    expect(
      JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)),
    ).toMatchObject({
      partImageModelVariant: 'nano_banana_2',
      partImageModelScope: 'all_steps',
      transformModelVariant: 'nano_banana_pro',
      allowedModelIds: ['meshGen.tripo_3_1'],
    })
  })

  it('discovers agents, dispatches automation, and polls an encoded batch ID', async () => {
    const agents = {
      defaultAgent: 'V1.5',
      agents: [
        {
          agentVersion: 'V1.5',
          internalVersion: 'ah_part_extractor_v65',
          label: 'V1.5',
          defaultAgent: true,
          extractionModes: ['fast', 'high_quality'],
          supportedRunModes: ['full_auto', 'approval'],
          partImageModelVariants: [
            'nano_banana_2',
            'nano_banana_2_lite',
            'nano_banana_pro',
          ],
          partImageModelScopes: ['isolate_only', 'all_steps'],
          transformModelVariants: ['nano_banana_2', 'nano_banana_pro'],
          supportedOnClassicEndpoint: true,
          supportedOnAutomation: true,
        },
      ],
      extractionModes: ['fast', 'high_quality'],
      supportedRunModes: ['full_auto', 'approval'],
      batchLimit: 8,
      maxIterations: 5,
      defaultIterations: 2,
      options: {
        partImageModels: {
          defaultVariant: 'nano_banana_2',
          options: [
            {
              variant: 'nano_banana_2',
              label: 'Nano Banana 2',
              default: true,
              deprecated: false,
            },
          ],
        },
        partImageModelScopes: {
          defaultScope: 'isolate_only',
          options: [
            {
              scope: 'isolate_only',
              default: true,
              description: 'Part views only.',
            },
          ],
        },
        transformModels: {
          defaultVariant: null,
          options: [{variant: 'nano_banana_2', label: 'Nano Banana 2'}],
        },
        meshModels: {modelIds: ['meshGen.tripo_3_1']},
      },
      constraints: {
        run: {
          abFanOutEnabled: false,
          maxAbVariants: 4,
          maxIterationsEnabled: false,
          legacyMaxIterations: 5,
          legacyDefaultIterations: 2,
          unsupportedAxes: ['styleTargets'],
        },
        automation: {maxImages: 8},
      },
      frontendControls: {
        visibility: 'internal_only',
        generalUserUiAvailable: false,
        surfaces: [
          {
            id: 'production_canvas',
            label: 'Production canvas',
            visibility: 'internal_only',
          },
        ],
        selectableControls: [
          {
            key: 'agentVersion',
            label: 'Part separation agent',
            surfaces: ['production_canvas'],
            apiFields: ['agentVersion'],
            apiOptionSource: {
              kind: 'response_collection',
              path: 'agents',
              valueField: 'agentVersion',
            },
          },
        ],
        apiOnlyOptions: [
          {
            key: 'partImageModelScope',
            label: 'Part image model scope',
            surfaces: [],
            apiFields: ['partImageModelScope'],
            apiOptionSource: {
              kind: 'response_collection',
              path: 'options.partImageModelScopes.options',
              valueField: 'scope',
            },
          },
        ],
        frontendOnlyControls: [
          {
            key: 'pipelineDepth',
            label: 'Stop after parts / assemble',
            surfaces: ['production_canvas'],
            publicApiStatus: 'not_exposed',
          },
        ],
      },
      requiresAnalysis: true,
    } satisfies ProductionAgentsResult
    const automation = {
      batchId: 'batch/1',
      agentVersion: 'V1.5',
      estimatedCostCredits: 50,
      images: [
        {
          imageIndex: 0,
          orderId: 'order-1',
          projectId: 42,
          url: '/workflow/42',
          runId: 'run-1',
          publicAccessToken: 'token-1',
        },
      ],
    } satisfies ProductionAutomationResult
    const status = {
      batchId: 'batch/1',
      images: [
        {
          orderId: 'order-1',
          projectId: 42,
          imageIndex: 0,
          status: 'in_progress',
          name: 'Headless Production',
          url: '/workflow/42',
          createdAt: '2026-08-06T00:00:00.000Z',
          updatedAt: '2026-08-06T00:01:00.000Z',
        },
      ],
      summary: {total: 1, completed: 0, failed: 0, inProgress: 1},
    } satisfies ProductionAutomationBatchStatusResult
    fetchMock
      .mockResolvedValueOnce(ok(agents))
      .mockResolvedValueOnce(ok(automation))
      .mockResolvedValueOnce(ok(status))
    const api = client().v1

    await expect(api.getProductionAgents()).resolves.toEqual(agents)
    await expect(
      api.runProductionAutomation({
        images: [{imageUrl: 'https://example.test/source.png'}],
        agentVersion: 'V1.5',
        allowedModelIds: ['meshGen.tripo_3_1'],
      }),
    ).resolves.toEqual(automation)
    await expect(api.getProductionAutomationStatus('batch/1')).resolves.toEqual(
      status,
    )

    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      `${BASE_URL}/api/v1/production/agents`,
      `${BASE_URL}/api/v1/production/automation`,
      `${BASE_URL}/api/v1/production/automation/batch%2F1`,
    ])
  })
})

describe('@assethub/api-client paid command recovery', () => {
  it('forwards one stable Idempotency-Key across every queued paid helper', async () => {
    fetchMock.mockImplementation(async () => ok({status: 'queued'}))
    const api = client()
    const options = {idempotencyKey: 'customer-order-42'}
    const source = {resourceId: 'mesh-1'} as const

    await api.v1.generateImage({prompt: 'v1 image'}, options)
    await api.v2.generateImage({prompt: 'v2 image'}, options)
    await api.v2.generateMultiview({source, goalId: '4-view'}, options)
    await api.v2.editImage({source, goalId: 'Clean Up'}, options)
    await api.v2.separateImageParts({source, goalId: 'full-body'}, options)
    await api.v2.generateMesh(
      {source: {url: 'https://example.test/source.png'}, modelId: 'mesh'},
      options,
    )
    await api.v2.generateMeshFromText({prompt: 'Clockwork fox'}, options)
    await api.v2.decimateMesh({source, faceLimit: 8000}, options)
    await api.v2.completeMeshParts(
      {meshGroupId: 'group-1', partNames: ['blade']},
      options,
    )
    await api.v2.convertMesh({source, format: 'fbx'}, options)
    await api.v2.checkRig({source}, options)
    await api.v2.rigMesh({source, rigType: 'biped'}, options)
    await api.v2.retargetAnimation(
      {resourceId: 'rig-1', animation: 'walk'},
      options,
    )
    await api.v2.retopo({source, modelId: 'retopo'}, options)
    await api.v2.segment({source}, options)
    await api.v2.uvUnwrap({source, modelId: 'uv'}, options)
    await api.v2.texture({source, modelId: 'texture'}, options)

    expect(fetchMock).toHaveBeenCalledTimes(17)
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.headers).toMatchObject({
        'Idempotency-Key': options.idempotencyKey,
      })
    }
  })

  it('preserves the headerless compatibility path when no key is supplied', async () => {
    fetchMock.mockResolvedValue(ok({status: 'queued'}))

    await client().v2.generateMesh({
      source: {url: 'https://example.test/source.png'},
      modelId: 'mesh',
    })

    expect(firstRequest()[1]?.headers).not.toHaveProperty('Idempotency-Key')
  })
})

describe('@assethub/api-client v2 webhooks', () => {
  const subscription = {
    id: '55555555-5555-4555-8555-555555555555',
    url: 'https://hooks.example.test/assethub',
    description: null,
    events: ['job.completed', 'job.failed', 'balance.low'],
    enabled: true,
    secretVersion: 1,
    previousSecretValidUntil: null,
    createdAt: '2026-08-04T10:00:00.000Z',
    updatedAt: '2026-08-04T10:00:00.000Z',
    secret: 'whsec_once',
  } satisfies WebhookSubscriptionWithSecret
  const delivery = {
    id: '66666666-6666-4666-8666-666666666666',
    eventId: 'job:1:job.failed',
    eventType: 'job.failed',
    status: 'dead',
    attemptCount: 8,
    lastHttpStatus: 500,
    lastErrorCode: 'http_500',
    lastResponseExcerpt: 'failed',
    nextAttemptAt: '2026-08-04T10:00:00.000Z',
    deliveredAt: null,
    createdAt: '2026-08-04T10:00:00.000Z',
    updatedAt: '2026-08-04T10:00:00.000Z',
  } satisfies WebhookDelivery

  it('creates and lists subscriptions without adding an idempotency header', async () => {
    fetchMock
      .mockResolvedValueOnce(ok(subscription))
      .mockResolvedValueOnce(ok({subscriptions: [subscription]}))
    const api = client().v2

    await expect(
      api.createWebhook({
        url: subscription.url,
        events: ['job.completed', 'job.failed'],
      }),
    ).resolves.toEqual(subscription)
    await expect(api.listWebhooks()).resolves.toEqual([subscription])

    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
      'Idempotency-Key',
    )
  })

  it('sends API-key-scoped idempotency keys for delete and manual retry', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({deleted: true, id: subscription.id}))
      .mockResolvedValueOnce(ok({deliveryId: delivery.id, status: 'pending'}))
    const api = client().v2

    await api.deleteWebhook(subscription.id, {idempotencyKey: 'delete-1'})
    await api.retryWebhookDelivery(subscription.id, delivery.id, {
      idempotencyKey: 'retry-1',
    })

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'Idempotency-Key': 'delete-1',
    })
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      'Idempotency-Key': 'retry-1',
    })
  })

  it('lists bounded delivery history', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({deliveries: [delivery], hasMore: false}),
    )

    await expect(
      client().v2.listWebhookDeliveries(subscription.id, {limit: 25}),
    ).resolves.toEqual({deliveries: [delivery], hasMore: false})
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${BASE_URL}/api/v2/webhooks/${subscription.id}/deliveries?limit=25`,
    )
  })
})

describe('@assethub/api-client request correlation', () => {
  it('exposes the server request ID on API errors', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          error: {code: 'FAILED', message: 'failed'},
        }),
        {status: 503, headers: {'X-Request-ID': 'request-123'}},
      ),
    )

    await expect(client().v2.getAccount()).rejects.toMatchObject({
      code: 'FAILED',
      requestId: 'request-123',
    })
  })
})

describe('@assethub/api-client compatibility', () => {
  it('keeps the existing getJob route and authorization behavior unchanged', async () => {
    fetchMock.mockResolvedValue(ok(job))

    await expect(client().v2.getJob('job/legacy')).resolves.toEqual(job)

    const [url, init] = firstRequest()
    expect(String(url)).toBe(`${BASE_URL}/api/v2/jobs/job%2Flegacy`)
    expect(init).toMatchObject({
      method: 'GET',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
    })
  })
})
