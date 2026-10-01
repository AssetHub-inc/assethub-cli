// `assethub hooks <subcommand>` — the registration in src/index.ts just calls
// runHooksCommand(argv).

import {installHooks, sessionSaveDisclosure, uninstallHooks, type HookScope} from './install.js'
import {listSessionDirs, readMeta} from './paths.js'
import {saveSession} from './save.js'
import {canUploadSessions, resolveUploadAuth, uploadPending, uploadSession, type UploadOptions} from './upload.js'

export type HooksCommandDeps = {
  home?: string
  env?: NodeJS.ProcessEnv
  cwd?: string
  cliPath?: string
  readStdin?: () => Promise<string>
  write?: (text: string) => void
  fetchImpl?: typeof fetch
  now?: () => Date
  startUpload?: (sessionDir: string, profile?: string) => void
  startSweep?: (profile?: string) => void
}

const USAGE =
  'Usage: assethub hooks <install|uninstall|save|upload|list|status> [--client claude|codex] [--json]\n' +
  '  install|uninstall [--global]   (the current folder by default; --global for every project)\n' +
  '  save [--client codex] [--transcript <path> --session-id <id>]   (reads hook JSON from stdin without flags)\n' +
  '  upload [--session <dir> [--auto] [--sweep <n>]|--pending [--force] [--limit <n>]]\n' +
  '         --auto and --pending wait out earlier failures (1h, 2h, 4h … up to a day); --force retries now'

const parseFlags = (args: string[]): {flags: Record<string, string | true>; rest: string[]} => {
  const flags: Record<string, string | true> = {}
  const rest: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg.startsWith('--')) {
      rest.push(arg)
      continue
    }
    const [name, inline] = arg.slice(2).split('=', 2)
    if (inline !== undefined) flags[name] = inline
    else if (args[i + 1] !== undefined && !args[i + 1].startsWith('--')) flags[name] = args[++i]
    else flags[name] = true
  }
  return {flags, rest}
}

const limitFlag = (value: string | true | undefined): number | undefined => {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined
}

