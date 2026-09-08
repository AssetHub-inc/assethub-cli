import {createHash} from 'node:crypto'
import {mkdir, writeFile} from 'node:fs/promises'
import {dirname, resolve} from 'node:path'
import type {AssetHubClient} from '@assethub/api-client'

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    character =>
      ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[
        character
      ]!,
  )

/** A portable review artifact; downloading uses signed URLs, never the API key. */
export async function writeCanvasComparison(input: {
  client: AssetHubClient
  canvasId: number
  sourceId: string
  assetId: string
  out: string
  title?: string
}) {
  const canvas = await input.client.v2.getCanvas(input.canvasId)
  const images = await Promise.all(
    [input.sourceId, input.assetId].map(async assetId => {
      const {url} = await input.client.v2.getAsset(assetId)
      const response = await fetch(url, {signal: AbortSignal.timeout(60_000)})
      if (!response.ok)
        throw new Error(
          `Asset download failed: ${assetId} HTTP ${response.status}`,
        )
      const mime = response.headers.get('content-type')?.split(';')[0]
      if (
        !mime ||
        !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)
      )
        throw new Error(`Comparison requires a raster image: ${assetId}`)
      const reader = response.body?.getReader()
      if (!reader) throw new Error(`Empty asset response: ${assetId}`)
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const {done, value} = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > 32 * 1024 * 1024)
            throw new Error('Comparison image exceeds 32 MiB')
          chunks.push(value)
        }
      } finally {
        await reader.cancel()
      }
      const bytes = Buffer.concat(chunks)
      return {
        assetId,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
      }
    }),
  )
  const title = input.title ?? 'Storyboard / generated image'
  const provenance = {
    canvasId: canvas.id,
    canvasUrl: canvas.url,
    reviewStatus: 'awaiting_creator_review',
    images: images.map(({dataUrl: _, ...image}) => image),
  }
  const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>body{margin:24px;background:#17191d;color:#fff;font:16px system-ui}main{display:grid;grid-template-columns:1fr 1fr;gap:20px}figure{margin:0}img{width:100%;height:70vh;object-fit:contain;background:#252830}figcaption{padding:12px 0}a{color:#a9cbff}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}@media(max-width:700px){main{grid-template-columns:1fr}img{height:auto}}</style><h1>${escapeHtml(title)}</h1><p>Creator review pending · <a href="${escapeHtml(canvas.url)}">AssetHub canvas ${canvas.id}</a></p><main>${images.map((image, index) => `<figure><img alt="${index === 0 ? '元のVコンテ' : 'AI生成画像'}" src="${image.dataUrl}"><figcaption>${index === 0 ? '元のVコンテ' : 'AI生成画像'} · ${escapeHtml(image.assetId)}</figcaption></figure>`).join('')}</main><details><summary>Source provenance</summary><pre>${escapeHtml(JSON.stringify(provenance, null, 2))}</pre></details></html>`
  const path = resolve(input.out)
  await mkdir(dirname(path), {recursive: true})
  await writeFile(path, html, {mode: 0o600})
  await writeFile(`${path}.json`, `${JSON.stringify(provenance, null, 2)}\n`, {
    mode: 0o600,
  })
  return {path, provenancePath: `${path}.json`, ...provenance}
}
