import type {
  CanvasExecution,
  ModelSummary,
  ProductionAutomationBatchStatusResult,
} from '@assethub/api-client'
import {describe, expect, it} from 'vitest'
import {
  DEFAULT_PART_COUNT_CAP,
  batchProgressLines,
  buildAutomationConfig,
  buildComposerPartsFromMeshExecutions,
  detectOneShotImageInput,
  errorHintFor,
  estimateOneShotCost,
  exceedsMaxCost,
  formatExecutionSummaryLines,
  parseComposeFlag,
  pollAutomationBatch,
  resolveFullBodyImageAssetId,
  stageLabelForOrderStatus,
  withErrorHint,
} from '../productionOneShot.js'

describe('detectOneShotImageInput', () => {
  it('treats an existing local path as a file', () => {
    expect(detectOneShotImageInput('./input.png', path => path === './input.png')).toEqual({
      kind: 'file',
      path: './input.png',
    })
  })

  it('treats anything else as an asset/resource id', () => {
    expect(detectOneShotImageInput('asset_123', () => false)).toEqual({
      kind: 'resourceId',
      resourceId: 'asset_123',
    })
  })
})

describe('parseComposeFlag', () => {
  it('passes through v6 and none', () => {
    expect(parseComposeFlag('v6')).toBe('v6')
    expect(parseComposeFlag('none')).toBe('none')
  })

  it('returns undefined when omitted', () => {
    expect(parseComposeFlag(undefined)).toBeUndefined()
  })

  it('rejects any other value', () => {
    expect(() => parseComposeFlag('v5')).toThrow('--compose must be "v6" or "none"')
  })
})

describe('buildAutomationConfig', () => {
  it('omits config entirely when --compose is absent', () => {
    expect(buildAutomationConfig(undefined)).toBeUndefined()
  })

  it('disables autoCompose for --compose none', () => {
    expect(buildAutomationConfig('none')).toEqual({autoCompose: false})
  })

  it('disables autoCompose and hints composeModel for --compose v6, so automation never auto-composes with a non-V6 model', () => {
    expect(buildAutomationConfig('v6')).toEqual({autoCompose: false, composeModel: 'v6'})
  })
})

describe('estimateOneShotCost', () => {
  const meshModel: ModelSummary = {
    id: 'meshGen.hunyuan31',
    domain: 'meshGen',
    name: 'Hunyuan 3.1',
    tags: [],
    credits: null,
    creditCost: 12,
    creditPlanId: 'plan',
    defaultCreditCost: 12,
    defaultCreditPlanId: 'plan',
    duration: null,
    type: 'mesh',
    productVersion: null,
    providerFamily: null,
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
    apiCapabilities: [],
    options: null,
    deprecated: false,
  }

  it('multiplies the per-part mesh unit cost by the part-count cap', () => {
    const estimate = estimateOneShotCost({
      meshModel,
      partCountCap: DEFAULT_PART_COUNT_CAP,
      composeRequested: false,
      composeCredits: undefined,
    })
    expect(estimate.mesh.credits).toBe(12 * DEFAULT_PART_COUNT_CAP)
    expect(estimate.mesh.unitCost).toBe(12)
    expect(estimate.compose.credits).toBe(0)
    expect(estimate.split.credits).toBeNull()
    // total only sums the known parts (split is unknown, compose is 0 when disabled)
    expect(estimate.totalCredits).toBe(12 * DEFAULT_PART_COUNT_CAP)
  })

  it('notes when the mesh model has no credit price', () => {
    const estimate = estimateOneShotCost({
      meshModel: {...meshModel, creditCost: null, defaultCreditCost: null},
      partCountCap: DEFAULT_PART_COUNT_CAP,
      composeRequested: false,
      composeCredits: undefined,
    })
    expect(estimate.mesh.credits).toBeNull()
    expect(estimate.notes.some(note => note.includes('mesh generation cost not included'))).toBe(
      true,
    )
  })

  it('notes when no mesh model was resolved at all', () => {
    const estimate = estimateOneShotCost({
      meshModel: undefined,
      partCountCap: DEFAULT_PART_COUNT_CAP,
      composeRequested: false,
      composeCredits: undefined,
    })
    expect(estimate.mesh.credits).toBeNull()
    expect(estimate.notes.some(note => note.includes('mesh generation cost not included'))).toBe(
      true,
    )
  })

  it('includes a resolved compose quote in the total', () => {
    const estimate = estimateOneShotCost({
      meshModel,
      partCountCap: 3,
      composeRequested: true,
      composeCredits: 40,
    })
    expect(estimate.compose.credits).toBe(40)
    expect(estimate.totalCredits).toBe(12 * 3 + 40)
  })

  it('notes when compose was requested but no quote was found', () => {
    const estimate = estimateOneShotCost({
      meshModel,
      partCountCap: 3,
      composeRequested: true,
      composeCredits: null,
    })
    expect(estimate.compose.credits).toBeNull()
    expect(estimate.notes.some(note => note.includes('compose cost not included'))).toBe(true)
  })
})

