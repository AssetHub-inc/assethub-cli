import {execFile} from 'node:child_process'
import {mkdtemp, rm, symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {promisify} from 'node:util'
import {expect, it} from 'vitest'

it('starts through an installed bin symlink', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'assethub-bin-'))
  try {
    const bin = join(directory, 'assethub')
    await symlink(resolve('packages/assethub-cli/dist/index.js'), bin)
    const {stdout} = await promisify(execFile)(process.execPath, [bin, '--help'])
    expect(stdout).toContain('AssetHub CLI')
    expect(stdout).toContain('assethub capabilities')
  } finally {
    await rm(directory, {recursive: true, force: true})
  }
})
