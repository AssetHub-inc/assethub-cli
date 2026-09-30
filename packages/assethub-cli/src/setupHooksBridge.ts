// Seam between `assethub setup` and the hook installer, which is built
// separately. Setup receives an implementation by injection; this default keeps
// the command working in builds that do not ship hooks.
export type InstallHooks = (opts: {
  client: 'claude' | 'codex'
}) => Promise<{installed: boolean; detail: string}>

export const defaultInstallHooks: InstallHooks = async () => ({
  installed: false,
  detail: 'hooks not available in this build',
})
