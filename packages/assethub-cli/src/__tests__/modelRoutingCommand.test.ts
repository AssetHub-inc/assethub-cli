import {spawn} from 'node:child_process'
import {createServer} from 'node:http'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {expect, it} from 'vitest'

// @testdoc A malformed native comparison is rejected before stdout so development scripts receive exactly one JSON error document.
it('prints one JSON document when the comparison receipt is malformed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'assethub-routing-cli-'))
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    response.writeHead(200, {'content-type': 'application/json'})
    response.end(JSON.stringify({success: true, data: {arms: []}}))
  })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No test port')
    const id = '42608b89-cc07-4a6b-a065-d1716b23bba0'
    const result = await new Promise<{code: number | null; stdout: string}>((resolve, reject) => {
      const child = spawn(process.execPath, [
        fileURLToPath(new URL('../../dist/index.js', import.meta.url)),
        'models', 'comparison', id,
      ], {
        env: {
          ...process.env,
          ASSETHUB_API_KEY: 'test-key',
          ASSETHUB_API_BASE_URL: `http://127.0.0.1:${address.port}`,
          ASSETHUB_CLI_CONFIG: join(directory, 'auth.json'),
          ASSETHUB_CLI_HOME: directory,
          ASSETHUB_NO_UPDATE_CHECK: '1',
          ASSETHUB_NO_AUTO_UPDATE: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.stderr.resume()
      child.on('error', reject)
      child.on('close', code => resolve({code, stdout}))
    })
    expect(result.code).toBe(2)
    expect(JSON.parse(result.stdout)).toMatchObject({error: {message: expect.stringContaining('expected two arms')}})
    expect(requests).toEqual([`GET /api/v2/models/comparisons/${id}`])
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(directory, {recursive: true, force: true})
  }
})
