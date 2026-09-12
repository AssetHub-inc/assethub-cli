import {execFile} from 'node:child_process'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import {expect, it} from 'vitest'

// @testdoc The SDK rejects mixed source/node requests and privacy overrides; native mesh privacy comes from the saved node.
it('rejects mixed native requests and public mesh privacy overrides', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assethub-native-request-types-'))
  try {
    const path = join(dir, 'requests.ts')
    const sdk = fileURLToPath(new URL('../src/index.js', import.meta.url))
    await writeFile(
      path,
      `
import type {MeshGenerationRequest, MeshComposeRequest} from ${JSON.stringify(sdk)}
const source = {resourceId: 'image'}
const context = {canvasId: 42, clientOperationId: 'operation', source: 'cli' as const}
const native = {...context, canvasNode: {nodeId: 'shape:node'}}
const image: MeshGenerationRequest = {modelId: 'model', source, executionContext: context}
const views: MeshGenerationRequest = {modelId: 'model', sources: [source], executionContext: context}
const unrecorded: MeshGenerationRequest = {modelId: 'model', source}
const node: MeshGenerationRequest = {executionContext: native}
const compose: MeshComposeRequest = {parts: [{assetId: 'mesh_1'}], fullBodyImageAssetId: 'image', executionContext: context}
const nativeCompose: MeshComposeRequest = {executionContext: native}
// @ts-expect-error: Mesh privacy is not a public explicit-source override.
const privateSource: MeshGenerationRequest = {modelId: 'model', source, isPrivate: true}
// @ts-expect-error: Native mesh privacy must come from the saved node.
const privateNode: MeshGenerationRequest = {executionContext: native, isPrivate: true}
// @ts-expect-error: Source requests cannot also resolve a native node.
const mixedImage: MeshGenerationRequest = {modelId: 'model', source, executionContext: native}
// @ts-expect-error: Multiview requests cannot also resolve a native node.
const mixedViews: MeshGenerationRequest = {modelId: 'model', sources: [source], executionContext: native}
// @ts-expect-error: Explicit parts cannot be combined with a native node context.
const mixedCompose: MeshComposeRequest = {parts: [{assetId: 'mesh_1'}], fullBodyImageAssetId: 'image', executionContext: native}
`,
    )
    const compiler = createRequire(import.meta.url).resolve(
      'typescript/bin/tsc',
    )
    const result = await promisify(execFile)(process.execPath, [
      compiler,
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'preserve',
      '--moduleResolution',
      'bundler',
      '--lib',
      'ES2022,DOM,DOM.Iterable',
      path,
    ])
    expect(result.stdout).toBe('')
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})
