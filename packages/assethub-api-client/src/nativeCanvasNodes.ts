import type {CanvasNode} from './canvas.js'

/** The CLI and browser freeze this same Production child set before dispatch. */
export const planProductionNodeMeshes = (
  items: CanvasNode[],
  nodeId: string,
) => {
  const target = items.find(item => item.nodeId === nodeId)
  if (
    target?.type !== 'production-3d' ||
    !target.actions.includes('mesh.generate')
  )
    throw new Error('Mesh generation is unavailable for this Production node')
  const children = items.filter(
    item =>
      item.sourceNodeId === nodeId &&
      ['mesh-gen', 'preview-asset', 'part-group'].includes(item.type),
  )
  if (!children.length)
    throw new Error('Production node has no saved part nodes to generate')
  const pending = children.filter(
    item =>
      item.actions.includes('mesh.generate') &&
      !['complete', 'completed', 'generating'].includes(item.meshStatus ?? ''),
  )
  return {
    children: pending.map(item => item.nodeId),
    skipped: children
      .filter(item => !pending.includes(item))
      .map(({nodeId, meshStatus}) => ({nodeId, meshStatus})),
  }
}

/** Preserve the original CLI journal key mapping in both Node and browsers. */
export const childOperationId = async (parent: string, step: string) => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([parent, step])),
  )
  const hash = Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}
