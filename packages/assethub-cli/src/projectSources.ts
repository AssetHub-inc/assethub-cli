import {execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises'
import {extname, isAbsolute, join, relative, resolve, sep} from 'node:path'
import {promisify} from 'node:util'

import {EXTRACT_WORKBOOK_PYTHON} from './projectSourcesWorkbook.js'

const execute = promisify(execFile)
const SCHEMA = 'assethub.project-sources.v1'
const MARKER = '.assethub-project-ingest.json'
const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.avif',
  '.tif',
  '.tiff',
  '.bmp',
  '.svg',
  '.exr',
  '.hdr',
  '.heic',
  '.ico',
])
const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.csv',
  '.tsv',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.xml',
  '.srt',
  '.vtt',
])
const VIDEO_EXTENSIONS = new Set([
  '.mov',
  '.mp4',
  '.m4v',
  '.webm',
  '.avi',
  '.mkv',
])

type SourceStatus = 'complete' | 'partial' | 'failed' | 'listed'
type Dependency = {command: string; available: boolean}
type Placement = {sheet: string; cell?: string; mapping: string}
export type ProjectSourceArtifact = {
  relativePath: string
  sha256: string
  byteSize: number
  kind: 'text' | 'metadata' | 'image'
  origin: {
    sourceRelativePath: string
    sourceSha256: string
    extraction:
      | 'copy'
      | 'text'
      | 'pdf_page'
      | 'pdf_text'
      | 'workbook_media'
      | 'workbook_cells'
      | 'video_frame'
      | 'video_metadata'
    page?: number
    requestedTimestampSeconds?: number
    workbookMediaPath?: string
    placements?: Placement[]
  }
}
export type ProjectSourceFile = {
  relativePath: string
  sha256: string
  byteSize: number
  format: string
  origin: {sourceRoot: string; relativePath: string}
  status: SourceStatus
  artifactPaths: string[]
  warnings: string[]
}
export type ProjectSourcesSummary = {
  schemaVersion: typeof SCHEMA
  sourceDir: string
  outDir: string
  status: 'complete' | 'partial'
  dependencies: Dependency[]
  sources: ProjectSourceFile[]
  images: ProjectSourceArtifact[]
  artifacts: ProjectSourceArtifact[]
  requestedExcludedDirectories: string[]
  excludedDirectories: string[]
  warnings: string[]
  summaryPath: string
  textPath: string
  imagesManifestPath: string
}
export type IngestProjectSourcesOptions = {
  sourceDir: string
  outDir: string
  excludedDirectories?: string[]
  onProgress?: (message: string) => void
}

type WorkbookExtraction = {
  images: {file: string; workbookMediaPath: string; placements: Placement[]}[]
  warnings: string[]
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function portable(path: string): string {
  return path.split(sep).join('/')
}

async function command(command: string, args: string[]): Promise<string> {
  const result = await execute(command, args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 300_000,
  })
  return result.stdout
}

async function detectDependencies(): Promise<Dependency[]> {
  return Promise.all(
    [
      ['python3', '--version'],
      ['pdftotext', '-v'],
      ['pdftoppm', '-v'],
      ['ffmpeg', '-version'],
      ['ffprobe', '-version'],
    ].map(async ([name, flag]) => {
      try {
        await command(name!, [flag!])
        return {command: name!, available: true}
      } catch {
        return {command: name!, available: false}
      }
    }),
  )
}

async function isIngestDirectory(path: string): Promise<boolean> {
  try {
    const marker: unknown = JSON.parse(
      await readFile(join(path, MARKER), 'utf8'),
    )
    return (
      typeof marker === 'object' &&
      marker !== null &&
      'schemaVersion' in marker &&
      marker.schemaVersion === SCHEMA
    )
  } catch {
    return false
  }
}

