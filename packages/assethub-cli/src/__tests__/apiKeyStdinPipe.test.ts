import {spawn} from 'node:child_process'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {expect, it} from 'vitest'

// Git Bash's mintty window gives node a pipe instead of a terminal. A key
// pasted there and followed by Enter must finish the login even though the
// pipe never reaches end-of-input. Plain piped input keeps working.
const cli = resolve(fileURLToPath(import.meta.url), '../../../dist/index.js')

const login = async (
  input: string,
  closeStdin: boolean,
): Promise<{code: number | null; output: string; apiKey?: string}> => {
  const directory = await mkdtemp(join(tmpdir(), 'assethub-stdin-pipe-'))
  try {
    const configPath = join(directory, 'config.json')
    const child = spawn(
      process.execPath,
      [cli, 'auth', 'login', '--api-key-stdin', '--skip-verify', '--base-url', 'http://127.0.0.1:9'],
      {env: {...process.env, ASSETHUB_CLI_CONFIG: configPath}, stdio: ['pipe', 'pipe', 'pipe']},
    )
    let output = ''
    child.stdout.on('data', chunk => (output += chunk))
    child.stderr.on('data', chunk => (output += chunk))
    child.stdin.write(input)
    if (closeStdin) child.stdin.end()
    const code = await new Promise<number | null>(done => {
      const timer = setTimeout(() => {
        child.kill()
        done(-1)
      }, 15_000)
      child.on('exit', exitCode => {
        clearTimeout(timer)
        done(exitCode)
      })
    })
    child.stdin.destroy()
    const apiKey = await readFile(configPath, 'utf8')
      .then(text => JSON.parse(text).profiles.default.apiKey as string)
      .catch(() => undefined)
    return {code, output, apiKey}
  } finally {
    await rm(directory, {recursive: true, force: true})
  }
}

it('finishes on Enter when stdin is a pipe that stays open', async () => {
  const result = await login('sk_pipe_secret\r\n', false)
  expect(result.code, result.output).toBe(0)
  expect(result.apiKey).toBe('sk_pipe_secret')
  expect(result.output).not.toContain('sk_pipe_secret')
}, 30_000)

it('skips blank lines before the key', async () => {
  const result = await login('\n  \nsk_after_blank\n', false)
  expect(result.code, result.output).toBe(0)
  expect(result.apiKey).toBe('sk_after_blank')
}, 30_000)

it('still reads piped input without a trailing newline', async () => {
  const result = await login('sk_no_newline', true)
  expect(result.code, result.output).toBe(0)
  expect(result.apiKey).toBe('sk_no_newline')
}, 30_000)
