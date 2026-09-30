import {createHash} from 'node:crypto'
import {expect, it} from 'vitest'
import {
  childOperationId,
  planProductionNodeMeshes,
} from '../src/nativeCanvasNodes.js'
import type {CanvasNode} from '../src/canvas.js'

// @testdoc Production mesh batches select only eligible saved children and report every completed, busy or unavailable child as skipped.
it('uses the CLI production child selection and preserves listing order', () => {
  const parent: CanvasNode = {
    nodeId: 'shape:parent',
    type: 'production-3d',
    actions: ['mesh.generate'],
  }
  const children: CanvasNode[] = [
    'ready',
    'complete',
    'completed',
    'generating',
    'unavailable',
  ].map(meshStatus => ({
    nodeId: `shape:${meshStatus}`,
    sourceNodeId: parent.nodeId,
    type: 'preview-asset',
    meshStatus,
    actions: meshStatus === 'unavailable' ? [] : ['mesh.generate'],
  }))
  expect(
    planProductionNodeMeshes(
      [
        parent,
        ...children,
        {...children[0]!, nodeId: 'shape:foreign', sourceNodeId: 'shape:other'},
      ],
      parent.nodeId,
    ),
  ).toEqual({
    children: ['shape:ready'],
    skipped: children
      .slice(1)
      .map(({nodeId, meshStatus}) => ({nodeId, meshStatus})),
  })
  expect(() =>
    planProductionNodeMeshes([{...parent, actions: []}], parent.nodeId),
  ).toThrow('unavailable')
})

// @testdoc Browser and CLI child operation IDs retain the existing SHA-256 UUID mapping, preserving already saved batch journals across the shared-helper move.
it('derives exactly the existing CLI child operation ID', async () => {
  const parent = '11111111-1111-4111-8111-111111111111'
  const hash = createHash('sha256')
    .update(JSON.stringify([parent, 'shape:part']))
    .digest('hex')
  expect(await childOperationId(parent, 'shape:part')).toBe(
    `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
  )
})
