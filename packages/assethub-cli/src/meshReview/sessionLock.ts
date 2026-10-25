import {randomUUID} from 'node:crypto'
import {mkdir, readFile, rm, rmdir, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

export const acquireMeshReviewLock = async (
  out: string,
): Promise<() => Promise<void>> => {
  const path = join(out, '.mesh-review-lock')
  try {
    await mkdir(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(
        `A review owns ${out}. Do not start a second engine. If the CLI was killed, inspect the local Blender processes before removing ${path} and resuming.`,
      )
    }
    throw error
  }
  const token = randomUUID()
  // shortcut: hard-killed owners require inspection before lock removal; use a supervised lease for remote execution.
  await writeFile(
    join(path, 'owner.json'),
    JSON.stringify({pid: process.pid, token}),
    {mode: 0o600},
  )
  return async () => {
    const owner: {token?: string} = await readFile(
      join(path, 'owner.json'),
      'utf8',
    ).then(JSON.parse, () => ({}))
    if (owner.token === token) {
      await rm(join(path, 'owner.json'))
      await rmdir(path)
    }
  }
}
