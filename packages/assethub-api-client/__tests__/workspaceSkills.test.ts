import {beforeEach, expect, it, vi} from 'vitest'
import {createAssetHubClient} from '../src/index.js'

const fetchMock = vi.fn<typeof fetch>()
const ok = (data: unknown) =>
  new Response(JSON.stringify({success: true, data}), {
    status: 200,
    headers: {'content-type': 'application/json'},
  })

beforeEach(() => fetchMock.mockReset())

it('registers and reuses a workspace skill through the typed v2 client', async () => {
  const skillId = 'validated-method'
  fetchMock
    .mockResolvedValueOnce(
      ok({
        graphId: '11111111-1111-4111-8111-111111111111',
        rootArtifactId: 'learn',
        skillId,
      }),
    )
    .mockResolvedValueOnce(
      ok({items: [{skillId, revision: 1}], nextCursor: null, canEdit: true}),
    )
    .mockResolvedValueOnce(
      ok({skill: {skillId, revision: 1}, mode: 'automatic'}),
    )

  const client = createAssetHubClient({
    apiKey: 'ah_pat_test',
    baseUrl: 'https://api.test',
    fetch: fetchMock,
  })
  await client.v2.learnWorkspaceSkill(
    {
      graphId: '11111111-1111-4111-8111-111111111111',
      phase: 'generate',
      evidenceRefs: [
        {
          graphId: '11111111-1111-4111-8111-111111111111',
          artifactId: 'result',
          contentSha256: 'a'.repeat(64),
          sourceRevision: 2,
        },
      ],
      purpose: 'generation',
    },
    {idempotencyKey: '33333333-3333-4333-8333-333333333333'},
  )
  await client.v2.listWorkspaceSkills()
  await client.v2.getWorkspaceSkill(skillId)

  expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
    'https://api.test/api/v2/workspace-skills/learn',
    'https://api.test/api/v2/workspace-skills',
    'https://api.test/api/v2/workspace-skills/validated-method',
  ])
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
    method: 'POST',
    headers: expect.objectContaining({
      'Idempotency-Key': '33333333-3333-4333-8333-333333333333',
    }),
  })
})

it('sends optimistic revisions for updates and controls', async () => {
  fetchMock.mockImplementation(async () =>
    ok({skill: {skillId: 'method', revision: 3}}),
  )
  const client = createAssetHubClient({
    apiKey: 'key',
    baseUrl: 'https://api.test',
    fetch: fetchMock,
  })
  await client.v2.updateWorkspaceSkill('method', {
    expectedRevision: 2,
    expectedGrantRevision: 1,
    title: 'Method',
    goal: 'Do it',
    applicability: {
      category: 'character',
      partKinds: [],
      requiredTraits: [],
      issueKinds: [],
      exclusions: [],
      requiredReferenceRoles: [],
    },
    steps: [],
  })
  await client.v2.setWorkspaceSkillControls('method', {
    expectedRevision: 3,
    expectedGrantRevision: 1,
    mode: 'off',
  })

  expect(
    fetchMock.mock.calls.map(call => JSON.parse(String(call[1]?.body))),
  ).toEqual([
    expect.objectContaining({expectedRevision: 2}),
    {expectedRevision: 3, expectedGrantRevision: 1, mode: 'off'},
  ])
  expect(fetchMock.mock.calls.map(call => call[1]?.method)).toEqual([
    'PATCH',
    'PATCH',
  ])
})

it('returns the durable source needed to resume proposal preparation after archive lag', async () => {
  const source = {
    graphId: '11111111-1111-4111-8111-111111111111',
    artifactId: 'native-result',
    taskKind: 'concept_art' as const,
    projectId: 42,
  }
  fetchMock.mockResolvedValue(ok({status: 'waiting_for_archive', source}))
  const client = createAssetHubClient({
    apiKey: 'key',
    baseUrl: 'https://api.test',
    fetch: fetchMock,
  })
  const result = await client.v2.prepareWorkspaceSkillProposal(source)
  expect(result).toEqual({status: 'waiting_for_archive', source})
  if (result.status === 'waiting_for_archive')
    expect(result.source.projectId).toBe(42)
})

