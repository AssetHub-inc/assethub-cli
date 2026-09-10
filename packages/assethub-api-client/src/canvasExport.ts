import type {Canvas} from './canvas.js'

/** Only evidenced inputs are ancestry; canvas connections are not provenance. */
export type CanvasExportAsset = {
  id: string
  assetId?: string
  name: string
  mediaType: 'image' | 'mesh'
  role: 'visible' | 'ancestor' | 'recorded_input'
  createdAt?: string
  format?: string
  url?: string
}

export type CanvasExportStep = {
  id: string
  source:
    | 'mesh_generation'
    | 'projected_image_gen'
    | 'api_execution'
    | 'artifact_graph'
    | 'production_task'
  operation: string
  createdAt?: string
  model?: string
  prompt?: string
  inputs: Array<{id: string; role: string; evidence: string}>
  outputs: string[]
  warnings: string[]
}

export type CanvasExport = {
  schemaVersion: 'assethub.canvas-export.v1'
  canvas: Canvas
  meshAssetId?: string
  assets: CanvasExportAsset[]
  steps: CanvasExportStep[]
  warnings: string[]
  truncated: boolean
}
