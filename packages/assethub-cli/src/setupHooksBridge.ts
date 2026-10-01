// Seam between `assethub setup` and the hook installer, which is built
// separately. Setup receives an implementation by injection; this default keeps
// the command working in builds that do not ship hooks.
export type InstallHooks = (opts: {
  client: 'claude' | 'codex'
  /** The project folder whose .claude/settings.local.json or .codex/hooks.json gets the hooks. */
  projectDir?: string
  /** Codex's user folder ($CODEX_HOME), where Codex records which projects are trusted. */
  codexHome?: string
}) => Promise<{installed: boolean; detail: string}>

export const defaultInstallHooks: InstallHooks = async () => ({
  installed: false,
  detail: 'hooks not available in this build',
})
