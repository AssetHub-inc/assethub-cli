import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, describe, expect, it} from 'vitest'

import {ingestProjectSources} from '../projectSources.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(root => rm(root, {recursive: true, force: true})),
  )
})

describe('project source ingestion', () => {
  // Guards source immutability, deterministic reruns, and recursive ingestion of our own output.
  it('extracts source text and a tiny XLSX with neutral cell provenance on repeat runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assethub-project-ingest-'))
    roots.push(root)
    const note = 'EP013: background is an inference.\n'
    await writeFile(join(root, 'story.txt'), note)
    execFileSync('python3', [
      '-c',
      `
import sys,zipfile
from pathlib import Path
with zipfile.ZipFile(Path(sys.argv[1])/'scene.xlsx','w') as z:
 z.writestr('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="EP013" sheetId="1" r:id="rId1"/></sheets></workbook>')
 z.writestr('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
 z.writestr('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData><row r="6"><c r="A6" t="inlineStr"><is><t>s150</t></is></c><c r="C6" t="inlineStr"><is><t>layout is a label, not proof of 3D</t></is></c></row></sheetData><drawing r:id="d1"/></worksheet>')
 z.writestr('xl/worksheets/_rels/sheet1.xml.rels','<Relationships><Relationship Id="d1" Target="../drawings/drawing1.xml"/></Relationships>')
 z.writestr('xl/drawings/drawing1.xml','<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main"><xdr:oneCellAnchor><xdr:from><xdr:col>2</xdr:col><xdr:row>5</xdr:row></xdr:from><xdr:pic><a:blip r:embed="im1"/><a14:imgLayer r:embed="im2"/></xdr:pic></xdr:oneCellAnchor></xdr:wsDr>')
 z.writestr('xl/drawings/_rels/drawing1.xml.rels','<Relationships><Relationship Id="im1" Target="../media/image1.png"/><Relationship Id="im2" Target="../media/layer.wdp"/></Relationships>')
 z.writestr('xl/media/image1.png',b'original image bytes')
 z.writestr('xl/media/layer.wdp',b'original layered image bytes')
`,
      root,
    ])
    const workbookBefore = await readFile(join(root, 'scene.xlsx'))
    const outDir = join(root, 'extracted')
    const first = await ingestProjectSources({sourceDir: root, outDir})
    const second = await ingestProjectSources({sourceDir: root, outDir})
    expect(second).toEqual(first)
    expect(first.status).toBe('complete')
    expect(first.sources.map(source => source.relativePath)).toEqual([
      'scene.xlsx',
      'story.txt',
    ])
    expect(
      first.sources.find(source => source.relativePath === 'story.txt')?.sha256,
    ).toBe(createHash('sha256').update(note).digest('hex'))
    expect(first.images).toHaveLength(2)
    expect(first.images[0]?.origin).toMatchObject({
      sourceRelativePath: 'scene.xlsx',
      workbookMediaPath: 'xl/media/image1.png',
      placements: [{sheet: 'EP013', cell: 'C6', mapping: 'drawing_anchor'}],
    })
    expect(first.images[0]).not.toHaveProperty('role')
    expect(first.images[1]?.origin.placements).toEqual([
      {sheet: 'EP013', cell: 'C6', mapping: 'drawing_image_layer'},
    ])
    expect(
      await readFile(join(outDir, first.images[0]!.relativePath), 'utf8'),
    ).toBe('original image bytes')
    expect(await readFile(first.textPath, 'utf8')).toContain(
      'layout is a label, not proof of 3D',
    )
    expect(await readFile(join(root, 'scene.xlsx'))).toEqual(workbookBefore)
    expect(await readFile(join(root, 'story.txt'), 'utf8')).toBe(note)
    const another = await ingestProjectSources({
      sourceDir: root,
      outDir: join(root, 'second-output'),
    })
    expect(another.sources.map(source => source.relativePath)).toEqual([
      'scene.xlsx',
      'story.txt',
    ])
  }, 30_000)

  // Missing optional executables must leave a reviewable partial manifest, not trigger installation.
  it('records missing PDF tools while preserving and copying available image sources', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'assethub-project-missing-tools-'),
    )
    roots.push(root)
    await writeFile(join(root, 'source.pdf'), 'PDF bytes remain unchanged')
    await writeFile(join(root, 'source.png'), 'image bytes remain unchanged')
    const originalPath = process.env.PATH
    try {
      process.env.PATH = ''
      const result = await ingestProjectSources({
        sourceDir: root,
        outDir: join(root, 'output'),
      })
      expect(result.status).toBe('partial')
      expect(
        result.dependencies.every(dependency => !dependency.available),
      ).toBe(true)
      expect(result.warnings.join('\n')).toContain(
        'Missing dependencies: pdftotext',
      )
      expect(result.warnings.join('\n')).toContain(
        'Missing dependencies: pdftoppm',
      )
      expect(
        result.sources.find(source => source.relativePath === 'source.png')
          ?.status,
      ).toBe('complete')
      expect(result.images).toHaveLength(1)
      expect(await readFile(join(root, 'source.pdf'), 'utf8')).toBe(
        'PDF bytes remain unchanged',
      )
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }
  })

  // A mistaken output path must never overwrite the user-provided source directory.
  // Existing generated bundles live beside original project documents and must not become new inputs.
  it('excludes normalized relative directories and rejects exclusions outside the source root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assethub-project-exclude-'))
    roots.push(root)
    await mkdir(join(root, 'Generated_Review_Bundle', 'generated'), {
      recursive: true,
    })
    await writeFile(join(root, 'story.txt'), 'Original source')
    await writeFile(
      join(root, 'Generated_Review_Bundle', 'generated', 'candidate.txt'),
      'Derived candidate',
    )
    const result = await ingestProjectSources({
      sourceDir: root,
      outDir: join(root, 'output'),
      excludedDirectories: ['./Generated_Review_Bundle/'],
    })
    expect(result.sources.map(source => source.relativePath)).toEqual([
      'story.txt',
    ])
    expect(result.requestedExcludedDirectories).toEqual(['Generated_Review_Bundle'])
    expect(result.excludedDirectories).toContain('Generated_Review_Bundle')
    for (const excluded of ['../outside', root, '.']) {
      await expect(
        ingestProjectSources({
          sourceDir: root,
          outDir: join(root, 'output'),
          excludedDirectories: [excluded],
        }),
      ).rejects.toThrow('source root')
    }
  })

  // A mistaken output path must never overwrite the user-provided source directory.
  it('refuses to write extraction output over the source root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assethub-project-preserve-'))
    roots.push(root)
    await writeFile(join(root, 'summary.json'), 'original source document')
    await expect(
      ingestProjectSources({sourceDir: root, outDir: root}),
    ).rejects.toThrow('must differ')
    expect(await readFile(join(root, 'summary.json'), 'utf8')).toBe(
      'original source document',
    )
  })
})
