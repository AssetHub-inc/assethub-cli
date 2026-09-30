import {beforeEach, expect, it, vi} from 'vitest'
import {createAssetHubClient} from '../src/index.js'

const fetchMock = vi.fn<typeof fetch>()
const ok = (data: unknown) =>
  new Response(JSON.stringify({success: true, data}), {
    status: 200,
    headers: {'content-type': 'application/json'},
  })

beforeEach(() => fetchMock.mockReset())

it('lists, installs and customizes an official workspace skill with an encoded skill id', async () => {
  const skillId = 'assethub.demo:1'
  const list = {
    items: [
      {
        skill: {skillId, revision: 3},
        publisherId: 'assethub',
        releaseId: 'release-1',
        manifestSha256: 'a'.repeat(64),
        sourceSnapshot: {},
        reviewRecord: {},
        installedRevision: 2,
        grantRevision: 1,
        mode: 'automatic',
        updateAvailable: true,
      },
    ],
    canEdit: true,
  }
  const detail = {
    skill: {skillId, revision: 3},
    canEdit: true,
    mode: 'automatic',
    scope: 'artist',
    grantRevision: 1,
    authorId: null,
    officialSkillId: skillId,
    officialRevision: 3,
    publisher: null,
    revisions: [{revision: 3, content_sha256: 'b'.repeat(64)}],
  }
  fetchMock
    .mockResolvedValueOnce(ok(list))
    .mockResolvedValueOnce(ok(detail))
    .mockResolvedValueOnce(ok(detail))

  const client = createAssetHubClient({
    apiKey: 'ah_pat_test',
    baseUrl: 'https://api.test',
    fetch: fetchMock,
  })

  const listResult = await client.v2.listOfficialWorkspaceSkills()
  expect(listResult).toEqual(list)

  const installBody = {
    revision: 3,
    expectedRevision: 2,
    expectedGrantRevision: 1,
    confirmedContentSha256: 'c'.repeat(64),
  }
  const installResult = await client.v2.installOfficialWorkspaceSkill(
    skillId,
    installBody,
  )
  expect(installResult).toEqual(detail)

  const customizeBody = {
    body: {skillId: 'workspace-11111111-1111-4111-8111-111111111111'},
    expectedSourceRevision: 3,
    expectedSourceGrantRevision: 1,
    confirmedContentSha256: 'd'.repeat(64),
  }
  const customizeResult = await client.v2.customizeOfficialWorkspaceSkill(
    skillId,
    customizeBody,
  )
  expect(customizeResult).toEqual(detail)

  expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
    'https://api.test/api/v2/workspace-skills/official',
    'https://api.test/api/v2/workspace-skills/official/assethub.demo%3A1/install',
    'https://api.test/api/v2/workspace-skills/official/assethub.demo%3A1/customize',
  ])
  expect(fetchMock.mock.calls.map(call => call[1]?.method)).toEqual([
    'GET',
    'POST',
    'POST',
  ])
  expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify(installBody))
  expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(
    JSON.stringify(customizeBody),
  )
})

it('prepares an official workspace skill customization with an encoded skill id', async () => {
  const skillId = 'assethub.demo:1'
  const prepareBody = {
    targetSkillId: 'workspace-11111111-1111-4111-8111-111111111111',
    expectedSourceRevision: 3,
    expectedSourceGrantRevision: 1,
    title: 'Customized title',
    goal: 'Customized goal',
    applicability: {
      category: 'part',
      partKinds: [],
      requiredTraits: [],
      issueKinds: [],
      exclusions: [],
      requiredReferenceRoles: [],
    },
    steps: [
      {
        stepId: 'step-1',
        operation: 'generate',
        inputRoles: [],
        dependsOn: [],
        instruction: 'Do the thing.',
        preserve: [],
        checks: [],
      },
    ],
  }
  const prepared = {
    body: {skillId: prepareBody.targetSkillId},
    expectedSourceRevision: 3,
    expectedSourceGrantRevision: 1,
    confirmedContentSha256: 'e'.repeat(64),
  }
  fetchMock.mockResolvedValueOnce(ok(prepared))

  const client = createAssetHubClient({
    apiKey: 'ah_pat_test',
    baseUrl: 'https://api.test',
    fetch: fetchMock,
  })

  const prepareResult =
    await client.v2.prepareOfficialWorkspaceSkillCustomization(
      skillId,
      prepareBody,
    )
  expect(prepareResult).toEqual(prepared)

  expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
    'https://api.test/api/v2/workspace-skills/official/assethub.demo%3A1/customize/prepare',
  )
  expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST')
  expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(prepareBody))
})