/** Extract local bytes and provenance only. Semantic analysis and upload are separate CLI steps. */
export async function ingestProjectSources(
  options: IngestProjectSourcesOptions,
): Promise<ProjectSourcesSummary> {
  const sourceDir = await realpath(resolve(options.sourceDir))
  if (!(await stat(sourceDir)).isDirectory())
    throw new Error('Source must be a directory')
  const excludedPaths = new Set<string>()
  for (const directory of options.excludedDirectories ?? []) {
    const path = resolve(sourceDir, directory)
    const confined = (candidate: string) => {
      const child = relative(sourceDir, candidate)
      return (
        child !== '' &&
        child !== '..' &&
        !child.startsWith(`..${sep}`) &&
        !isAbsolute(child)
      )
    }
    if (!directory.trim() || isAbsolute(directory) || !confined(path))
      throw new Error(
        'Excluded directories must be relative paths inside the source root; excluding the source root itself is not allowed',
      )
    try {
      if (!confined(await realpath(path)))
        throw new Error(
          'Excluded directories must stay inside the source root, including symbolic links',
        )
      if (!(await stat(path)).isDirectory())
        throw new Error(
          'Excluded paths must name directories inside the source root',
        )
    } catch (error) {
      if (
        !(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOENT'
        )
      )
        throw error
    }
    excludedPaths.add(path)
  }
  await mkdir(resolve(options.outDir), {recursive: true})
  const outDir = await realpath(resolve(options.outDir))
  if (sourceDir === outDir)
    throw new Error('Output directory must differ from the source directory')
  const existing = await readdir(outDir)
  if (existing.length && !(await isIngestDirectory(outDir))) {
    throw new Error(
      'Output directory must be empty or previously created by project ingest',
    )
  }
  await writeFile(
    join(outDir, MARKER),
    `${JSON.stringify({schemaVersion: SCHEMA})}\n`,
  )
  const dependencies = await detectDependencies()
  const available = new Set(
    dependencies.filter(dep => dep.available).map(dep => dep.command),
  )
  const summary: ProjectSourcesSummary = {
    schemaVersion: SCHEMA,
    sourceDir,
    outDir,
    status: 'complete',
    dependencies,
    sources: [],
    images: [],
    artifacts: [],
    requestedExcludedDirectories: [...excludedPaths]
      .map(path => portable(relative(sourceDir, path)))
      .sort(),
    excludedDirectories: [],
    warnings: [],
    summaryPath: join(outDir, 'summary.json'),
    textPath: join(outDir, 'text.md'),
    imagesManifestPath: join(outDir, 'images.json'),
  }
  const files: string[] = []
  async function collect(directory: string): Promise<void> {
    const entries = (await readdir(directory, {withFileTypes: true})).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        summary.warnings.push(
          `Skipped symbolic link: ${portable(relative(sourceDir, path))}`,
        )
      } else if (entry.isDirectory()) {
        if (
          excludedPaths.has(path) ||
          path === outDir ||
          (await isIngestDirectory(path))
        ) {
          summary.excludedDirectories.push(portable(relative(sourceDir, path)))
        } else await collect(path)
      } else if (entry.isFile()) files.push(path)
    }
  }
  await collect(sourceDir)
  const textSections = [
    '# Extracted project sources',
    '',
    'Source facts and byte provenance only. Image filenames and worksheet columns are not semantic or 3D classifications.',
    '',
  ]
  for (const path of files) {
    const sourceRelativePath = portable(relative(sourceDir, path))
    options.onProgress?.(`Extracting ${sourceRelativePath}`)
    const sha256 = await hashFile(path)
    const format = extname(path).toLowerCase()
    const source: ProjectSourceFile = {
      relativePath: sourceRelativePath,
      sha256,
      byteSize: (await stat(path)).size,
      format: format.slice(1) || 'unknown',
      origin: {sourceRoot: sourceDir, relativePath: sourceRelativePath},
      status: 'complete',
      artifactPaths: [],
      warnings: [],
    }
    summary.sources.push(source)
    const key = createHash('sha256')
      .update(sourceRelativePath)
      .digest('hex')
      .slice(0, 16)
    const folder = join(outDir, 'files', `${key}-${sha256.slice(0, 16)}`)
    await mkdir(folder, {recursive: true})
    const origin = {sourceRelativePath, sourceSha256: sha256}
    async function artifact(
      file: string,
      kind: ProjectSourceArtifact['kind'],
      detail: Omit<
        ProjectSourceArtifact['origin'],
        'sourceRelativePath' | 'sourceSha256'
      >,
    ): Promise<void> {
      const relativePath = portable(relative(outDir, file))
      if (relativePath.startsWith('../') || isAbsolute(relativePath))
        throw new Error('Extraction artifact escaped output directory')
      const result: ProjectSourceArtifact = {
        relativePath,
        sha256: await hashFile(file),
        byteSize: (await stat(file)).size,
        kind,
        origin: {...origin, ...detail},
      }
      summary.artifacts.push(result)
      source.artifactPaths.push(relativePath)
      if (kind === 'image') summary.images.push(result)
    }
    function needs(...names: string[]): boolean {
      const missing = names.filter(name => !available.has(name))
      if (!missing.length) return true
      source.status = 'partial'
      source.warnings.push(
        `Missing dependencies: ${missing.join(', ')}. Install them explicitly and rerun; no installation was attempted.`,
      )
      return false
    }
    async function readText(
      file: string,
      extraction: 'text' | 'pdf_text' | 'workbook_cells',
    ): Promise<void> {
      await artifact(file, 'text', {extraction})
      textSections.push(
        `## Source: ${sourceRelativePath}`,
        '',
        await readFile(file, 'utf8'),
        '',
      )
    }
    try {
      if (IMAGE_EXTENSIONS.has(format)) {
        const file = join(folder, `original${format}`)
        await copyFile(path, file)
        await artifact(file, 'image', {extraction: 'copy'})
      } else if (TEXT_EXTENSIONS.has(format)) {
        const file = join(folder, 'text.txt')
        await copyFile(path, file)
        await readText(file, 'text')
      } else if (format === '.pdf') {
        if (needs('pdftotext')) {
          const file = join(folder, 'text.txt')
          await command('pdftotext', ['-layout', path, file])
          await readText(file, 'pdf_text')
        }
        if (needs('pdftoppm')) {
          await command('pdftoppm', [
            '-scale-to',
            '1600',
            '-png',
            path,
            join(folder, 'page'),
          ])
          const pages = (await readdir(folder))
            .filter(name => /^page-\d+\.png$/.test(name))
            .sort(
              (a, b) =>
                Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]),
            )
          for (const page of pages)
            await artifact(join(folder, page), 'image', {
              extraction: 'pdf_page',
              page: Number(page.match(/\d+/)?.[0]),
            })
        }
      } else if (format === '.xlsx' || format === '.xlsm') {
        if (needs('python3')) {
          await command('python3', [
            '-c',
            EXTRACT_WORKBOOK_PYTHON,
            path,
            folder,
          ])
          const workbook: WorkbookExtraction = JSON.parse(
            await readFile(join(folder, 'workbook.json'), 'utf8'),
          )
          await artifact(join(folder, 'workbook.json'), 'metadata', {
            extraction: 'workbook_cells',
          })
          await readText(join(folder, 'text.txt'), 'workbook_cells')
          for (const image of workbook.images) {
            await artifact(join(folder, image.file), 'image', {
              extraction: 'workbook_media',
              workbookMediaPath: image.workbookMediaPath,
              placements: image.placements,
            })
          }
          source.warnings.push(...workbook.warnings)
          if (workbook.warnings.length) source.status = 'partial'
        }
      } else if (VIDEO_EXTENSIONS.has(format)) {
        if (needs('ffprobe')) {
          const metadataText = await command('ffprobe', [
            '-v',
            'error',
            '-show_format',
            '-show_streams',
            '-of',
            'json',
            path,
          ])
          const metadataFile = join(folder, 'video.json')
          await writeFile(metadataFile, metadataText)
          await artifact(metadataFile, 'metadata', {
            extraction: 'video_metadata',
          })
          const metadata: {
            format?: {duration?: string}
            streams?: {codec_type?: string; duration?: string}[]
          } = JSON.parse(metadataText)
          const video = metadata.streams?.find(
            stream => stream.codec_type === 'video',
          )
          if (!video) throw new Error('No video stream found')
          if (needs('ffmpeg')) {
            const duration = Number(video.duration ?? metadata.format?.duration)
            const times =
              Number.isFinite(duration) && duration > 0
                ? [0, duration * 0.5, duration * 0.9]
                : [0]
            if (times.length === 1)
              source.warnings.push(
                'Duration unavailable; extracted the first video frame only.',
              )
            for (let index = 0; index < times.length; index++) {
              const time = Number(times[index]!.toFixed(6))
              const file = join(folder, `frame-${index + 1}.png`)
              await command('ffmpeg', [
                '-v',
                'error',
                '-nostdin',
                '-y',
                '-ss',
                String(time),
                '-i',
                path,
                '-map',
                '0:v:0',
                '-frames:v',
                '1',
                file,
              ])
              await artifact(file, 'image', {
                extraction: 'video_frame',
                requestedTimestampSeconds: time,
              })
            }
          }
        } else needs('ffmpeg')
      } else {
        source.status = 'listed'
      }
    } catch (error) {
      source.status = source.artifactPaths.length ? 'partial' : 'failed'
      source.warnings.push(
        (error instanceof Error ? error.message : String(error)).slice(0, 3000),
      )
    }
    if ((await hashFile(path)) !== sha256) {
      source.status = 'failed'
      source.warnings.push(
        'Source changed during extraction; provenance is not reliable. Rerun after source changes stop.',
      )
    }
    if (source.status === 'partial' || source.status === 'failed')
      summary.status = 'partial'
    summary.warnings.push(
      ...source.warnings.map(warning => `${sourceRelativePath}: ${warning}`),
    )
  }
  await writeFile(summary.textPath, `${textSections.join('\n')}\n`)
  await writeFile(
    summary.imagesManifestPath,
    `${JSON.stringify({schemaVersion: SCHEMA, sourceDir, outDir, images: summary.images}, null, 2)}\n`,
  )
  await writeFile(summary.summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
  return summary
}
