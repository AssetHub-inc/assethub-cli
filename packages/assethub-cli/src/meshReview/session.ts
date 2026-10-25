import {createHash, randomUUID} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import {homedir} from 'node:os'
import {dirname, join, resolve, sep} from 'node:path'
import type {MeshReviewRunArgs} from './args.js'
import {acquireMeshReviewLock} from './sessionLock.js'
import {meshReviewCall, MESH_REVIEW_API_PREFIX} from './syncMeshReview.js'

export const MESH_REVIEW_SESSION_FILE = 'mesh-review-session.json'
export type MeshReviewSession = {
  out: string
  runId: string
  clientRunKey: string
  status: string
  findingsPath?: string
  fail: () => Promise<void>
  release?: () => Promise<void>
}
type Auth = {baseUrl: string; apiKey: string; workspaceId?: string | undefined}
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex')
export const meshReviewCredentialScope = (auth: Auth) =>
  auth.workspaceId
    ? `workspace:${auth.workspaceId}`
    : `key:${sha256(auth.apiKey)}`

const hashFile = async (file: string): Promise<string> => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
const inside = (path: string, directory: string) =>
  path === directory || path.startsWith(`${directory}${sep}`)

const fingerprint = async (
  args: MeshReviewRunArgs,
  cliPath: string,
  out?: string,
): Promise<string> => {
  const files = new Set<string>()
  const visit = async (raw: string): Promise<void> => {
    const path = resolve(raw)
    if (out && inside(path, out)) return
    const info = await lstat(path)
    if (info.isSymbolicLink())
      throw new Error(
        `Symbolic review inputs are not supported: ${path}. Use an immutable copied file.`,
      )
    if (info.isDirectory()) {
      for (const entry of await readdir(path, {withFileTypes: true})) {
        if (!entry.name.startsWith('.') && entry.name !== '__pycache__')
          await visit(join(path, entry.name))
      }
    } else if (info.isFile()) {
      files.add(path)
      if (files.size > 5000) throw new Error('Review input exceeds 5000 files.')
    }
  }
  const references = args.reference?.split(',').map(path => resolve(path)) ?? []
  const roles = {
    inputs: args.inputs.map(path => resolve(path)),
    references,
    baseline: args.baseline ? resolve(args.baseline) : null,
    config: args.config ? resolve(args.config) : null,
    cliPath: resolve(cliPath),
  }
  for (const path of [
    ...roles.inputs,
    ...references,
    roles.baseline,
    roles.config,
    roles.cliPath,
  ]) {
    if (path && out && inside(path, out))
      throw new Error(
        'The review output directory must not contain its input, reference, configuration or engine files.',
      )
  }
  for (const input of [
    ...roles.inputs,
    dirname(cliPath),
    roles.baseline,
    roles.config,
    ...references,
  ])
    if (input) await visit(input)
  const hashes: Array<[string, string]> = []
  for (const path of [...files].sort())
    hashes.push([path, await hashFile(path)])
  return sha256(
    JSON.stringify({
      roles,
      files: hashes,
      phase: args.phase,
      skipHp: args.skipHp,
      noRender: args.noRender,
      noConcept: args.noConcept,
    }),
  )
}

export const prepareMeshReviewSession = async ({
  args,
  auth,
  cliPath,
  fetchImpl = fetch,
}: {
  args: MeshReviewRunArgs
  auth: Auth
  cliPath: string
  fetchImpl?: typeof fetch
}): Promise<MeshReviewSession> => {
  const requestHash = await fingerprint(
    args,
    cliPath,
    args.out ? resolve(args.out) : undefined,
  )
  const identity = {
    baseUrl: auth.baseUrl.replace(/\/+$/, ''),
    workspaceId: auth.workspaceId ?? null,
    credentialScope: meshReviewCredentialScope(auth),
    project: args.project,
    assetKey: args.assetKey,
    requestHash,
  }
  const out = resolve(
    args.out ??
      join(
        process.env.ASSETHUB_CLI_STATE_DIR ??
          join(homedir(), '.assethub', 'state'),
        'mesh-reviews',
        sha256(JSON.stringify(identity)),
      ),
  )
  await mkdir(out, {recursive: true})
  const release = await acquireMeshReviewLock(out)
  try {
    const path = join(out, MESH_REVIEW_SESSION_FILE)
    const initial = {...identity, clientRunKey: sha256(randomUUID())}
    try {
      await writeFile(path, JSON.stringify(initial, null, 2), {
        flag: 'wx',
        mode: 0o600,
      })
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'EEXIST')
      )
        throw error
    }
    const state: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (
      !state ||
      typeof state !== 'object' ||
      !('clientRunKey' in state) ||
      typeof state.clientRunKey !== 'string' ||
      !/^[a-f0-9]{64}$/.test(state.clientRunKey)
    )
      throw new Error(
        'Invalid review session. Use a different output directory.',
      )
    const stored = state as Record<string, unknown> & {clientRunKey: string}
    if (Object.entries(identity).some(([key, value]) => stored[key] !== value))
      throw new Error(
        'Review inputs, options or workspace changed. Use a different output directory for a new run.',
      )
    const headers = {
      authorization: `Bearer ${auth.apiKey}`,
      'content-type': 'application/json',
      ...(auth.workspaceId ? {'x-assethub-workspace': auth.workspaceId} : {}),
    }
    const base = `${identity.baseUrl}${MESH_REVIEW_API_PREFIX}`
    const response = await meshReviewCall(fetchImpl, `${base}/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        project: args.project,
        assetKey: args.assetKey,
        source: 'local',
        clientRunKey: stored.clientRunKey,
        renders: [],
      }),
    })
    const run = response.data as {runId: string; status: string}
    await writeFile(
      path,
      JSON.stringify({...stored, runId: run.runId}, null, 2),
      {mode: 0o600},
    )
    const findings = join(out, 'findings.json')
    return {
      out,
      runId: run.runId,
      clientRunKey: stored.clientRunKey,
      status: run.status,
      ...((await stat(findings).catch(() => null))?.isFile()
        ? {findingsPath: findings}
        : {}),
      release,
      fail: async () => {
        await meshReviewCall(
          fetchImpl,
          `${base}/runs/${encodeURIComponent(run.runId)}/fail`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              errorMessage:
                'The local review engine failed or was interrupted. Check the CLI logs, fix the input or Blender error, and start a new review.',
            }),
          },
        )
      },
    }
  } catch (error) {
    await release()
    throw error
  }
}
