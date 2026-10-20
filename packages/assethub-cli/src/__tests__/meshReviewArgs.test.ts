// meshReviewArgs.test.ts
import {describe, expect, it} from 'vitest'
import {parseMeshReviewArgs} from '../meshReview/args.js'

const flags = (entries: Record<string, string | boolean | string[]>) => entries as never

describe('parseMeshReviewArgs', () => {
  it('parses run with defaults, deriving the asset key from the first input', () => {
    const args = parseMeshReviewArgs('run', ['mesh-review', 'run', '/d/Axe Blade'], flags({project: 'Axe'}))
    expect(args).toMatchObject({mode: 'run', inputs: ['/d/Axe Blade'], project: 'Axe', assetKey: 'Axe_Blade', skipHp: false, noSync: false})
  })
  it('requires --project unless --no-sync or --dry-run', () => {
    expect(() => parseMeshReviewArgs('run', ['mesh-review', 'run', '/d/a'], flags({}))).toThrow(/--project/)
    expect(parseMeshReviewArgs('run', ['mesh-review', 'run', '/d/a'], flags({'no-sync': true}))).toMatchObject({noSync: true})
  })
  it('parses sync', () => {
    const args = parseMeshReviewArgs('sync', ['mesh-review', 'sync', '/o/axe/findings.json'], flags({project: 'Axe', asset: 'axe'}))
    expect(args).toEqual({mode: 'sync', findingsPath: '/o/axe/findings.json', project: 'Axe', assetKey: 'axe', dryRun: false})
  })
  it('rejects unknown subcommands, missing paths and bad asset keys', () => {
    expect(() => parseMeshReviewArgs('watch', ['mesh-review', 'watch'], flags({}))).toThrow(/Unknown mesh-review command/)
    expect(() => parseMeshReviewArgs('run', ['mesh-review', 'run'], flags({project: 'x'}))).toThrow(/folder/)
    expect(() => parseMeshReviewArgs('sync', ['mesh-review', 'sync', 'f.json'], flags({project: 'x', asset: '../x'}))).toThrow(/asset/)
  })
})

describe('parseMeshReviewArgs concept comparison flags', () => {
  const run = (f: Record<string, string | boolean | string[]>) => parseMeshReviewArgs('run', ['mesh-review', 'run', '/d/a'], flags({project: 'p', ...f}))
  it('defaults to neither flag (the engine discovers a reference or fails)', () => {
    expect(run({})).toMatchObject({reference: undefined, noConcept: undefined})
  })
  it('accepts up to three comma separated references, or a repeated flag', () => {
    expect(run({reference: '/c/front.png,/c/side.png'})).toMatchObject({reference: '/c/front.png,/c/side.png'})
    expect(run({reference: ['/c/f.png', '/c/s.png']})).toMatchObject({reference: '/c/f.png,/c/s.png'})
    expect(() => run({reference: '/a.png,/b.png,/c.png,/d.png'})).toThrow(/at most 3/)
    expect(() => run({reference: true})).toThrow(/--reference/)
    expect(() => run({reference: ' , '})).toThrow(/--reference/)
  })
  it('--no-concept needs a real reason and excludes --reference', () => {
    expect(run({'no-concept': 'No approved art exists for this prop'})).toMatchObject({noConcept: 'No approved art exists for this prop'})
    expect(() => run({'no-concept': true})).toThrow(/reason/)
    expect(() => run({'no-concept': '   '})).toThrow(/reason/)
    expect(() => run({'no-concept': 'x', reference: '/c/f.png'})).toThrow(/either/)
  })
})
