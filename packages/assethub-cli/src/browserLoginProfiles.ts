import type {BrowserLoginWorkspace} from './browserLogin.js'

const MAX_SLUG = 32

const slugify = (name: string): string =>
  name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '')

/** Stable `ws-<slug>-<id8>` profile name for a workspace. */
export const workspaceProfileName = (workspace: {
  id: string
  name: string
}): string => {
  const id8 = workspace.id
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 8)
  const slug = slugify(workspace.name)
  return ['ws', slug, id8].filter(Boolean).join('-')
}

/** Profile names for one login, collision-safe and in workspace order. */
export const assignWorkspaceProfileNames = (
  workspaces: readonly Pick<BrowserLoginWorkspace, 'id' | 'name'>[],
  firstName?: string,
): string[] => {
  const used = new Set<string>(firstName ? [firstName] : [])
  return workspaces.map((workspace, index) => {
    if (index === 0 && firstName) return firstName
    const base = workspaceProfileName(workspace)
    let candidate = base
    for (let n = 2; used.has(candidate); n += 1) candidate = `${base}-${n}`
    used.add(candidate)
    return candidate
  })
}