describe('exceedsMaxCost', () => {
  it('is false when --max-cost is not given', () => {
    expect(exceedsMaxCost(1000, undefined)).toBe(false)
  })

  it('is true only once the total exceeds the cap', () => {
    expect(exceedsMaxCost(100, 100)).toBe(false)
    expect(exceedsMaxCost(101, 100)).toBe(true)
  })
})

describe('stageLabelForOrderStatus', () => {
  it('maps every real ProductionOrderStatus to a stage label', () => {
    expect(stageLabelForOrderStatus('draft')).toBe('queued')
    expect(stageLabelForOrderStatus('analyzing')).toBe('split')
    expect(stageLabelForOrderStatus('ready')).toBe('mesh')
    expect(stageLabelForOrderStatus('in_progress')).toBe('mesh')
    expect(stageLabelForOrderStatus('completed')).toBe('done')
    expect(stageLabelForOrderStatus('failed')).toBe('failed')
  })
})

const batchStatus = (
  images: ProductionAutomationBatchStatusResult['images'],
): ProductionAutomationBatchStatusResult => ({
  batchId: 'batch_1',
  images,
  summary: {
    total: images.length,
    completed: images.filter(image => image.status === 'completed').length,
    failed: images.filter(image => image.status === 'failed').length,
    inProgress: images.filter(image =>
      ['draft', 'analyzing', 'ready', 'in_progress'].includes(image.status),
    ).length,
  },
})

const image = (
  orderId: string,
  status: ProductionAutomationBatchStatusResult['images'][number]['status'],
): ProductionAutomationBatchStatusResult['images'][number] => ({
  orderId,
  projectId: 1,
  imageIndex: 0,
  status,
  name: null,
  url: null,
  createdAt: '',
  updatedAt: '',
})

describe('batchProgressLines', () => {
  it('emits one line per per-image stage transition, without a batch completion line when nothing finished yet', () => {
    const previous = batchStatus([image('ord_1', 'analyzing')])
    const next = batchStatus([image('ord_1', 'in_progress')])
    const lines = batchProgressLines(previous, next)
    expect(lines).toEqual(['[batch] order=ord_1 stage=mesh (in_progress)'])
  })

  it('emits nothing when nothing changed', () => {
    const status = batchStatus([image('ord_1', 'in_progress')])
    expect(batchProgressLines(status, status)).toEqual([])
  })

  it('reports batch completion once every image finishes', () => {
    const previous = batchStatus([image('ord_1', 'in_progress')])
    const next = batchStatus([image('ord_1', 'completed')])
    const lines = batchProgressLines(previous, next)
    expect(lines).toContain('[batch] order=ord_1 stage=done (completed)')
    expect(lines).toContain('[batch] mesh 1/1 done')
  })
})

describe('pollAutomationBatch', () => {
  it('polls until every image is completed or failed, reporting progress', async () => {
    const statuses = [
      batchStatus([image('ord_1', 'analyzing')]),
      batchStatus([image('ord_1', 'in_progress')]),
      batchStatus([image('ord_1', 'completed')]),
    ]
    let call = 0
    const progress: string[][] = []
    const result = await pollAutomationBatch({
      getStatus: async () => statuses[call++],
      sleep: async () => undefined,
      intervalMs: 10,
      timeoutMs: 10000,
      onProgress: lines => progress.push(lines),
    })
    expect(result.summary.completed).toBe(1)
    expect(call).toBe(3)
    expect(progress.length).toBe(3)
  })

  it('throws once the deadline passes without every image finishing', async () => {
    const pending = batchStatus([image('ord_1', 'in_progress')])
    let now = 0
    await expect(
      pollAutomationBatch({
        getStatus: async () => pending,
        sleep: async () => {
          now += 20
        },
        intervalMs: 10,
        timeoutMs: 15,
        onProgress: () => undefined,
      }),
    ).rejects.toThrow(/timed out/)
    void now
  })
})

const meshExecution = (options: {
  orderId: string
  meshAssetId: string
  partImageAssetId?: string
}): CanvasExecution =>
  ({
    schemaVersion: 'assethub.execution.v1',
    runId: `run_${options.meshAssetId}`,
    operation: 'mesh.generate',
    status: 'completed',
    canvas: {id: 1, name: 'c', ownerId: 'o', url: ''},
    jobIds: [],
    orderIds: [options.orderId],
    graphRefs: [],
    outputs: [{assetId: options.meshAssetId, mediaType: 'mesh'}],
    history: {status: 'recorded'},
    usage: {reservedCredits: null, chargedCredits: null},
    createdAt: '',
    input: {},
    context: {canvasId: 1, clientOperationId: 'op', source: 'cli'},
    ...(options.partImageAssetId
      ? {
          inputAssets: [
            {assetId: options.partImageAssetId, mediaType: 'image'},
          ],
        }
      : {}),
  }) as CanvasExecution