const defaultReadStdin = (): Promise<string> =>
  new Promise(resolve => {
    if (process.stdin.isTTY) return resolve('')
    const chunks: Buffer[] = []
    const timer = setTimeout(() => resolve(Buffer.concat(chunks).toString('utf8')), 2000)
    process.stdin.on('data', chunk => chunks.push(Buffer.from(chunk)))
    process.stdin.on('end', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    process.stdin.on('error', () => {
      clearTimeout(timer)
      resolve('')
    })
  })

export const runHooksCommand = async (
  argv: string[],
  deps: HooksCommandDeps = {},
): Promise<number> => {
  const write = deps.write ?? ((text: string) => process.stdout.write(text))
  const {flags, rest} = parseFlags(argv)
  const json = flags.json === true
  const out = (human: string, data: unknown): void =>
    write(json ? `${JSON.stringify(data)}\n` : `${human}\n`)
  const [sub] = rest
  const uploadOptions: UploadOptions = {
    home: deps.home,
    env: deps.env,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
    profile: typeof flags.profile === 'string' ? flags.profile : undefined,
  }

  try {
    switch (sub) {
      case 'install':
      case 'uninstall': {
        const client = flags.client
        if (client !== 'claude' && client !== 'codex') {
          write('--client claude|codex is required\n')
          return 2
        }
        // Sessions are saved only where the hooks are: this folder, unless --global.
        const scope: HookScope = flags.global === true ? {} : {projectDir: deps.cwd ?? process.cwd()}
        const paths = {home: deps.home, codexHome: (deps.env ?? process.env).CODEX_HOME?.trim() || undefined}
        if (sub === 'install') {
          // Only accounts that may upload sessions (internal for now) can turn
          // session saving on; for anyone else the hooks would only pile up.
          const auth = await resolveUploadAuth(uploadOptions)
          if (!auth || !(await canUploadSessions(auth, deps.fetchImpl))) {
            write('Session saving is not available for this account.\n')
            return 1
          }
          const result = await installHooks({...scope, ...paths, client, cliPath: deps.cliPath})
          out(result.installed ? `${result.detail}\n${sessionSaveDisclosure(scope, client)}` : result.detail, result)
          return result.installed ? 0 : 1
        }
        const result = await uninstallHooks({...scope, ...paths, client})
        out(result.detail, result)
        return 0
      }
      case 'save': {
        // A misspelt client must not be saved as Claude. Exit 1, not 2: a
        // hook's exit 2 can block the agent.
        if (flags.client !== undefined && flags.client !== 'claude' && flags.client !== 'codex') {
          write('Nothing saved: use --client claude or --client codex.\n')
          return 1
        }
        let stdin: string | undefined
        let input
        if (typeof flags.transcript === 'string') {
          input = {
            session_id: typeof flags['session-id'] === 'string' ? flags['session-id'] : `manual-${Date.now()}`,
            transcript_path: flags.transcript,
            cwd: deps.cwd ?? process.cwd(),
            hook_event_name: 'Manual',
          }
        } else {
          stdin = await (deps.readStdin ?? defaultReadStdin)()
        }
        const result = await saveSession({
          stdin,
          input,
          client: flags.client === 'codex' ? 'codex' : 'claude',
          home: deps.home,
          env: deps.env,
          now: deps.now,
          upload: {profile: uploadOptions.profile},
          startUpload: deps.startUpload,
          startSweep: deps.startSweep,
        })
        // A hook must never fail the agent, so save always exits 0.
        // Claude Code adds SessionStart hook output to the model's context, so
        // that hook stays silent.
        if (result.event !== 'SessionStart') {
          out(result.sessionDir ? `Saved ${result.sessionDir}` : `Nothing saved${result.skipped ? ` (${result.skipped})` : ''}`, result)
        }
        return 0
      }
      case 'upload': {
        if (typeof flags.session === 'string') {
          // A manual upload retries now; the detached SessionEnd upload (--auto)
          // honours the once-a-day limit after a no-upload-access answer.
          const outcome = await uploadSession(flags.session, {...uploadOptions, force: flags.auto !== true})
          out(outcome.ok ? `Uploaded ${outcome.graphId}` : `Not uploaded: ${outcome.reason}`, outcome)
          // --sweep N: then retry up to N older pending sessions (SessionEnd does this).
          const sweep = limitFlag(flags.sweep)
          if (sweep !== undefined && sweep > 0) {
            await uploadPending({...uploadOptions, force: false, limit: sweep, exclude: flags.session})
          }
          return outcome.ok ? 0 : 1
        }
        const results = await uploadPending({
          ...uploadOptions,
          force: flags.force === true,
          limit: limitFlag(flags.limit),
        })
        const failed = results.filter(r => !r.outcome.ok).length
        out(`${results.length - failed}/${results.length} pending sessions uploaded`, results)
        return failed ? 1 : 0
      }
      case 'list':
      case 'status': {
        const rows = []
        for (const dir of await listSessionDirs(deps.home)) {
          const meta = await readMeta(dir)
          if (meta) rows.push({dir, sessionId: meta.sessionId, status: meta.status, lastEvent: meta.lastEvent, reason: meta.reason})
        }
        if (sub === 'status') {
          const counts = rows.reduce<Record<string, number>>((acc, r) => {
            acc[r.status] = (acc[r.status] ?? 0) + 1
            return acc
          }, {})
          out(`${rows.length} sessions: ${JSON.stringify(counts)}`, {total: rows.length, counts})
        } else {
          out(rows.map(r => `${r.status.padEnd(15)} ${r.dir}${r.reason ? `  (${r.reason})` : ''}`).join('\n') || 'No saved sessions', rows)
        }
        return 0
      }
      default:
        write(`${USAGE}\n`)
        return sub ? 2 : 0
    }
  } catch (error) {
    write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
