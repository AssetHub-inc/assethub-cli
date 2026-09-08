import {describe, expect, it} from 'vitest'

import {
  parseRunsUploadArgs,
  runsUploadDryRunReport,
  runsUploadSummary,
  type RunsUploadArgs,
} from '../index.js'

const parse = (args: string[], flags: Record<string, string | boolean | string[]> = {}) =>
  parseRunsUploadArgs(args[1], args, flags)

describe('parseRunsUploadArgs', () => {
  it('reads the run folder from the third positional', () => {
    expect(parse(['runs', 'upload', './out/run-a'])).toEqual<RunsUploadArgs>({
      folderPath: './out/run-a',
      graphId: undefined,
      streamId: undefined,
      rev: undefined,
      description: '',
      tags: [],
      dryRun: false,
      skipRegister: false,
    })
  })

  it('rejects an unknown subcommand by naming the one that exists', () => {
    expect(() => parse(['runs', 'download', './out/run-a'])).toThrow(/runs upload <path>/)
    expect(() => parse(['runs', undefined as unknown as string, './x'])).toThrow(
      /runs upload <path>/,
    )
  })

  it('asks for the folder when the path is missing or blank', () => {
    expect(() => parse(['runs', 'upload'])).toThrow(/needs the path to a run folder/)
    expect(() => parse(['runs', 'upload', '   '])).toThrow(/needs the path to a run folder/)
  })

  it('carries the identity overrides through', () => {
    expect(
      parse(['runs', 'upload', './out/run-a'], {
        'graph-id': 'import_custom',
        'stream-id': 'stream_x',
        rev: '7',
        description: 'V3 humanoid',
      }),
    ).toMatchObject({
      graphId: 'import_custom',
      streamId: 'stream_x',
      rev: 7,
      description: 'V3 humanoid',
    })
  })

  // rev 0 is the first revision, not "absent". A positive-integer parser would
  // silently drop it and upload as rev 0 by accident anyway — but only because
  // that happens to be the default.
  it('accepts --rev 0 as a real revision', () => {
    expect(parse(['runs', 'upload', './x'], {rev: '0'}).rev).toBe(0)
  })

  it('rejects a --rev that is not a non-negative integer', () => {
    for (const rev of ['-1', '1.5', 'abc']) {
      expect(() => parse(['runs', 'upload', './x'], {rev})).toThrow(
        /--rev must be a non-negative integer/,
      )
    }
  })

  it('treats a bare --rev with no value as absent rather than NaN', () => {
    expect(parse(['runs', 'upload', './x'], {rev: true}).rev).toBeUndefined()
  })

  it('collects repeated --tag flags', () => {
    expect(parse(['runs', 'upload', './x'], {tag: ['pluffy', 'v3']}).tags).toEqual([
      'pluffy',
      'v3',
    ])
    expect(parse(['runs', 'upload', './x'], {tag: 'pluffy'}).tags).toEqual(['pluffy'])
  })

  it('reads the boolean switches', () => {
    expect(parse(['runs', 'upload', './x'], {'dry-run': true, 'skip-register': true})).toMatchObject(
      {dryRun: true, skipRegister: true},
    )
  })
})

const plan = {
  graphId: 'import_run_a',
  streamId: 'stream_cli_import_run_a',
  rev: 3,
  graphHash: `sha256:${'1'.repeat(64)}`,
  counts: {nodes: 12, edges: 11, blobs: 2, blobBytes: 2048},
  sizes: {manifestBytes: 10, nodesBytes: 20, edgesBytes: 30, pushBytes: 4096},
  blobs: [
    {
      blobKey: `sha256:${'a'.repeat(64)}`,
      sha256: 'a'.repeat(64),
      mime: 'image/png',
      name: 'hero.png',
      size: 1024,
      file: '/tmp/run-a/blobs/hero.png',
    },
    {
      blobKey: `sha256:${'b'.repeat(64)}`,
      sha256: 'b'.repeat(64),
      mime: 'model/gltf-binary',
      name: 'part.glb',
      size: 1024,
      file: '/tmp/run-a/blobs/part.glb',
    },
  ],
  warnings: ['selection was relabelled'],
}

describe('runsUploadSummary / runsUploadDryRunReport', () => {
  it('summarises the plan in human units', () => {
    expect(runsUploadSummary('/tmp/run-a', plan)).toEqual({
      runFolder: '/tmp/run-a',
      graphId: 'import_run_a',
      streamId: 'stream_cli_import_run_a',
      rev: 3,
      graphHash: `sha256:${'1'.repeat(64)}`,
      counts: {nodes: 12, edges: 11, blobs: 2, blobBytes: 2048},
      snapshotSize: '4.0 KiB',
      blobBytes: '2.0 KiB',
    })
  })

  it('says where it would send what, and surfaces the warnings', () => {
    const report = runsUploadDryRunReport(
      runsUploadSummary('/tmp/run-a', plan),
      plan,
      'https://app.assethub.io',
    )

    expect(report.dryRun).toBe(true)
    expect(report.wouldUpload).toBe('2 blob(s) then 1 snapshot to https://app.assethub.io')
    expect(report.warnings).toEqual(['selection was relabelled'])
  })

  // The local file path is deliberately absent: it is out-of-band data for the
  // uploader and printing it as part of the wire preview invites the reader to
  // think it travels.
  it('lists blobs without their on-disk paths', () => {
    const report = runsUploadDryRunReport(
      runsUploadSummary('/tmp/run-a', plan),
      plan,
      'https://app.assethub.io',
    )

    expect(report.blobs).toEqual([
      {blobKey: `sha256:${'a'.repeat(64)}`, name: 'hero.png', mime: 'image/png', size: 1024},
      {
        blobKey: `sha256:${'b'.repeat(64)}`,
        name: 'part.glb',
        mime: 'model/gltf-binary',
        size: 1024,
      },
    ])
    expect(JSON.stringify(report)).not.toContain('/tmp/run-a/blobs')
  })
})
