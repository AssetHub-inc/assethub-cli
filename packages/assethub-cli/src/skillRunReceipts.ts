// A small local record of every skill run started from this computer, so a new
// session (a closed window, a laptop that slept) can find the run again without
// the operation id the old window printed. Only ids and paths are stored; the
// run itself lives on the server.
import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises'
import {join, resolve} from 'node:path'

export type SkillRunReceipt = {
  schemaVersion: 'assethub.skill-run.v1'
  baseUrl: string
  ownerId: string
  skillId: string
  skillTitle: string
  revision: number
  runId: string
  operationId: string
  canvasId: number
  /** Absolute path of the picture the run started from, when it was a local file. */
  sourceFile?: string
  /** Where results are saved: the original's folder, or --out-dir. */
  outDir?: string
  /** The folder the command ran in. */
  startedIn: string
  startedAt: string
}

const receiptsDir = (stateDir: string) => join(stateDir, 'skill-runs')
const RUN_ID = /^[0-9a-f-]{36}$/i

export const writeSkillRunReceipt = async (
  stateDir: string,
  receipt: SkillRunReceipt,
): Promise<void> => {
  if (!RUN_ID.test(receipt.runId)) throw new Error('Invalid skill run id')
  await mkdir(receiptsDir(stateDir), {recursive: true, mode: 0o700})
  await writeFile(
    join(receiptsDir(stateDir), `${receipt.runId}.json`),
    `${JSON.stringify(receipt, null, 2)}\n`,
    {mode: 0o600},
  )
}

const parse = (text: string): SkillRunReceipt | undefined => {
  try {
    const value = JSON.parse(text) as SkillRunReceipt
    return value?.schemaVersion === 'assethub.skill-run.v1' && RUN_ID.test(value.runId)
      ? value
      : undefined
  } catch {
    return undefined
  }
}

export const readSkillRunReceipt = async (
  stateDir: string,
  runId: string,
): Promise<SkillRunReceipt | undefined> => {
  if (!RUN_ID.test(runId)) return undefined
  return parse(
    await readFile(join(receiptsDir(stateDir), `${runId}.json`), 'utf8').catch(() => ''),
  )
}

/**
 * Receipts for this account and API origin, newest first. By default only runs
 * started in `cwd` or saving into it; `file` narrows to one picture; `all`
 * returns every run on this computer.
 */
export const listSkillRunReceipts = async (
  stateDir: string,
  scope: {baseUrl: string; ownerId: string; cwd: string; file?: string; all?: boolean},
): Promise<SkillRunReceipt[]> => {
  const names = await readdir(receiptsDir(stateDir)).catch(() => [] as string[])
  const receipts = await Promise.all(
    names
      .filter(name => name.endsWith('.json'))
      .map(name => readFile(join(receiptsDir(stateDir), name), 'utf8').then(parse, () => undefined)),
  )
  const cwd = resolve(scope.cwd)
  const file = scope.file ? resolve(scope.file) : undefined
  return receipts
    .filter((receipt): receipt is SkillRunReceipt => receipt !== undefined)
    .filter(receipt => receipt.baseUrl === scope.baseUrl && receipt.ownerId === scope.ownerId)
    .filter(receipt =>
      file
        ? receipt.sourceFile === file
        : scope.all || receipt.startedIn === cwd || receipt.outDir === cwd,
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}
