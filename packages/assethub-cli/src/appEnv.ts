import {join} from 'node:path'

// macOS apps started from the Dock or Finder (Claude, Codex) do not read shell
// profiles, so an exported ASSETHUB_API_KEY never reaches them and the MCP
// header `Bearer ${ASSETHUB_API_KEY}` goes out empty (HTTP 401). launchd's user
// environment does reach them: `launchctl setenv` covers apps started from now
// on, and a LaunchAgent repeats it at every login by running `assethub env load`,
// which reads the key from the CLI's own config. The key is never written to the
// plist or to any other new file.

export const LAUNCH_AGENT_LABEL = 'io.assethub.env'
export const API_KEY_ENV = 'ASSETHUB_API_KEY'
const LAUNCHCTL = '/bin/launchctl'

type Run = (file: string, args: string[]) => Promise<{code: number; output: string}>

export const launchAgentPath = (home: string): string =>
  join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`)

const xml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// launchd's PATH has neither nvm's node nor a global `assethub`, so the agent
// runs the node and CLI that ran setup. Once that node version is removed or
// the CLI moves, it asks the user's login shell for `assethub` instead.
const LAUNCH_AGENT_SCRIPT = [
  'node="$1"; cli="$2"; shift 2',
  'if [ -x "$node" ] && [ -f "$cli" ]; then exec "$node" "$cli" "$@"; fi',
  'exec "${SHELL:-/bin/zsh}" -lic \'exec assethub "$@"\' assethub "$@"',
].join('\n')

/** ProgramArguments for the login agent: `assethub <args>` via this node and CLI, or the login shell's. */
export const launchAgentProgram = (node: string, cli: string, args: string[]): string[] => [
  '/bin/sh',
  '-c',
  LAUNCH_AGENT_SCRIPT,
  'assethub-env',
  node,
  cli,
  ...args,
]

export const launchAgentPlist = (program: string[]): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LAUNCH_AGENT_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...program.map(arg => `    <string>${xml(arg)}</string>`),
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')

/** The ASSETHUB_API_KEY that apps started now would receive, if any. */
export const readLaunchdKey = async (run: Run): Promise<string | undefined> => {
  const result = await run(LAUNCHCTL, ['getenv', API_KEY_ENV])
  const value = result.code === 0 ? result.output.trim() : ''
  return value || undefined
}

// `launchctl setenv` only takes the value as an argument, so the key is briefly
// visible to local `ps` while it runs; the result never echoes it.
export const loadKeyIntoLaunchd = async (
  key: string,
  run: Run,
): Promise<{ok: true} | {ok: false; detail: string}> => {
  const result = await run(LAUNCHCTL, ['setenv', API_KEY_ENV, key])
  return result.code === 0
    ? {ok: true}
    : {ok: false, detail: `launchctl setenv exited ${result.code}: ${result.output.split(key).join('[key]').trim().slice(0, 200)}`}
}
