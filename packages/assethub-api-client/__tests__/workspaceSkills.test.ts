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
