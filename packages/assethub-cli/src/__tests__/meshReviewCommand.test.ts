// meshReviewCommand.test.ts
import {describe, expect, it, vi} from 'vitest'
import {runMeshReviewCommand} from '../meshReview/command.js'

const base = {baseUrl: 'https://app.assethub.io', apiKey: 'k', workspaceId: undefined}

describe('runMeshReviewCommand', () => {
  it('run: engine exit 1 (errors found) still syncs and exits 1', async () => {
    const runEngine = vi.fn(async () => ({exitCode: 1, findingsPath: '/o/findings.json'}))
    const sync = vi.fn(async () => ({runId: 'r', status: 'needs_fix', summary: {error: 1, warn: 0, info: 0}, baselineRunId: null, unchanged: false, rendersUploaded: 2}))
    const out = await runMeshReviewCommand(
      {mode: 'run', inputs: ['/d/a.glb'], project: 'Axe', assetKey: 'a', out: '/o', baseline: undefined, config: undefined, skipHp: false, noRender: false, noSync: false, dryRun: false, engineDir: undefined, reference: '/c/f.png', noConcept: undefined},
      {auth: base, runEngine, sync, findEngineCli: async () => '/r/cli.py', log: () => {}},
    )
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({findingsPath: '/o/findings.json', project: 'Axe', assetKey: 'a'}))
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({previewMeshPath: '/d/a.glb', visualSourceRoots: ['/d/a.glb'], visualExplicitSources: ['/c/f.png']}))
    expect(out.exitCode).toBe(1)
    expect(out.result).toMatchObject({runId: 'r', status: 'needs_fix', reportUrl: 'https://app.assethub.io/control/mesh-reviews/r'})
  })
  it('run: engine exit 2 syncs nothing and exits 2', async () => {
    const sync = vi.fn()
    const out = await runMeshReviewCommand(
      {mode: 'run', inputs: ['/d/a'], project: 'Axe', assetKey: 'a', out: '/o', baseline: undefined, config: undefined, skipHp: false, noRender: false, noSync: false, dryRun: false, engineDir: undefined, reference: undefined, noConcept: undefined},
      {auth: base, runEngine: async () => ({exitCode: 2, findingsPath: '/o/findings.json'}), sync, findEngineCli: async () => '/r/cli.py', log: () => {}},
    )
    expect(sync).not.toHaveBeenCalled()
    expect(out.exitCode).toBe(2)
  })
  it('run: forwards --reference/--no-concept to the engine; exit 2 explains how to supply the concept art', async () => {
    const runEngine = vi.fn(async () => ({exitCode: 2, findingsPath: '/o/findings.json'}))
    const out = await runMeshReviewCommand(
      {mode: 'run', inputs: ['/d/a'], project: 'Axe', assetKey: 'a', out: '/o', baseline: undefined, config: undefined, skipHp: false, noRender: false, noSync: false, dryRun: false, engineDir: undefined, reference: '/c/f.png', noConcept: undefined},
      {auth: base, runEngine, sync: vi.fn(), findEngineCli: async () => '/r/cli.py', log: () => {}},
    )
    expect(runEngine).toHaveBeenCalledWith(expect.objectContaining({reference: '/c/f.png', noConcept: undefined}))
    expect(out.exitCode).toBe(2)
    expect(out.result).toMatchObject({synced: false, hint: expect.stringContaining('--no-concept')})
    const second = await runMeshReviewCommand(
      {mode: 'run', inputs: ['/d/a'], project: undefined, assetKey: 'a', out: '/o', baseline: undefined, config: undefined, skipHp: false, noRender: false, noSync: true, dryRun: false, engineDir: undefined, reference: undefined, noConcept: 'no art'},
      {auth: base, runEngine, sync: vi.fn(), findEngineCli: async () => '/r/cli.py', log: () => {}},
    )
    expect(runEngine).toHaveBeenLastCalledWith(expect.objectContaining({reference: undefined, noConcept: 'no art'}))
    expect(second.exitCode).toBe(2)
  })
  it('run: --no-sync skips the upload; missing engine is a clear error', async () => {
    const sync = vi.fn()
    const noSync = await runMeshReviewCommand(
      {mode: 'run', inputs: ['/d/a'], project: undefined, assetKey: 'a', out: '/o', baseline: undefined, config: undefined, skipHp: false, noRender: false, noSync: true, dryRun: false, engineDir: undefined, reference: undefined, noConcept: undefined},
      {auth: base, runEngine: async () => ({exitCode: 0, findingsPath: '/o/findings.json'}), sync, findEngineCli: async () => '/r/cli.py', log: () => {}},
    )
    expect(sync).not.toHaveBeenCalled()
    expect(noSync.exitCode).toBe(0)
    await expect(
      runMeshReviewCommand(
        {mode: 'run', inputs: ['/d/a'], project: 'p', assetKey: 'a', out: undefined, baseline: undefined, config: undefined, skipHp: false, noRender: false, noSync: false, dryRun: false, engineDir: undefined, reference: undefined, noConcept: undefined},
        {auth: base, runEngine: vi.fn(), sync, findEngineCli: async () => null, log: () => {}},
      ),
    ).rejects.toThrow(/tools\/mesh-review/)
  })
  it('sync: uploads an earlier findings.json; dry-run uploads nothing', async () => {
    const sync = vi.fn(async () => ({runId: 'r', status: 'passed', summary: {error: 0, warn: 0, info: 0}, baselineRunId: null, unchanged: true, rendersUploaded: 0}))
    const out = await runMeshReviewCommand({mode: 'sync', findingsPath: '/o/findings.json', project: 'Axe', assetKey: 'a', dryRun: false, previewVideoPath: '/o/video.mp4'}, {auth: {...base, baseUrl: 'https://app.assethub.io/'}, runEngine: vi.fn(), sync, findEngineCli: async () => null, log: () => {}})
    expect(out.exitCode).toBe(0)
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({previewVideoPath: '/o/video.mp4'}))
    expect(out.result).toMatchObject({reportUrl: 'https://app.assethub.io/control/mesh-reviews/r'})
    const dry = await runMeshReviewCommand({mode: 'sync', findingsPath: '/o/findings.json', project: 'Axe', assetKey: 'a', dryRun: true}, {auth: base, runEngine: vi.fn(), sync, findEngineCli: async () => null, log: () => {}})
    expect(sync).toHaveBeenCalledTimes(1)
    expect(dry.result).toMatchObject({dryRun: true})
  })
})
