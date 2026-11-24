// Windows only: a global npm install puts the `assethub` shim in the npm prefix
// folder, which is not always on the user's PATH (for example when a chat agent
// ran the install). Setup reads and extends the persistent User PATH so
// `assethub` works in every new window.
import {posix, win32} from 'node:path'
import {runProcess} from './setupCommand.js'

export type WindowsPathDeps = {
  /** Folder holding the global `assethub` shim; undefined for npx, source or other installers. */
  commandDir: () => Promise<string | undefined>
  /** The persistent User and Machine PATH entries, expanded. */
  persistentPath: () => Promise<string[]>
  /** Appends dir to the persistent User PATH when it is missing. */
  addToUserPath: (dir: string) => Promise<{ok: boolean; detail: string}>
}

/** The npm prefix, where npm puts command shims: the parent of `npm root -g` on Windows. */
export const npmShimDir = (npmGlobalRoot: string, platform: NodeJS.Platform): string => {
  // path.win32 keeps a drive-root prefix absolute (C:\node_modules -> C:\).
  if (platform === 'win32') return win32.dirname(win32.normalize(npmGlobalRoot.replace(/[\\/]+$/, '') || npmGlobalRoot))
  // Elsewhere npm root is <prefix>/lib/node_modules and shims are in <prefix>/bin.
  return posix.join(posix.dirname(posix.dirname(npmGlobalRoot.replace(/\/+$/, ''))), 'bin')
}

const normalize = (dir: string) => dir.trim().replace(/^"|"$/g, '').replace(/[\\/]+$/, '').toLowerCase()

export const pathIncludes = (entries: string[], dir: string): boolean =>
  entries.some(entry => normalize(entry) === normalize(dir))

const powershell = (script: string, env: Record<string, string> = {}) =>
  runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], env)

export const createWindowsPathDeps = (commandDir: () => Promise<string | undefined>): WindowsPathDeps => ({
  commandDir,
  persistentPath: async () => {
    const result = await powershell(
      "[Environment]::GetEnvironmentVariable('Path','User'); [Environment]::GetEnvironmentVariable('Path','Machine')",
    )
    if (result.code !== 0) return []
    return result.output.split(/[;\r\n]+/).filter(entry => entry.trim())
  },
  // The raw registry value keeps %VARIABLES% unexpanded and is written back as
  // REG_EXPAND_SZ; clearing a scratch variable broadcasts the change to Explorer.
  // The folder travels in the environment, never inside the script text.
  addToUserPath: async dir => {
    const result = await powershell(
      [
        '$dir = $env:ASSETHUB_SETUP_DIR',
        "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
        "$raw = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')",
        "$parts = @($raw -split ';' | Where-Object { $_ })",
        "if (-not ($parts | Where-Object { $_.TrimEnd('\\') -ieq $dir.TrimEnd('\\') })) { $key.SetValue('Path', (($parts + $dir) -join ';'), 'ExpandString') }",
        '$key.Close()',
        "[Environment]::SetEnvironmentVariable('ASSETHUB_SETUP_REFRESH', 'x', 'User')",
        "[Environment]::SetEnvironmentVariable('ASSETHUB_SETUP_REFRESH', $null, 'User')",
      ].join('; '),
      {ASSETHUB_SETUP_DIR: dir},
    )
    return {ok: result.code === 0, detail: result.output.trim()}
  },
})
