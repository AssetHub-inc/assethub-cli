import {execFile} from 'node:child_process'
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'

import {expect, test} from 'vitest'

// Removing lazy loading or requiring the unpublished demo package would break
// commands in this installation containing only the two distributable packages.
test('loads standalone project commands and explains the unavailable experimental demo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assethub-standalone-test-'))
  const cliRoot = fileURLToPath(new URL('../../', import.meta.url))
  try {
    for (const name of ['assethub-cli', 'assethub-api-client']) {
      const from = join(cliRoot, '..', name)
      const to = join(
        root,
        'node_modules',
        '@assethub',
        name.replace('assethub-', ''),
      )
      await mkdir(to, {recursive: true})
      await cp(join(from, 'dist'), join(to, 'dist'), {recursive: true})
      await cp(join(from, 'package.json'), join(to, 'package.json'))
    }
    const cli = (...args: string[]) =>
      promisify(execFile)(
        process.execPath,
        [join(root, 'node_modules/@assethub/cli/dist/index.js'), ...args],
        {
          cwd: root,
          env: {
            ...process.env,
            NODE_PATH: undefined,
            ASSETHUB_CLI_STATE_DIR: join(root, 'state'),
          },
        },
      )
    expect((await cli('--help')).stdout).toContain('project ingest')
    await expect(cli('autopilot', '--demo')).rejects.toMatchObject({
      stderr: expect.stringContaining(
        'experimental autopilot demo requires the AssetHub monorepo',
      ),
    })
    const source = join(root, 'source')
    const output = join(root, 'output')
    await mkdir(source)
    await writeFile(
      join(source, 'story.txt'),
      'Background remains an inference.',
    )
    const result = JSON.parse(
      (await cli('project', 'ingest', source, '--out-dir', output)).stdout,
    )
    expect(result.status).toBe('complete')
    expect(
      result.sources.map((entry: {relativePath: string}) => entry.relativePath),
    ).toEqual(['story.txt'])
    expect(await readFile(join(source, 'story.txt'), 'utf8')).toBe(
      'Background remains an inference.',
    )
  } finally {
    await rm(root, {recursive: true, force: true})
  }
}, 30_000)
