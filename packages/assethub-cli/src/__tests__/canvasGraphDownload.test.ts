import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, expect, it, vi} from 'vitest'

import {downloadCanvasGraphZip} from '../canvasGraphDownload.js'

const dirs: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, {recursive: true, force: true})))
})
const outDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assethub-zip-'))
  dirs.push(dir)
  return dir
}
const redirect = (location: string) => new Response(null, {status: 302, headers: {location}})
const zip = () => new Response('zip bytes', {status: 200})

it('follows a signer redirect to another public host, checking each hop', async () => {
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.redirect).toBe('manual')
    return url.startsWith('https://signed.test/') ? redirect('https://cdn.test/g7.zip') : zip()
  })
  vi.stubGlobal('fetch', fetchMock)
  const dir = await outDir()
  const result = await downloadCanvasGraphZip({url: 'https://signed.test/g7.zip?token=SECRET', destinationPath: join(dir, 'g7.zip')})
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['https://signed.test/g7.zip?token=SECRET', 'https://cdn.test/g7.zip'])
  expect(result.bytes).toBe(9)
  expect(await readFile(join(dir, 'g7.zip'), 'utf8')).toBe('zip bytes')
})

it.each([
  ['into this machine', 'http://127.0.0.1:8080/admin'],
  ['into a private network', 'https://192.168.1.10/x'],
  ['into cloud metadata', 'http://169.254.169.254/latest/meta-data'],
  ['from HTTPS down to HTTP', 'http://cdn.test/g7.zip'],
])('refuses a redirect %s and writes nothing', async (_label, location) => {
  const fetchMock = vi.fn(async () => redirect(location))
  vi.stubGlobal('fetch', fetchMock)
  const dir = await outDir()
  await expect(
    downloadCanvasGraphZip({url: 'https://signed.test/g7.zip?token=SECRET', destinationPath: join(dir, 'g7.zip')}),
  ).rejects.toThrow('Invalid download URL')
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(await readdir(dir)).toEqual([])
})

it('stops after five redirects', async () => {
  let n = 0
  vi.stubGlobal('fetch', vi.fn(async () => redirect(`https://cdn.test/${++n}`)))
  const dir = await outDir()
  await expect(
    downloadCanvasGraphZip({url: 'https://signed.test/g7.zip', destinationPath: join(dir, 'g7.zip')}),
  ).rejects.toThrow('Too many redirects')
  expect(n).toBe(6)
})
