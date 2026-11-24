import {spawnSync} from 'node:child_process'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {expect, it} from 'vitest'

// `auth login --api-key-stdin` typed into a terminal must prompt, finish on
// Enter and save the key, instead of waiting for end-of-input. Python's pty
// module gives the built CLI a real terminal without extra dependencies.
const cli = resolve(fileURLToPath(import.meta.url), '../../../dist/index.js')
const hasPython =
  process.platform !== 'win32' &&
  spawnSync('python3', ['-c', 'import pty'], {stdio: 'ignore'}).status === 0

const driver = `
import os, pty, select, sys, time
cli, config = sys.argv[1], sys.argv[2]
pid, fd = pty.fork()
if pid == 0:
    os.environ["ASSETHUB_CLI_CONFIG"] = config
    os.execvp("node", ["node", cli, "auth", "login", "--api-key-stdin", "--skip-verify", "--base-url", "http://127.0.0.1:9"])
out = b""
sent = False
deadline = time.time() + 15
while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.2)
    if ready:
        try:
            out += os.read(fd, 4096)
        except OSError:
            _, status = os.waitpid(pid, 0)
            sys.stdout.write(out.decode("utf8", "replace"))
            sys.exit(os.waitstatus_to_exitcode(status))
    if not sent and b"press Enter" in out:
        # The prompt is printed just before the terminal switches to raw mode.
        time.sleep(0.3)
        os.write(fd, b"sk_terminal_secret\\r")
        sent = True
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        sys.stdout.write(out.decode("utf8", "replace"))
        sys.exit(os.waitstatus_to_exitcode(status))
os.kill(pid, 9)
sys.stdout.write(out.decode("utf8", "replace"))
sys.exit(99)
`

it.skipIf(!hasPython)(
  'prompts in a terminal, finishes on Enter and saves the key without echoing it',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'assethub-stdin-tty-'))
    try {
      const configPath = join(directory, 'config.json')
      const result = spawnSync('python3', ['-I', '-c', driver, cli, configPath], {
        encoding: 'utf8',
        timeout: 30_000,
      })
      expect(result.status, result.stdout).toBe(0)
      expect(result.stdout).toContain('Paste your AssetHub API key and press Enter')
      expect(result.stdout).not.toContain('sk_terminal_secret')
      const config = JSON.parse(await readFile(configPath, 'utf8'))
      expect(config.profiles.default.apiKey).toBe('sk_terminal_secret')
    } finally {
      await rm(directory, {recursive: true, force: true})
    }
  },
  40_000,
)
