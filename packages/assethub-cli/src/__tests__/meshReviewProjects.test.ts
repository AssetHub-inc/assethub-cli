// meshReviewProjects.test.ts
import {describe, expect, it, vi} from 'vitest'
import {parseMeshReviewArgs} from '../meshReview/args.js'
import {runMeshReviewCommand} from '../meshReview/command.js'
import {explainMeshReviewError, formatMeshReviewProjectCreated, formatMeshReviewProjects} from '../meshReview/errors.js'
import {createMeshReviewProject, listMeshReviewProjects} from '../meshReview/projects.js'
import {MeshReviewSyncError} from '../meshReview/syncMeshReview.js'

const ctx = {profile: 'studio', workspaceId: 'ws-123'}
const P1 = {id: '33333333-3333-4333-8333-333333333333', name: 'Axe Project', created_at: '2026-10-15T00:00:01.000Z'}
const P2 = {id: '44444444-4444-4444-8444-444444444444', name: 'Shield', created_at: '2026-10-15T00:00:02.000Z'}
const page = (projects: unknown[], nextCursor: string | null) =>
  new Response(JSON.stringify({success: true, data: {projects, nextCursor}}), {status: 200})

describe('parse projects', () => {
  it('parses mesh-review projects with and without --json', () => {
    expect(parseMeshReviewArgs('projects', ['mesh-review', 'projects'], {})).toEqual({mode: 'projects', json: false})
    expect(parseMeshReviewArgs('projects', ['mesh-review', 'projects'], {json: true})).toEqual({mode: 'projects', json: true})
  })
})

describe('listMeshReviewProjects', () => {
  it('follows nextCursor across pages and sends auth + workspace headers', async () => {
    const calls: Array<{url: string; headers: Record<string, string>}> = []
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({url, headers: init.headers as Record<string, string>})
      return calls.length === 1 ? page([P1], 'CUR') : page([P2], null)
    })
    const out = await listMeshReviewProjects({baseUrl: 'https://app.assethub.io/', apiKey: 'k', workspaceId: 'ws-123', fetchImpl: fetchImpl as never})
    expect(out).toEqual([P1, P2])
    expect(calls[0]?.url).toBe('https://app.assethub.io/api/v2/production/mesh-reviews/projects?limit=100')
    expect(calls[1]?.url).toBe('https://app.assethub.io/api/v2/production/mesh-reviews/projects?limit=100&cursor=CUR')
    expect(calls[0]?.headers).toMatchObject({authorization: 'Bearer k', 'x-assethub-workspace': 'ws-123'})
  })
  it('surfaces the server error code', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({success: false, error: {code: 'MESH_REVIEW_GATE_DISABLED', message: 'off'}}), {status: 404})
    await expect(listMeshReviewProjects({baseUrl: 'https://x', apiKey: 'k', fetchImpl: fetchImpl as never})).rejects.toMatchObject({code: 'MESH_REVIEW_GATE_DISABLED', status: 404})
  })
})

describe('explainMeshReviewError', () => {
  const err = (code: string, status: number, message = 'server text') => new MeshReviewSyncError(code, `${message} (${code}).`, {status})
  it('maps gate-off with profile and workspace', () => {
    const text = explainMeshReviewError(err('MESH_REVIEW_GATE_DISABLED', 404), ctx)
    expect(text).toContain('mesh_review_enabled')
    expect(text).toContain('profile "studio"')
    expect(text).toContain('ws-123')
  })
  it('maps forbidden role', () => {
    const text = explainMeshReviewError(err('MESH_REVIEW_FORBIDDEN_ROLE', 403), ctx)
    expect(text).toMatch(/producer/)
    expect(text).toContain('studio')
  })
  it('maps project-not-found and points at the projects command', () => {
    const text = explainMeshReviewError(err('MESH_REVIEW_PROJECT_NOT_FOUND', 404, 'No project "X" in workspace "Acme"'), ctx)
    expect(text).toContain('No project "X" in workspace "Acme"')
    expect(text).toContain('ws-123')
    expect(text).toContain('assethub mesh-review projects')
  })
  it('maps ambiguous project to using the id', () => {
    expect(explainMeshReviewError(err('PROJECT_AMBIGUOUS', 409), ctx)).toContain('mesh-review projects')
  })
  it('says "default" when no workspace is selected, and leaves other errors untouched', () => {
    expect(explainMeshReviewError(err('MESH_REVIEW_GATE_DISABLED', 404), {profile: 'p'})).toContain('no workspace selected')
    expect(explainMeshReviewError(err('RUN_FINALIZING', 409, 'later'), ctx)).toBe('later (RUN_FINALIZING).')
  })
  it('never prints more than the message, profile and workspace id', () => {
    expect(explainMeshReviewError(err('MESH_REVIEW_GATE_DISABLED', 404), {...ctx})).not.toMatch(/Bearer|ah_/)
  })
})

