export type MeshAsset = {
  assetId: string
  name: string
  createdAt: string
  updatedAt: string
  sourceType: string
  archived: boolean
  publicId: string
  meshGenerationId: string | null
}

export type MeshListOptions = {
  query?: string
  cursor?: string
  limit?: number
}

export type MeshListResult = {
  items: MeshAsset[]
  nextCursor: string | null
}

export type HistoricalGraphSource = 'generated' | 'upload'

export type GraphSummary = {
  graphId: string
  source: HistoricalGraphSource
  updatedAt: string | null
  lastRev: number | null
  [key: string]: unknown
}

export type GraphListResult = {
  items: GraphSummary[]
  nextCursor: string | null
}

export type HistoricalGraphNode = {
  id: string
  artifactKind?: string
  metadata: Record<string, unknown>
  [key: string]: unknown
}

export type HistoricalGraphEdge = {
  id: string
  from: string
  to: string
  [key: string]: unknown
}

export type HistoricalGraph = {
  graphId: string
  source: HistoricalGraphSource
  revision: string
  lastRev: number | null
  nodes: HistoricalGraphNode[]
  edges: HistoricalGraphEdge[]
  nextCursor: string | null
  truncated: boolean
}

export type HistoricalGraphOptions = {
  source?: HistoricalGraphSource
  artifactId?: string
  direction?: 'ancestors' | 'descendants' | 'both'
  depth?: number
}