describe('buildComposerPartsFromMeshExecutions', () => {
  it('pairs each produced mesh asset with the part image it was generated from', () => {
    const executions = [
      meshExecution({orderId: 'ord_1', meshAssetId: 'mesh_a', partImageAssetId: 'img_a'}),
      meshExecution({orderId: 'ord_1', meshAssetId: 'mesh_b', partImageAssetId: 'img_b'}),
    ]
    expect(buildComposerPartsFromMeshExecutions(executions, 'ord_1')).toEqual([
      {assetId: 'mesh_a', partImageAssetId: 'img_a'},
      {assetId: 'mesh_b', partImageAssetId: 'img_b'},
    ])
  })

  it('ignores executions from other orders and other operations', () => {
    const executions = [
      meshExecution({orderId: 'ord_2', meshAssetId: 'mesh_x', partImageAssetId: 'img_x'}),
      {...meshExecution({orderId: 'ord_1', meshAssetId: 'mesh_y'}), operation: 'mesh.compose'},
    ]
    expect(buildComposerPartsFromMeshExecutions(executions, 'ord_1')).toEqual([])
  })

  it('omits partImageAssetId when no part image input asset was recorded', () => {
    const executions = [meshExecution({orderId: 'ord_1', meshAssetId: 'mesh_a'})]
    expect(buildComposerPartsFromMeshExecutions(executions, 'ord_1')).toEqual([
      {assetId: 'mesh_a'},
    ])
  })
})

describe('resolveFullBodyImageAssetId', () => {
  it('reads the part image sourceAssetId off a mesh.generate execution for the order', () => {
    const execution: CanvasExecution = {
      ...meshExecution({orderId: 'ord_1', meshAssetId: 'mesh_a'}),
      inputAssets: [{assetId: 'img_a', mediaType: 'image', sourceAssetId: 'full_body_1'}],
    }
    expect(resolveFullBodyImageAssetId([execution], 'ord_1')).toBe('full_body_1')
  })

  it('returns undefined when no execution for the order carries a sourceAssetId', () => {
    const execution = meshExecution({orderId: 'ord_1', meshAssetId: 'mesh_a', partImageAssetId: 'img_a'})
    expect(resolveFullBodyImageAssetId([execution], 'ord_1')).toBeUndefined()
  })
})

describe('errorHintFor / withErrorHint', () => {
  it('hints at mesh generate / production run when the asset was not found', () => {
    const hint = errorHintFor({message: 'Asset not found', status: 404, code: 'NOT_FOUND'})
    expect(hint).toMatch(/mesh generate/)
    expect(hint).toMatch(/production run/)
  })

  it('hints at --part <mesh>:<image> when a part image is missing', () => {
    const hint = errorHintFor({message: 'partImageAssetId is required for this part'})
    expect(hint).toMatch(/--part <mesh-asset-id>:<part-image-asset-id>/)
  })

  it('returns undefined for unrelated errors', () => {
    expect(errorHintFor({message: 'Workspace is over its seat limit'})).toBeUndefined()
  })

  it('appends the hint without discarding the original message', () => {
    const error = new Error('Asset not found')
    withErrorHint(error)
    expect(error.message).toContain('Asset not found')
    expect(error.message).toContain('mesh generate')
  })

  it('leaves the message untouched when no hint applies', () => {
    const error = new Error('Workspace is over its seat limit')
    withErrorHint(error)
    expect(error.message).toBe('Workspace is over its seat limit')
  })
})

describe('formatExecutionSummaryLines', () => {
  it('condenses an execution into a handful of lines', () => {
    const execution: CanvasExecution = {
      schemaVersion: 'assethub.execution.v1',
      runId: 'run_1',
      operation: 'mesh.compose',
      status: 'completed',
      canvas: {id: 7, name: 'c', ownerId: 'o', url: ''},
      jobIds: [],
      orderIds: ['ord_1'],
      graphRefs: [],
      outputs: [{assetId: 'asset_out', mediaType: 'mesh'}],
      history: {status: 'recorded'},
      usage: {reservedCredits: 10, chargedCredits: 8},
      createdAt: '',
      input: {},
      context: {canvasId: 7, clientOperationId: 'op', source: 'cli'},
    }
    const lines = formatExecutionSummaryLines(execution)
    expect(lines).toEqual([
      'runId: run_1',
      'operation: mesh.compose',
      'status: completed',
      'canvas: 7',
      'orders: ord_1',
      'credits: reserved=10 charged=8',
      'output: asset_out',
    ])
  })

  it('includes the error line only when the execution failed', () => {
    const execution: CanvasExecution = {
      schemaVersion: 'assethub.execution.v1',
      runId: 'run_2',
      operation: 'mesh.compose',
      status: 'failed',
      canvas: {id: 7, name: 'c', ownerId: 'o', url: ''},
      jobIds: [],
      orderIds: [],
      graphRefs: [],
      outputs: [],
      history: {status: 'recorded'},
      usage: {reservedCredits: null, chargedCredits: null},
      createdAt: '',
      input: {},
      context: {canvasId: 7, clientOperationId: 'op', source: 'cli'},
      error: {code: 'BOOM', message: 'it broke'},
    }
    const lines = formatExecutionSummaryLines(execution)
    expect(lines).toContain('error: BOOM: it broke')
    expect(lines).toContain('output: -')
  })
})
