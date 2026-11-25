import {createHash} from 'node:crypto'
import {
  callApiOperation,
  discoverApiOperations,
  type AssetHubClient,
} from '@assethub/api-client'

const destinations = [
  'case',
  'workspace-rule',
  'workspace-skill',
  'shared-skill',
  'ontology-contract',
  'executor',
] as const
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const evaluationUrl = (client: AssetHubClient, id: string) =>
  client.baseUrl + '/api/v2/evaluations/' + encodeURIComponent(id)

/** Record the case first so a refused or interrupted promotion keeps its evidence. */
export async function submitProductionFeedback(
  client: AssetHubClient,
  input: Record<string, unknown>,
  operationId: string,
) {
  function field(key: string, max = 300): string {
    const value = input[key]
    if (typeof value !== 'string' || !value.trim() || value.length > max)
      throw new Error(`Invalid feedback field: ${key}`)
    return value.trim()
  }
  const destination = destinations.find(item => item === input.destination)
  if (!destination)
    throw new Error(`Choose a feedback destination: ${destinations.join(', ')}`)
  if (!uuid.test(operationId))
    throw new Error('Use a stable operation UUID for feedback')
  const workspaceId = field('workspaceId')
  const canvasId = input.canvasId
  if (
    typeof canvasId !== 'number' ||
    !Number.isSafeInteger(canvasId) ||
    canvasId <= 0
  )
    throw new Error('Invalid canvasId')
  const artifactId = field('artifactId')
  const reason = field('finding', 4000)
  const action = field('requestedChange', 4000)
  const evidence = field('evidenceAssetId')
  const runId = field('runId')
  if (!uuid.test(runId))
    throw new Error('Use the run that produced this artifact')
  const rule =
    destination === 'workspace-rule' && input.baseRevisionId !== undefined
      ? {
          baseRevisionId: field('baseRevisionId', 128),
          expectedVersion: field('expectedVersion'),
          ruleId: field('ruleId', 128),
          document: field('document'),
          findingEn: field('findingEn', 4000),
          changeEn: field('changeEn', 4000),
          changeJa: field('changeJa', 4000),
        }
      : undefined
  const graphId =
    destination === 'workspace-skill' && input.graphId !== undefined
      ? field('graphId')
      : undefined
  const graphArtifactId = graphId ? field('graphArtifactId') : undefined
  const taskKind = input.taskKind
  if (
    taskKind !== undefined &&
    ((taskKind !== 'concept_art' && taskKind !== 'part_separation') || !graphId)
  )
    throw new Error('taskKind requires a supported image skill source')
  if (graphId && !uuid.test(graphId)) throw new Error('Invalid source graph ID')
  if ((await client.v2.getCapabilities()).ownerId !== workspaceId)
    throw new Error(
      'Feedback workspace differs from the authenticated API owner',
    )
  const evaluation = await client.v2.submitEvaluation(
    {
      canvasId,
      artifactId,
      runId,
      clientOperationId: operationId,
      evaluator: {name: 'production-feedback'},
      referenceAssetIds: [],
      report: {
        schemaVersion: 'assethub.evaluation-submission.v1',
        rubric: {id: 'production-feedback', version: '1'},
        verdict: 'needs_review',
        referenceAssetIds: [],
        evidenceAssetIds: [evidence],
        criteria: [
          {id: destination, reason, verdict: 'needs_review'},
          ...(rule || graphId
            ? [
                {
                  id: 'proposal-source',
                  reason: createHash('sha256')
                    .update(
                      JSON.stringify(
                        rule ?? {graphId, graphArtifactId, taskKind},
                      ),
                    )
                    .digest('hex'),
                  verdict: 'needs_review' as const,
                },
              ]
            : []),
        ],
        suggestedNextAction: action,
      },
    },
    {idempotencyKey: operationId},
  )
  const receipt = {
    evaluationId: evaluation.id,
    workspaceId,
    destination,
    operationId,
  }
  if (destination === 'workspace-rule' && !rule)
    return {...receipt, status: 'requires_catalog_context'}
  try {
    if (rule) {
      const operation = 'POST /ontology/knowledge/intake'
      const discovery = await discoverApiOperations(client)
      if (!discovery.catalog.has(operation))
        return {...receipt, status: 'requires_ontology_intake_access'}
      const claim = {ja: rule.changeJa, en: rule.changeEn}
      const proposal = await callApiOperation(client, discovery, {
        operation,
        operationId,
        body: {
          baseRevisionId: rule.baseRevisionId,
          expectedVersion: rule.expectedVersion,
          capturedAt: evaluation.createdAt,
          sources: [
            {
              id: evaluation.id,
              kind: 'run',
              externalId: evaluation.id,
              url: evaluationUrl(client, evaluation.id),
              contentSha256: createHash('sha256').update(reason).digest('hex'),
              text: {original: reason, en: rule.findingEn},
              observedAt: evaluation.createdAt,
              authority: 'agent',
              attachmentReview: 'required',
            },
          ],
          entries: [
            {
              id: 'feedback-' + evaluation.id,
              kind: 'observation',
              title: {en: 'Workspace rule proposal', ja: '組織ルールの変更案'},
              claim,
              sourceIds: [evaluation.id],
              confidence: 'low',
              proposedOntologyChange: {
                document: rule.document,
                ruleId: rule.ruleId,
                basis: 'inferred',
                statement: claim,
              },
            },
          ],
        },
      })
      return {...receipt, status: 'knowledge_proposed', proposal}
    }
    if (graphId && graphArtifactId) {
      const proposal = await client.v2.prepareWorkspaceSkillProposal({
        graphId,
        artifactId: graphArtifactId,
        projectId: canvasId,
        taskKind,
      })
      return {...receipt, status: proposal.status, proposal}
    }
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    error.message = `Feedback recorded as ${evaluation.id}. Proposal step failed: ${error.message}. Retry uncertain responses with the original operation ID and payload.`
    throw error
  }
  return {
    ...receipt,
    status: destination === 'case' ? 'recorded' : 'handoff_recorded',
  }
}