describe('projects command', () => {
  const deps = (list: ReturnType<typeof vi.fn>) => ({
    auth: {baseUrl: 'https://app.assethub.io', apiKey: 'k', workspaceId: 'ws-123'},
    runEngine: vi.fn(), sync: vi.fn(), findEngineCli: vi.fn(), log: () => {}, listProjects: list,
  })
  it('lists projects of the key workspace', async () => {
    const list = vi.fn(async () => [P1, P2])
    const out = await runMeshReviewCommand({mode: 'projects', json: false}, deps(list) as never)
    expect(out).toEqual({exitCode: 0, result: {projects: [P1, P2]}})
    expect(list).toHaveBeenCalledWith(expect.objectContaining({baseUrl: 'https://app.assethub.io', apiKey: 'k', workspaceId: 'ws-123'}))
  })
  it('formats id + name lines, and a hint when there are none', () => {
    expect(formatMeshReviewProjects([P1, P2])).toBe(`${P1.id}  ${P1.name}\n${P2.id}  ${P2.name}`)
    expect(formatMeshReviewProjects([])).toContain('No projects')
  })
})

describe('projects create', () => {
  it('parses name (multi-word, trimmed) and --json, and rejects a missing or too long name', () => {
    expect(parseMeshReviewArgs('projects', ['mesh-review', 'projects', 'create', 'Axe', 'Set'], {})).toEqual({mode: 'project-create', name: 'Axe Set', json: false})
    expect(parseMeshReviewArgs('projects', ['mesh-review', 'projects', 'create', 'Axe'], {json: true})).toEqual({mode: 'project-create', name: 'Axe', json: true})
    expect(() => parseMeshReviewArgs('projects', ['mesh-review', 'projects', 'create'], {})).toThrow(/needs <name>/)
    expect(() => parseMeshReviewArgs('projects', ['mesh-review', 'projects', 'create', 'x'.repeat(121)], {})).toThrow(/1-120/)
  })
  it('POSTs only the name with auth + workspace headers', async () => {
    const calls: Array<{url: string; init: RequestInit}> = []
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({url, init})
      return new Response(JSON.stringify({success: true, data: {...P1, created: true}}), {status: 201})
    })
    const out = await createMeshReviewProject({baseUrl: 'https://app.assethub.io/', apiKey: 'k', workspaceId: 'ws-123', name: 'Axe Project', fetchImpl: fetchImpl as never})
    expect(out).toEqual({...P1, created: true})
    expect(calls[0]?.url).toBe('https://app.assethub.io/api/v2/production/mesh-reviews/projects')
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.init.body).toBe(JSON.stringify({name: 'Axe Project'}))
    expect(calls[0]?.init.headers).toMatchObject({authorization: 'Bearer k', 'x-assethub-workspace': 'ws-123', 'content-type': 'application/json'})
  })
  it('surfaces the server error code', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({success: false, error: {code: 'MESH_REVIEW_FORBIDDEN_ROLE', message: 'no'}}), {status: 403})
    await expect(createMeshReviewProject({baseUrl: 'https://x', apiKey: 'k', name: 'A', fetchImpl: fetchImpl as never})).rejects.toMatchObject({code: 'MESH_REVIEW_FORBIDDEN_ROLE', status: 403})
  })
  it('runs through the command and formats id + name, marking an existing project', async () => {
    const createProject = vi.fn(async () => ({...P1, created: false}))
    const deps = {auth: {baseUrl: 'https://app.assethub.io', apiKey: 'k', workspaceId: 'ws-123'}, runEngine: vi.fn(), sync: vi.fn(), findEngineCli: vi.fn(), log: () => {}, createProject}
    const out = await runMeshReviewCommand({mode: 'project-create', name: 'Axe Project', json: false}, deps as never)
    expect(out).toEqual({exitCode: 0, result: {project: {...P1, created: false}}})
    expect(createProject).toHaveBeenCalledWith({baseUrl: 'https://app.assethub.io', apiKey: 'k', name: 'Axe Project', workspaceId: 'ws-123'})
    expect(formatMeshReviewProjectCreated({...P1, created: true})).toBe(`${P1.id}  ${P1.name}`)
    expect(formatMeshReviewProjectCreated({...P1, created: false})).toBe(`${P1.id}  ${P1.name}  (already existed)`)
  })
})
