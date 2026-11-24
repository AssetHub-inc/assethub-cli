import {createAssetHubClient} from '@assethub/api-client'
import {expect, it, vi} from 'vitest'
import {submitProductionFeedback} from '../productionFeedback.js'

const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const feedback = {
  workspaceId: 'team',
  canvasId: 42,
  artifactId: 'mesh',
  runId: id,
  evidenceAssetId: 'report',
  finding: 'Missing rim check',
  requestedChange: 'Measure the rim',
}
const rule = {
  destination: 'workspace-rule',
  baseRevisionId: 'r1',
  expectedVersion: '2026-11-01T00:00:00Z',
  document: 'geometry-ontology.json',
  ruleId: 'rim',
  findingEn: 'Missing rim check',
  changeJa: '段差を測定',
  changeEn: 'Measure the rim',
}
function setup(intake = false) {
  const transport = vi.fn<typeof fetch>(async url => {
    const path = new URL(String(url)).pathname
    if (path.endsWith('/openapi'))
      return Response.json({
        paths:
          intake && path.includes('/v2/')
            ? {'/ontology/knowledge/intake': {post: {requestBody: {}}}}
            : {},
      })
    const data = path.endsWith('/capabilities')
      ? {ownerId: 'team'}
      : path.endsWith('/submissions')
        ? {id, createdAt: rule.expectedVersion}
        : path.endsWith('/proposals')
          ? {status: 'waiting_for_archive'}
          : path.endsWith('/intake')
            ? {revisionId: 'draft'}
            : undefined
    if (!data) throw new Error('Unexpected request ' + path)
    return Response.json({success: true, data})
  })
  return {
    client: createAssetHubClient({
      apiKey: 'test',
      baseUrl: 'https://api.test',
      fetch: transport,
    }),
    transport,
  }
}

// @testdoc A different authenticated workspace stops the submission before a write.
it('rejects another workspace', async () => {
  const {client, transport} = setup()
  await expect(
    submitProductionFeedback(
      client,
      {...feedback, destination: 'case', workspaceId: 'other'},
      id,
    ),
  ).rejects.toThrow(/workspace/)
  expect(transport).toHaveBeenCalledTimes(1)
})

// @testdoc All feedback remains scoped and pending, including engineering and shared-skill handoffs.
it.each(['case', 'executor', 'shared-skill', 'ontology-contract'])(
  'records %s with its evidence and operation identity',
  async destination => {
    const {client, transport} = setup()
    const result = await submitProductionFeedback(
      client,
      {...feedback, destination},
      id,
    )
    expect(result.evaluationId).toBe(id)
    expect(JSON.parse(String(transport.mock.calls[1][1]?.body))).toMatchObject({
      clientOperationId: id,
      canvasId: 42,
      runId: id,
      report: {
        verdict: 'needs_review',
        evidenceAssetIds: ['report'],
        criteria: [{id: destination}],
        suggestedNextAction: 'Measure the rim',
      },
    })
    expect(transport).toHaveBeenCalledTimes(2)
  },
)

// @testdoc Discovery controls knowledge intake and never grants a publication operation.
it.each([true, false])(
  'uses only the advertised draft endpoint (intake %s)',
  async available => {
    const {client, transport} = setup(available)
    const result = await submitProductionFeedback(
      client,
      {...feedback, ...rule},
      id,
    )
    expect(result.status).toBe(
      available ? 'knowledge_proposed' : 'requires_ontology_intake_access',
    )
    if (available)
      expect(
        JSON.parse(String(transport.mock.calls.at(-1)?.[1]?.body)),
      ).toMatchObject({
        sources: [{authority: 'agent', externalId: id}],
        entries: [
          {kind: 'observation', ontologyRuleIds: ['rim'], proposedOntologyChange: {ruleId: 'rim'}},
        ],
      })
    expect(transport).toHaveBeenCalledTimes(available ? 5 : 4)
  },
)

// @testdoc Preparation propagates the native archive status without accepting a skill.
it('returns the actual skill preparation state', async () => {
  const {client} = setup()
  expect(
    (
      await submitProductionFeedback(
        client,
        {
          ...feedback,
          destination: 'workspace-skill',
          graphId: id,
          graphArtifactId: 'graph-image',
        },
        id,
      )
    ).status,
  ).toBe('waiting_for_archive')
})

// @testdoc A failed proposal preserves the evaluation locator for recovery with the same operation identity.
it('identifies a persisted case after a destination error', async () => {
  const {client} = setup()
  vi.spyOn(client.v2, 'prepareWorkspaceSkillProposal').mockRejectedValue(
    new Error('editor required'),
  )
  await expect(
    submitProductionFeedback(
      client,
      {
        ...feedback,
        destination: 'workspace-skill',
        graphId: id,
        graphArtifactId: 'graph-image',
      },
      id,
    ),
  ).rejects.toThrow('Feedback recorded as ' + id)
})

