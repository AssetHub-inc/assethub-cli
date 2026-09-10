import {createHash, randomUUID} from 'node:crypto'
import {createWriteStream} from 'node:fs'
import {mkdir, readdir, rename, unlink, writeFile} from 'node:fs/promises'
import {join, resolve} from 'node:path'
import {Readable, Transform} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import type {ReadableStream} from 'node:stream/web'
import type {CanvasExport, CanvasExportAsset} from '@assethub/api-client'

const html = (value: string) =>
  value.replace(
    /[&<>"']/g,
    character =>
      ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[
        character
      ]!,
  )
const markdown = (value: string) =>
  value.replace(/[\\`*_{}\[\]()#+.!|<>-]/g, '\\$&').replace(/\r?\n/g, ' ')
type DownloadFile = Omit<CanvasExportAsset, 'url'> & {
  path?: string
  bytes?: number
  sha256?: string
  error?: string
}

/** Signed file URLs are used without API credentials and never written into the bundle. */
export const downloadCanvas = async (input: {
  client: {
    v2: {
      exportCanvas: (
        id: number,
        options?: {mesh?: string},
      ) => Promise<CanvasExport>
    }
  }
  canvasId: number
  mesh?: string
  outDir: string
  progress?: (message: string) => void
}) => {
  const outDir = resolve(input.outDir)
  await mkdir(outDir, {recursive: true, mode: 0o700})
  if ((await readdir(outDir)).length)
    throw new Error('Canvas download requires an empty output directory')
  const exported = await input.client.v2.exportCanvas(input.canvasId, {
    mesh: input.mesh,
  })
  if (
    exported.schemaVersion !== 'assethub.canvas-export.v1' ||
    exported.canvas.id !== input.canvasId
  )
    throw new Error('Invalid canvas export response')
  await mkdir(join(outDir, 'files'), {mode: 0o700})
  const files: DownloadFile[] = []
  for (const [index, asset] of exported.assets.entries()) {
    const {url, ...safeAsset} = asset
    const file: DownloadFile = {...safeAsset}
    files.push(file)
    input.progress?.(`Downloading ${index + 1}/${exported.assets.length}`)
    const temporary = join(outDir, 'files', `.${randomUUID()}.tmp`)
    try {
      if (!url) throw new Error('No downloadable file URL is available')
      const parsed = new URL(url)
      if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password
      )
        throw new Error('Invalid download URL')
      const response = await fetch(url, {
        signal: AbortSignal.timeout(120_000),
        redirect: 'error',
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (!response.body) throw new Error('Empty file response')
      const contentType = response.headers
        .get('content-type')
        ?.split(';')[0]
        ?.trim()
      const imageTypes: Record<string, string> = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'image/avif': 'avif',
      }
      let extension: string
      if (asset.mediaType === 'image') {
        const ext = contentType && imageTypes[contentType]
        if (!ext) throw new Error('Expected a raster image file')
        extension = ext
      } else {
        if (contentType === 'text/html' || contentType === 'image/svg+xml')
          throw new Error('Expected a mesh file')
        extension = ['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', 'zip'].includes(
          asset.format ?? '',
        )
          ? asset.format!
          : 'glb'
      }
      const stem =
        asset.name
          .replace(/[^a-zA-Z0-9_-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 50) || asset.mediaType
      const name = `${String(index + 1).padStart(3, '0')}-${stem}-${createHash('sha256').update(asset.id).digest('hex').slice(0, 10)}.${extension}`
      const hash = createHash('sha256')
      let bytes = 0
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length
          if (bytes > 1024 * 1024 * 1024)
            return callback(new Error('File exceeds 1 GiB'))
          hash.update(chunk)
          callback(null, chunk)
        },
      })
      await pipeline(
        Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
        meter,
        createWriteStream(temporary, {flags: 'wx', mode: 0o600}),
      )
      if (bytes === 0) throw new Error('Empty file response')
      await rename(temporary, join(outDir, 'files', name))
      Object.assign(file, {
        path: `files/${name}`,
        bytes,
        sha256: hash.digest('hex'),
      })
    } catch (error) {
      // Network errors may contain signed URLs. Only our bounded known messages
      // are retained, never provider error bodies or raw fetch exceptions.
      const message = error instanceof Error ? error.message : ''
      file.error =
        /^(HTTP \d{3}|No downloadable file URL is available|Invalid download URL|Empty file response|Expected a raster image file|Expected a mesh file|File exceeds 1 GiB)$/.test(
          message,
        )
          ? message
          : 'File download failed'
    } finally {
      await unlink(temporary).catch(error => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }
  const byId = new Map(files.map(file => [file.id, file]))
  const showAsset = (id: string) => {
    const file = byId.get(id)
    return file?.path
      ? `<a href="${html(file.path)}">${html(file.name)}</a>`
      : html(file?.name ?? id)
  }
  const warnings = [
    ...exported.warnings,
    ...(exported.truncated
      ? ['The export was truncated; some assets or history are missing.']
      : []),
  ]
  const manifest = {...exported, assets: files, warnings}
  const sections = exported.steps
    .map(
      step =>
        `<section><h2>${html(step.operation)}</h2><p>${html([step.createdAt, step.model, step.source].filter(Boolean).join(' · '))}</p>${step.prompt ? `<pre>${html(step.prompt)}</pre>` : ''}<p>Inputs: ${step.inputs.map(ref => `${showAsset(ref.id)} (${html(ref.role)}; ${html(ref.evidence)})`).join(', ') || 'No recorded inputs'}</p><p>Outputs: ${step.outputs.map(showAsset).join(', ') || 'History step'}</p>${step.warnings.map(warning => `<p>${html(warning)}</p>`).join('')}</section>`,
    )
    .join('')
  const document = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${html(exported.canvas.name)}</title><style>body{font:16px system-ui;max-width:1000px;margin:32px auto;padding:0 20px;color:#202126}a{color:#2455ac}pre{white-space:pre-wrap;overflow-wrap:anywhere}section{border-top:1px solid #ccc;padding:16px 0}.images{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:20px}img{width:100%;height:220px;object-fit:contain}figure{margin:0}figcaption{overflow-wrap:anywhere}</style><h1>${html(exported.canvas.name)}</h1><p>Canvas ${exported.canvas.id}. Actual generation inputs and available recorded history. Canvas connections are not evidence of generation inputs.</p>${warnings.map(warning => `<p>${html(warning)}</p>`).join('')}<h2>Files</h2><div class="images">${files.map(file => `<figure>${file.mediaType === 'image' && file.path ? `<img loading="lazy" src="${html(file.path)}" alt="${html(file.name)}">` : ''}<figcaption>${showAsset(file.id)} · ${html(file.role)}${file.error ? ` · ${html(file.error)}` : ''}</figcaption></figure>`).join('')}</div><h2>History</h2>${sections}</html>`
  const mdAsset = (id: string) => {
    const file = byId.get(id)
    return file?.path
      ? `[${markdown(file.name)}](${file.path})`
      : markdown(file?.name ?? id)
  }
  const history = [
    `# ${markdown(exported.canvas.name)}`,
    '',
    `Canvas ${exported.canvas.id}. Actual generation inputs and available history; canvas connections are not generation evidence.`,
    '',
    ...warnings.map(warning => `- ${markdown(warning)}`),
    '',
    '## Files',
    '',
    ...files.map(
      file =>
        `- ${mdAsset(file.id)} (${file.role})${file.error ? `: ${markdown(file.error)}` : ''}`,
    ),
    '',
    ...exported.steps.flatMap(step => [
      `## ${markdown(step.operation)}`,
      '',
      markdown(
        [step.createdAt, step.model, step.source].filter(Boolean).join(' · '),
      ),
      '',
      ...(step.prompt ? [`Prompt: ${markdown(step.prompt)}`, ''] : []),
      `Inputs: ${step.inputs.map(ref => `${mdAsset(ref.id)} (${markdown(ref.role)}; ${markdown(ref.evidence)})`).join(', ') || 'No recorded inputs'}`,
      '',
      `Outputs: ${step.outputs.map(mdAsset).join(', ') || 'History step'}`,
      '',
      ...step.warnings.map(warning => `- ${markdown(warning)}`),
      '',
    ]),
  ].join('\n')
  await writeFile(
    join(outDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    {mode: 0o600, flag: 'wx'},
  )
  await writeFile(join(outDir, 'index.html'), document, {
    mode: 0o600,
    flag: 'wx',
  })
  await writeFile(join(outDir, 'history.md'), history, {
    mode: 0o600,
    flag: 'wx',
  })
  const failed = files.filter(file => file.error).length
  return {
    outDir,
    manifestPath: join(outDir, 'manifest.json'),
    htmlPath: join(outDir, 'index.html'),
    historyPath: join(outDir, 'history.md'),
    downloaded: files.length - failed,
    failed,
    steps: exported.steps.length,
    warnings,
    missingEvidence: exported.steps.flatMap(step => step.warnings),
    truncated: exported.truncated,
    exitCode: failed ? 1 : exported.truncated ? 3 : 0,
  }
}
