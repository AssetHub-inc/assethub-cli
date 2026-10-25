// meshReviewEngine.test.ts
import {describe, expect, it} from 'vitest'
import {buildEngineCommand, findEngineCli} from '../meshReview/runEngine.js'

describe('findEngineCli', () => {
  const exists = (set: string[]) => async (p: string) => set.includes(p)
  it('prefers --engine-dir, then the env var, then walks up from cwd', async () => {
    expect(await findEngineCli({engineDir: '/e', cwd: '/w', env: {}, exists: exists(['/e/cli.py'])})).toBe('/e/cli.py')
    expect(await findEngineCli({engineDir: undefined, cwd: '/w', env: {MESH_REVIEW_ENGINE_DIR: '/v'}, exists: exists(['/v/cli.py'])})).toBe('/v/cli.py')
    expect(await findEngineCli({engineDir: undefined, cwd: '/repo/apps/x', env: {}, exists: exists(['/repo/tools/mesh-review/cli.py'])})).toBe('/repo/tools/mesh-review/cli.py')
  })
  it('returns null when nothing is found', async () => {
    expect(await findEngineCli({engineDir: undefined, cwd: '/w', env: {}, exists: exists([])})).toBeNull()
  })
})

describe('buildEngineCommand concept flags', () => {
  const base = {python: 'python3', cliPath: '/r/cli.py', inputs: ['/d/a'], out: '/o', baseline: undefined, config: undefined, skipHp: false, noRender: false}
  it('passes --reference and --no-concept through to the engine', () => {
    expect(buildEngineCommand({...base, reference: '/c/f.png,/c/s.png', noConcept: undefined}).args).toEqual(['/r/cli.py', '/d/a', '--out', '/o', '--reference', '/c/f.png,/c/s.png'])
    expect(buildEngineCommand({...base, reference: undefined, noConcept: 'no art yet'}).args).toEqual(['/r/cli.py', '/d/a', '--out', '/o', '--no-concept', 'no art yet'])
    expect(buildEngineCommand({...base, reference: undefined, noConcept: undefined}).args).toEqual(['/r/cli.py', '/d/a', '--out', '/o'])
  })
})

describe('buildEngineCommand', () => {
  it('builds the engine cli invocation with optional flags', () => {
    const cmd = buildEngineCommand({
      python: 'python3', cliPath: '/r/tools/mesh-review/cli.py', inputs: ['/d/a'], out: '/o',
      baseline: '/b/findings.json', config: undefined, skipHp: true, noRender: false, reference: undefined, noConcept: undefined,
    })
    expect(cmd.command).toBe('python3')
    expect(cmd.args).toEqual(['/r/tools/mesh-review/cli.py', '/d/a', '--out', '/o', '--baseline', '/b/findings.json', '--skip-hp'])
  })
})

it('forwards an explicit HP phase without changing the default command', () => {
  const cmd = buildEngineCommand({python: 'python3', cliPath: '/r/cli.py', inputs: ['/delivery'], out: '/out', baseline: undefined, config: undefined, skipHp: false, noRender: false, phase: 'high_poly'})
  expect(cmd.args).toEqual(['/r/cli.py', '/delivery', '--out', '/out', '--phase', 'high_poly'])
})