// @testdoc Missing catalog access or an unsupported procedure can still leave a scoped case for follow-up.
it.each([
  ['workspace-rule', 'requires_catalog_context'],
  ['workspace-skill', 'handoff_recorded'],
])(
  'keeps a receipt for %s without destination context',
  async (destination, status) => {
    const {client, transport} = setup()
    expect(
      (await submitProductionFeedback(client, {...feedback, destination}, id))
        .status,
    ).toBe(status)
    expect(transport).toHaveBeenCalledTimes(2)
  },
)

// @testdoc A published decision is returned only for the exact authenticated evaluation source.
it('traces the decision through the published workspace source', async () => {
  const {traceProductionFeedback} = await import('../productionFeedback.js')
  const source = {
    id: 's',
    kind: 'run',
    externalId: id,
    url: 'https://api.test/gateway/api/v2/evaluations/' + id,
  }
  const entry = {
    id: 'entry',
    status: 'rejected',
    sourceIds: ['s'],
    review: {userId: 'reviewer', at: 'recorded-time'},
  }
  const catalog = {
    workspaceId: 'team',
    audience: 'workspace',
    documents: [{path: 'knowledge-base.json', content: ''}],
  }
  const client = createAssetHubClient({
    apiKey: 'test',
    baseUrl: 'https://api.test/gateway',
    fetch: async url => {
      const path = new URL(String(url)).pathname
      const data = path.endsWith('/catalog')
        ? {catalog, pin: {revisionId: 'published'}}
        : path.endsWith('/capabilities')
          ? {ownerId: 'team'}
          : {id, canvasId: 1, runId: id, artifactId: 'mesh'}
      return Response.json({success: true, data})
    },
  })
  catalog.documents[0].content = JSON.stringify({
    sources: [source],
    entries: [entry],
  })
  expect((await traceProductionFeedback(client, id)).decisions).toEqual([
    {
      entryId: 'entry',
      status: 'rejected',
      reviewerId: 'reviewer',
      reviewedAt: 'recorded-time',
    },
  ])
  catalog.documents[0].content = JSON.stringify({
    sources: [{...source, externalId: 'another'}],
    entries: [entry],
  })
  expect((await traceProductionFeedback(client, id)).decisions).toEqual([])
  catalog.workspaceId = 'other'
  await expect(traceProductionFeedback(client, id)).rejects.toThrow(
    /authenticated workspace/,
  )
})

// @testdoc Order evidence must resolve the pinned catalog and its exact approved method before exposing matching rule measurements.
it('joins order evidence against the frozen approval and ignores an unrelated evaluation', async () => {
  const {traceProductionFeedback} = await import('../productionFeedback.js')
  const method = 'compare_views'
  const entry = {
    id: 'feedback-' + id,
    status: 'approved',
    review: {sharedMethod: method},
    sourceIds: ['s'],
    ontologyRuleIds: [],
    proposedOntologyChange: {ruleId: 'rim'},
  }
  const selection = {
    evaluationId: id,
    workspaceRevisionId: 'r1',
    entryId: entry.id,
    method,
  }
  const rule = {
    id: 'rim-check',
    specifiedBy: {ruleId: 'rim'},
    state: 'unverified',
    assertions: [],
    reviewerFindings: [],
  }
  const client = createAssetHubClient({
    apiKey: 'test',
    baseUrl: 'https://api.test',
    fetch: async input => {
      const url = new URL(String(input))
      const source = {
        id: 's',
        kind: 'run',
        externalId: id,
        url: 'https://api.test/api/v2/evaluations/' + id,
      }
      const docs = [
        {
          path: 'knowledge-base.json',
          content: JSON.stringify({sources: [source], entries: [entry]}),
        },
      ]
      const responses: Record<string, unknown> = {
        ['/api/v2/evaluations/' + id]: {
          id,
          canvasId: 42,
          runId: id,
          artifactId: 'before',
        },
        '/api/v2/capabilities': {ownerId: 'team'},
        ['/api/v2/production/ontology-orders/' + id + '?include=requirements']:
          {
            orderId: id,
            meshReview: {pins: {workspace: {revisionId: 'r1'}}},
            requirementGraph: {
              schema: 'assethub.mesh-requirements/v1',
              meshArtifactId: 'after',
              reportArtifactId: 'report',
              planningKnowledge: [selection],
              requirements: [rule],
            },
          },
        '/api/v2/ontology/revisions/r1': {
          catalog: {
            audience: 'workspace',
            workspaceId: 'team',
            documents: docs,
          },
          pin: {revisionId: 'r1'},
        },
      }
      if (!(url.pathname + url.search in responses))
        throw Error('Unexpected endpoint')
      return Response.json({
        success: true,
        data: responses[url.pathname + url.search],
      })
    },
  })
  const found = await traceProductionFeedback(client, id, id)
  expect(found.order?.selectedMethods).toEqual([selection])
  expect(found.order?.requirements).toMatchObject([
    {id: 'rim-check', state: 'unverified'},
  ])
  selection.evaluationId = 'another-evaluation'
  expect((await traceProductionFeedback(client, id, id)).order).toMatchObject({
    selectedMethods: [],
    requirements: [],
  })
})
