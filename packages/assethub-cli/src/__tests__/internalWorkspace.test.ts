import {execFile} from 'node:child_process'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {promisify} from 'node:util'
import {expect, it} from 'vitest'

// @testdoc Built internal commands preserve explicit/profile workspace scope and send numeric canvas IDs without any network access.
it('sends the selected workspace and numeric canvas through the built memorize command', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'assethub-internal-workspace-'),
  )
  const config = join(directory, 'config.json')
  const capture = join(directory, 'request.json')
  const preload = join(directory, 'capture.mjs')
  const workspace = '11111111-1111-4111-8111-111111111111'
  const override = '22222222-2222-4222-8222-222222222222'
  try {
    await writeFile(
      preload,
      `
      import {writeFile} from 'node:fs/promises';
      globalThis.fetch = async (url, init) => {
        await writeFile(process.env.CLI_REQUEST_CAPTURE, JSON.stringify({
          url, method: init.method, headers: Object.fromEntries(new Headers(init.headers)),
          body: JSON.parse(init.body),
        }));
        return Response.json({success: true, data: {
          memorizeJobId: 'job-1', graphId: 'graph-1', canvasId: 42, nodeIds: null,
        }});
      };
    `,
    )
    for (const scenario of [
      {
        workspaceId: workspace,
        args: [],
        expected: workspace,
        environmentKey: 'stale-personal-key',
        expectedKey: 'test-key',
      },
      {
        workspaceId: workspace,
        args: ['--workspace', override],
        expected: override,
        environmentKey: '',
        expectedKey: 'test-key',
      },
      {
        workspaceId: undefined,
        args: [],
        expected: undefined,
        environmentKey: '',
        expectedKey: 'test-key',
      },
      {
        workspaceId: workspace,
        args: ['--api-key', 'override-key'],
        expected: undefined,
        environmentKey: '',
        expectedKey: 'override-key',
      },
      {
        workspaceId: undefined,
        args: ['--workspace', override],
        expected: override,
        environmentKey: 'environment-key',
        expectedKey: 'environment-key',
      },
    ]) {
      await writeFile(
        config,
        JSON.stringify({
          defaultProfile: 'test',
          profiles: {
            test: {
              apiKey: 'test-key',
              baseUrl: 'https://api.test',
              workspaceId: scenario.workspaceId,
            },
          },
        }),
      )
      const {stdout} = await promisify(execFile)(
        process.execPath,
        [
          '--import',
          preload,
          resolve('packages/assethub-cli/dist/index.js'),
          'memory',
          'memorize',
          '--canvas',
          '42',
          '--config',
          config,
          ...scenario.args,
        ],
        {
          env: {
            ...process.env,
            ASSETHUB_API_KEY: scenario.environmentKey,
            ASSETHUB_API_BASE_URL: 'https://api.test',
            CLI_REQUEST_CAPTURE: capture,
          },
        },
      )
      const request = JSON.parse(await readFile(capture, 'utf8'))
      expect(request.headers['x-assethub-workspace']).toBe(scenario.expected)
      expect(request.headers.authorization).toBe(`Bearer ${scenario.expectedKey}`)
      expect(request).toMatchObject({
        url: 'https://api.test/api/v2/memory/memorize',
        method: 'POST',
        body: {canvasId: 42, selection: {kind: 'whole'}},
      })
      expect(JSON.parse(stdout)).toMatchObject({
        memorizeJobId: 'job-1',
        canvasId: 42,
      })
    }
    await rm(capture)
    for (const canvas of ['0', '42.5', 'canvas_1']) {
      await expect(
        promisify(execFile)(
          process.execPath,
          [
            '--import',
            preload,
            resolve('packages/assethub-cli/dist/index.js'),
            'memory',
            'memorize',
            '--canvas',
            canvas,
            '--config',
            config,
          ],
          {
            env: {
              ...process.env,
              ASSETHUB_API_KEY: '',
              ASSETHUB_API_BASE_URL: 'https://api.test',
              CLI_REQUEST_CAPTURE: capture,
            },
          },
        ),
      ).rejects.toThrow('--canvas must be a positive integer')
    }
    await expect(readFile(capture)).rejects.toMatchObject({code: 'ENOENT'})
  } finally {
    await rm(directory, {recursive: true, force: true})
  }
})
