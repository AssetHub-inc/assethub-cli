// packages/assethub-cli/src/meshReview/runEngine.ts
import {spawn} from 'node:child_process'
import {access, mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join, resolve} from 'node:path'

const defaultExists = async (path: string): Promise<boolean> => access(path).then(() => true, () => false)

/**
 * The engine lives in the monorepo (`tools/mesh-review/`), not in the published npm package.
 * Order: --engine-dir, MESH_REVIEW_ENGINE_DIR, then walk up from cwd looking for tools/mesh-review/cli.py.
 */
export const findEngineCli = async ({
  engineDir,
  cwd,
  env,
  exists = defaultExists,
}: {
  engineDir: string | undefined
  cwd: string
  env: Record<string, string | undefined>
  exists?: (path: string) => Promise<boolean>
}): Promise<string | null> => {
  const explicit = engineDir ?? env.MESH_REVIEW_ENGINE_DIR
  if (explicit != null && explicit !== '') {
    const candidate = join(resolve(cwd, explicit), 'cli.py')
    return (await exists(candidate)) ? candidate : null
  }
  let current = resolve(cwd)
  for (;;) {
    const candidate = join(current, 'tools', 'mesh-review', 'cli.py')
    if (await exists(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export const buildEngineCommand = (o: {
  python: string
  cliPath: string
  inputs: string[]
  out: string
  baseline: string | undefined
  config: string | undefined
  skipHp: boolean
  noRender: boolean
  reference?: string | undefined
  noConcept?: string | undefined
}): {command: string; args: string[]} => ({
  command: o.python,
  args: [
    o.cliPath,
    ...o.inputs,
    '--out',
    o.out,
    ...(o.baseline != null ? ['--baseline', o.baseline] : []),
    ...(o.config != null ? ['--config', o.config] : []),
    ...(o.skipHp ? ['--skip-hp'] : []),
    ...(o.noRender ? ['--no-render'] : []),
    ...(o.reference != null ? ['--reference', o.reference] : []),
    ...(o.noConcept != null ? ['--no-concept', o.noConcept] : []),
  ],
})

export type RunEngineOptions = {
  cliPath: string
  inputs: string[]
  out: string | undefined
  baseline: string | undefined
  config: string | undefined
  skipHp: boolean
  noRender: boolean
  reference?: string | undefined
  noConcept?: string | undefined
  env?: Record<string, string | undefined>
}

/**
 * Runs the engine's own `cli.py`, which locates Blender (`MESH_REVIEW_BLENDER`, then
 * `/Applications/Blender.app/Contents/MacOS/Blender`, then `blender` on PATH) and runs it
 * headless. Engine output goes to stderr so stdout stays a single JSON result.
 */
export const runEngine = async (
  options: RunEngineOptions,
  spawnImpl: typeof spawn = spawn,
): Promise<{exitCode: number; findingsPath: string}> => {
  const out = options.out ?? (await mkdtemp(join(tmpdir(), 'mesh-review-')))
  const env = options.env ?? process.env
  const {command, args} = buildEngineCommand({
    python: env.MESH_REVIEW_PYTHON ?? 'python3',
    cliPath: options.cliPath,
    inputs: options.inputs,
    out,
    baseline: options.baseline,
    config: options.config,
    skipHp: options.skipHp,
    noRender: options.noRender,
    reference: options.reference,
    noConcept: options.noConcept,
  })
  const exitCode = await new Promise<number>(resolveExit => {
    const child = spawnImpl(command, args, {stdio: ['ignore', 2, 2], env: env as NodeJS.ProcessEnv})
    child.on('error', () => resolveExit(2))
    child.on('close', code => resolveExit(code ?? 2))
  })
  return {exitCode, findingsPath: join(out, 'findings.json')}
}