interface PublishedCatalog {
  pin: {revisionId: string}
  catalog: {
    audience: string
    workspaceId?: string
    documents: {path: string; content: string}[]
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

interface FeedbackOrder {
  orderId: string
  meshReview?: {pins?: {workspace?: {revisionId: string}}} | null
  requirementGraph?: {
    schema: string
    meshArtifactId: string
    reportArtifactId: string
    planningKnowledgeRecorded?: boolean
    planningKnowledge: {
      entryId: string
      method: string
      workspaceRevisionId: string
      evaluationId: string | null
    }[]
    requirements: {
      id: string
      specifiedBy: {document?: string; ruleId: string}
      state: string
      assertions: {
        requirementId: string
        partId: string
        measured: number | null
        verdict: string
      }[]
      reviewerFindings: {
        decisionArtifactId: string
        reviewerId: string | null
        decidedAt: string | null
        requirementId: string
        accepted: boolean
      }[]
    }[]
  } | null
}

/** Read one authorized evaluation and only the currently published workspace revision. */
export async function traceProductionFeedback(
  client: AssetHubClient,
  evaluationId: string,
  orderId?: string,
) {
  if (!uuid.test(evaluationId)) throw new Error('Invalid evaluation ID')
  if (orderId !== undefined && !uuid.test(orderId)) throw new Error('Invalid order ID')
  const evaluation = await client.v2.getEvaluation(evaluationId)
  const receipt = {
    evaluationId: evaluation.id,
    canvasId: evaluation.canvasId,
    runId: evaluation.runId,
    artifactId: evaluation.artifactId,
  }
  const {ownerId} = await client.v2.getCapabilities()
  const order = orderId
    ? (
        await client.request<FeedbackOrder>(
          'v2',
          '/production/ontology-orders/' + orderId + '?include=requirements',
          {method: 'GET'},
        )
      ).data
    : null
  const pinned = order?.meshReview?.pins?.workspace?.revisionId
  if (orderId && (order?.orderId !== orderId || !pinned))
    throw new Error('This order has no verified workspace mesh review pin')
  const {
    data: {catalog, pin},
  } = await client.request<PublishedCatalog>(
    'v2',
    pinned
      ? '/ontology/revisions/' + encodeURIComponent(pinned)
      : '/ontology/catalog',
    {method: 'GET'},
  )
  if (pinned && pin.revisionId !== pinned)
    throw new Error('Order catalog revision mismatch')
  if (catalog.audience !== 'workspace' || catalog.workspaceId !== ownerId)
    throw new Error(
      'A published catalog in the authenticated workspace is required',
    )
  const doc = catalog.documents.find(d => d.path === 'knowledge-base.json')
  const published = {...receipt, revisionId: pin.revisionId}
  const kb: unknown = doc ? JSON.parse(doc.content) : {sources: [], entries: []}
  if (!isRecord(kb) || !Array.isArray(kb.sources) || !Array.isArray(kb.entries))
    throw new Error('Invalid published knowledge document')
  const sourceUrl = evaluationUrl(client, evaluation.id)
  const sourceIds = new Set(
    kb.sources
      .filter(isRecord)
      .filter(
        source =>
          source.kind === 'run' &&
          source.externalId === evaluation.id &&
          source.url === sourceUrl,
      )
      .map(source => source.id),
  )
  const entries = kb.entries
    .filter(isRecord)
    .filter(
      entry =>
        Array.isArray(entry.sourceIds) &&
        entry.sourceIds.some(id => sourceIds.has(id)),
    )

  const graph = order?.requirementGraph
  const links = (graph?.planningKnowledge ?? []).filter(
    link =>
      link.evaluationId === evaluation.id &&
      link.workspaceRevisionId === pinned &&
      entries.some(
        entry =>
          entry.id === link.entryId &&
          entry.status === 'approved' &&
          isRecord(entry.review) &&
          entry.review.sharedMethod === link.method,
      ),
  )
  const selectedEntries = entries.filter(entry => links.some(link => link.entryId === entry.id))
  return {
    ...published,
    ...(order
      ? {
          order: {
            id: orderId,
            meshArtifactId: graph?.meshArtifactId ?? null,
            reportArtifactId: graph?.reportArtifactId ?? null,
            planningKnowledgeRecorded: graph?.planningKnowledgeRecorded === true && Array.isArray(graph.planningKnowledge),
            selectedMethods: links,
            requirements: (graph?.requirements ?? [])
              .filter(rule => selectedEntries.some(entry => {
                const proposal = entry.proposedOntologyChange
                if (isRecord(proposal))
                  return typeof proposal.document === 'string' && proposal.document === rule.specifiedBy.document &&
                    proposal.ruleId === rule.specifiedBy.ruleId
                return Array.isArray(entry.ontologyRuleIds) && entry.ontologyRuleIds.includes(rule.specifiedBy.ruleId)
              }))
              .map(rule => ({
                id: rule.id,
                state: rule.state,
                assertions: rule.assertions,
                reviewerFindings: rule.reviewerFindings,
              })),
          },
        }
      : {}),
    decisions: entries.map(entry => ({
      entryId: entry.id,
      status: entry.status,
      reviewerId: isRecord(entry.review) ? entry.review.userId : null,
      reviewedAt: isRecord(entry.review) ? entry.review.at : null,
    })),
  }
}
