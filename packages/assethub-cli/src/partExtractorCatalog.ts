// The part extractor (production agent) list, as the server publishes it at
// GET /production/agents. The CLI's own table is only an alias / offline
// fallback: a newly released server agent works without a CLI release.

export type CatalogAgent = {
  /** The id sent as `agentVersion` in requests (the server's internalVersion). */
  internalVersion: string
  agentVersion?: string
  label: string
  defaultAgent: boolean
  recommended: boolean
  supportedOnGraphEndpoint: boolean
  /** Derived from server metadata: a harpy assembly id or declared body constructions. */
  characterAssembly: boolean
}

export type AgentCatalog = {
  agents: CatalogAgent[]
  /** Chosen when no --part-extractor is given: recommended, else defaultAgent. */
  preferred?: CatalogAgent
}

export const normalizeAgentName = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, ' ')

const HARPY_ASSEMBLY_PREFIX = 'ah_agent_graph_harpy_assembly_'

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined)

/** Reads the raw response; entries without an internalVersion are skipped. An unusable list yields undefined. */
export const parseAgentCatalog = (raw: unknown): AgentCatalog | undefined => {
  if (raw == null || typeof raw !== 'object') return undefined
  const result = raw as {agents?: unknown; recommendedAgentVersion?: unknown; defaultAgent?: unknown}
  if (!Array.isArray(result.agents)) return undefined
  const topRecommended = text(result.recommendedAgentVersion)
  const agents: CatalogAgent[] = []
  for (const entry of result.agents) {
    if (entry == null || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const internalVersion = text(item.internalVersion)
    if (internalVersion === undefined) continue
    const agentVersion = text(item.agentVersion)
    const label = text(item.label) ?? agentVersion ?? internalVersion
    const matchesTop = (name: string | undefined, against: string | undefined) =>
      name !== undefined && against !== undefined && normalizeAgentName(name) === normalizeAgentName(against)
    agents.push({
      internalVersion,
      ...(agentVersion === undefined ? {} : {agentVersion}),
      label,
      defaultAgent: item.defaultAgent === true,
      recommended:
        item.recommended === true ||
        matchesTop(topRecommended, agentVersion) ||
        matchesTop(topRecommended, internalVersion) ||
        matchesTop(topRecommended, label),
      supportedOnGraphEndpoint: item.supportedOnGraphEndpoint === true,
      characterAssembly:
        internalVersion.startsWith(HARPY_ASSEMBLY_PREFIX) ||
        (Array.isArray(item.supportedBodyConstructions) && item.supportedBodyConstructions.length > 0),
    })
  }
  if (agents.length === 0) return undefined
  return {agents, preferred: agents.find(agent => agent.recommended) ?? agents.find(agent => agent.defaultAgent)}
}

/** Case-insensitive match on label, agentVersion or internalVersion. */
export const findCatalogAgent = (catalog: AgentCatalog, input: string): CatalogAgent | undefined => {
  const wanted = normalizeAgentName(input)
  return catalog.agents.find(agent =>
    [agent.label, agent.agentVersion, agent.internalVersion].some(name => name !== undefined && normalizeAgentName(name) === wanted),
  )
}

export const catalogAgentByInternal = (catalog: AgentCatalog, internalVersion: string): CatalogAgent | undefined =>
  catalog.agents.find(agent => agent.internalVersion === internalVersion)

export const catalogNames = (catalog: AgentCatalog): string => catalog.agents.map(agent => agent.label).join(', ')