it('task4 typed review client sends only output/canvas locators and header identity', async () => {
  const review = {
    outputAssetId: 'image:one',
    status: 'pending',
    canResume: true,
    canCancel: true,
    usage: {
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      cost: null,
    },
  }
  fetchMock.mockImplementation(async () => ok(review))

  const client = createAssetHubClient({
    apiKey: 'ah_pat_test',
    baseUrl: 'https://api.test',
    fetch: fetchMock,
  })
  expect(await client.v2.getWorkspaceSkillReview('image:one', 42)).toEqual(
    review,
  )
  await client.v2.resumeWorkspaceSkillReview('image:one', 42, {
    idempotencyKey: '11111111-1111-4111-8111-111111111111',
  })
  await client.v2.cancelWorkspaceSkillReview('image:one', 42, {
    idempotencyKey: '22222222-2222-4222-8222-222222222222',
  })
  expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
    'https://api.test/api/v2/workspace-skills/reviews/image%3Aone?canvasId=42',
    'https://api.test/api/v2/workspace-skills/reviews/image%3Aone',
    'https://api.test/api/v2/workspace-skills/reviews/image%3Aone/cancel',
  ])
  expect(
    fetchMock.mock.calls
      .slice(1)
      .map(call => JSON.parse(String(call[1]?.body))),
  ).toEqual([{canvasId: 42}, {canvasId: 42}])
  expect(
    new Headers(fetchMock.mock.calls[1][1]?.headers).get('Idempotency-Key'),
  ).toBe('11111111-1111-4111-8111-111111111111')
})

it('validates a draft, reads the draft schema, and dry-runs a build over the typed v2 client', async () => {
  fetchMock
    .mockResolvedValueOnce(ok({valid: true, contentSha256: 'a'.repeat(64), referencesChecked: true}))
    .mockResolvedValueOnce(
      ok({
        promptVersion: 3,
        shape: 'Skill fields...',
        stampedFields: ['build'],
        enums: {phases: ['plan'], operations: ['plan'], roles: ['source_image'], severities: ['must']},
        limits: {
          steps: {min: 1, max: 5},
          acceptanceCriteria: {min: 1, max: 12},
          failureModes: {min: 0, max: 12},
          references: {min: 1, max: 13},
          uncertainties: {min: 0, max: 16},
        },
      }),
    )
    .mockResolvedValueOnce(
      ok({
        wouldStart: true,
        source: 'canvas_graph',
        canvasIds: [40516],
        estimatedCredits: 60,
        promptVersion: 3,
      }),
    )

  const client = createAssetHubClient({
    apiKey: 'ah_pat_test',
    baseUrl: 'https://api.test',
    fetch: fetchMock,
  })

  const validated = await client.v2.validateWorkspaceSkillDraft({
    skill: {phase: 'plan'},
    buildId: '9c31f0aa-1111-4111-8111-111111111111',
  })
  expect(validated).toMatchObject({valid: true})

  const schema = await client.v2.getWorkspaceSkillDraftSchema()
  expect(schema.limits.references).toEqual({min: 1, max: 13})

  const dryRun = await client.v2.dryRunWorkspaceSkillBuild({
    goal: 'Separate a Pluffy outfit into parts',
    taskKind: 'part_separation',
    source: {kind: 'canvas_graph', canvasIds: [40516]},
  })
  expect(dryRun).toMatchObject({wouldStart: true, estimatedCredits: 60})

  expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
    'https://api.test/api/v2/workspace-skills/drafts/validate',
    'https://api.test/api/v2/workspace-skills/drafts/schema',
    'https://api.test/api/v2/workspace-skills/builds/dry-run',
  ])
  expect(fetchMock.mock.calls.map(call => call[1]?.method)).toEqual([
    'POST',
    'GET',
    'POST',
  ])
  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
    skill: {phase: 'plan'},
    buildId: '9c31f0aa-1111-4111-8111-111111111111',
  })
})
