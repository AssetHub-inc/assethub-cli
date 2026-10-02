import {execFile} from 'node:child_process'
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  canonicalSkillDir,
  detectAgents,
  installAgentSkills,
  mergeJsonServer,
  mcpServerEntry,
  parseAgentIds,
  syncInstalledSkill,
  skillLinkTarget,
} from '../agentSetup.js'
import {cliVersion} from '../setup.js'

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  )

describe('agent selection', () => {
  it('accepts repeated and comma separated names, and claude for claude-code', () => {
    expect(parseAgentIds(['cursor', 'claude,codex'])).toEqual(['claude-code', 'codex', 'cursor'])
    expect(parseAgentIds(['Claude-Code'])).toEqual(['claude-code'])
    expect(() => parseAgentIds(['vim'])).toThrow('Unknown agent: vim')
  })

  it('detects an agent by its home folder or its command on PATH', async () => {
    const home = await mkdtemp(join(tmpdir(), 'assethub-detect-'))
    try {
      await mkdir(join(home, '.codex'))
      const found = await detectAgents(home, async name => (name === 'cursor' ? '/bin/cursor' : undefined))
      expect(found).toEqual(['codex', 'cursor'])
      expect(await detectAgents(home, async () => undefined)).toEqual(['codex'])
      // Codex is also found by $CODEX_HOME.
      await rm(join(home, '.codex'), {recursive: true})
      expect(await detectAgents(home, async () => undefined, home)).toEqual(['codex'])
    } finally {
      await rm(home, {recursive: true, force: true})
    }
  })
})

describe('mergeJsonServer', () => {
  const entry = mcpServerEntry('cursor', 'https://app.assethub.io', 'ws_123')

  it('adds the entry and keeps every other key', () => {
    const merged = JSON.parse(
      mergeJsonServer('/x/mcp.json', JSON.stringify({theme: 'dark', mcpServers: {other: {command: 'o'}}}), entry),
    )
    expect(merged.theme).toBe('dark')
    expect(merged.mcpServers.other).toEqual({command: 'o'})
    expect(merged.mcpServers.assethub).toEqual({
      url: 'https://app.assethub.io/api/mcp',
      headers: {Authorization: 'Bearer ${env:ASSETHUB_API_KEY}', 'X-AssetHub-Workspace': 'ws_123'},
    })
  })

  it('returns the same text when the entry already matches', () => {
    const once = mergeJsonServer('/x/mcp.json', undefined, entry)
    expect(mergeJsonServer('/x/mcp.json', once, entry)).toBe(once)
  })

  it('refuses unparseable JSON and a malformed mcpServers instead of replacing them', () => {
    expect(() => mergeJsonServer('/x/mcp.json', '{not json', entry)).toThrow('is not valid JSON')
    expect(() => mergeJsonServer('/x/mcp.json', '[]', entry)).toThrow('must contain a JSON object')
    expect(() => mergeJsonServer('/x/mcp.json', '{"mcpServers": []}', entry)).toThrow('non-object "mcpServers"')
  })
})

describe('installAgentSkills', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'assethub-skills-home-'))
    vi.stubEnv('ASSETHUB_CLI_HOME', home)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(home, {recursive: true, force: true})
  })

  it('copies the skill once and links it into each agent, idempotently', async () => {
    const first = await installAgentSkills({root: home, agents: ['claude-code', 'codex'], dryRun: false})
    expect(first.status).toBe('installed')
    expect(first.version).toBe(await cliVersion())
    expect(first.links.map(link => link.status)).toEqual(['linked', 'linked'])

    const canonical = canonicalSkillDir(home)
    expect(await readFile(join(canonical, 'SKILL.md'), 'utf8')).toContain('name: assethub')
    for (const dir of ['.claude/skills', '.codex/skills']) {
      const link = join(home, dir, 'assethub')
      expect((await lstat(link)).isSymbolicLink()).toBe(true)
      expect(resolve(join(home, dir), await readlink(link))).toBe(canonical)
    }
    expect(await exists(join(home, '.cursor'))).toBe(false)

    const second = await installAgentSkills({root: home, agents: ['claude-code', 'codex'], dryRun: false})
    expect(second.status).toBe('unchanged')
    expect(second.links.map(link => link.status)).toEqual(['unchanged', 'unchanged'])
  })

  it('reports without writing under a dry run', async () => {
    const report = await installAgentSkills({root: home, agents: ['claude-code'], dryRun: true})
    expect(report.status).toBe('installed')
    expect(report.links[0].status).toBe('linked')
    expect(await exists(canonicalSkillDir(home))).toBe(false)
    expect(await exists(join(home, '.claude', 'skills'))).toBe(false)
  })

  it('links with a relative path inside a project, so the folder can be committed', async () => {
    const project = join(home, 'repo')
    await installAgentSkills({root: project, agents: ['cursor'], dryRun: false})
    expect(await readlink(join(project, '.cursor', 'skills', 'assethub'))).toBe(join('..', '..', '.agents', 'skills', 'assethub'))
  })

  it('never overwrites a directory it did not create', async () => {
    await mkdir(join(home, '.claude', 'skills', 'assethub'), {recursive: true})
    await writeFile(join(home, '.claude', 'skills', 'assethub', 'SKILL.md'), 'mine')
    await mkdir(canonicalSkillDir(home), {recursive: true})
    await writeFile(join(canonicalSkillDir(home), 'SKILL.md'), 'also mine')
    const report = await installAgentSkills({root: home, agents: ['claude-code'], dryRun: false})
    expect(report.status).toBe('kept-existing')
    expect(report.links[0].status).toBe('kept-existing')
    expect(await readFile(join(home, '.claude', 'skills', 'assethub', 'SKILL.md'), 'utf8')).toBe('mine')
    expect(await readFile(join(canonicalSkillDir(home), 'SKILL.md'), 'utf8')).toBe('also mine')
  })

  it('never replaces a newer skill with an older CLI', async () => {
    await installAgentSkills({root: home, agents: ['claude-code'], dryRun: false})
    const canonical = canonicalSkillDir(home)
    await writeFile(join(canonical, '.assethub-cli-version'), '99.0.0\n')
    await writeFile(join(canonical, 'SKILL.md'), 'from the future')
    const report = await installAgentSkills({root: home, agents: ['claude-code'], dryRun: false})
    expect(report).toMatchObject({status: 'kept-newer', version: '99.0.0'})
    expect(await readFile(join(canonical, 'SKILL.md'), 'utf8')).toBe('from the future')
  })

  it('refreshes an installed skill after a CLI upgrade and stays quiet otherwise', async () => {
    await installAgentSkills({root: home, agents: ['claude-code'], dryRun: false})
    const canonical = canonicalSkillDir(home)
    await writeFile(join(canonical, '.assethub-cli-version'), '0.0.1\n')
    await writeFile(join(canonical, 'SKILL.md'), 'stale')

    await syncInstalledSkill()

    expect((await readFile(join(canonical, '.assethub-cli-version'), 'utf8')).trim()).toBe(
      await cliVersion(),
    )
    expect(await readFile(join(canonical, 'SKILL.md'), 'utf8')).toContain('name: assethub')
    // No staging or backup directory is left beside the installed skill.
    expect(await readdir(dirname(canonical))).toEqual(['assethub'])
  })
})

// The installed binary is what users run; a real process proves the commands
// are wired and honor ASSETHUB_CLI_HOME.
describe('built entrypoint', () => {
  let home: string
  const cli = (args: string[]) =>
    promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../dist/index.js', import.meta.url)), ...args], {
      env: {
        ...process.env,
        ASSETHUB_CLI_HOME: home,
        ASSETHUB_CLI_CONFIG: join(home, 'config.json'),
        ASSETHUB_API_BASE_URL: undefined,
        ASSETHUB_API_KEY: undefined,
        CODEX_HOME: join(home, '.codex'),
        PATH: dirname(process.execPath),
      },
    })

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'assethub-setup-bin-'))
  })

  afterEach(async () => {
    await rm(home, {recursive: true, force: true})
  })

  it('keeps init as a deprecated alias for agent wiring only', async () => {
    await mkdir(join(home, '.cursor'), {recursive: true})
    const {stdout, stderr} = await cli(['init', '--dry-run', '--base-url', 'https://app.assethub.io'])
    expect(stderr).toContain('`assethub init` is deprecated')
    const report = JSON.parse(stdout)
    expect(report.dryRun).toBe(true)
    expect(report.agents).toEqual(['cursor'])
    expect(report.steps.map((step: {name: string}) => step.name)).toEqual(['agents', 'cursor-mcp', 'skills'])
    // The fields init reported are still there.
    expect(report.version).toBe(await cliVersion())
    expect(report.scope).toBe('global')
    expect(report.detected).toEqual(['cursor'])
    expect(report.skill).toMatchObject({path: canonicalSkillDir(home), status: 'installed'})
    expect(report.steps.find((step: {name: string}) => step.name === 'cursor-mcp').path).toBe(join(home, '.cursor', 'mcp.json'))
    expect(await exists(join(home, '.cursor', 'mcp.json'))).toBe(false)
  })

  it('wires agents with --only mcp,skills, then doctor --setup finds nothing to fix', async () => {
    const setup = await cli(['setup', '--only', 'mcp,skills', '--agent', 'cursor,codex', '--base-url', 'https://app.assethub.io', '--yes', '--json'])
    const report = JSON.parse(setup.stdout)
    expect(report.ok).toBe(true)
    expect(report.steps.map((step: {name: string}) => step.name)).toEqual(['agents', 'codex-mcp', 'cursor-mcp', 'skills'])
    expect(await readFile(join(home, '.codex', 'config.toml'), 'utf8')).toContain('[mcp_servers.assethub]')
    expect(await readFile(join(home, '.cursor', 'skills', 'assethub', 'SKILL.md'), 'utf8')).toContain('name: assethub')

    // doctor fails on the API (no key here) but its setup check passes.
    const doctor = await cli(['doctor', '--setup', '--agent', 'cursor,codex', '--base-url', 'https://app.assethub.io']).catch(
      (error: {stdout: string}) => error,
    )
    const setupCheck = JSON.parse(doctor.stdout).checks.find((check: {name: string}) => check.name === 'setup')
    expect(setupCheck.status).toBe('pass')

    await writeFile(join(home, '.cursor', 'mcp.json'), '{}')
    const stale = await cli(['doctor', '--setup', '--agent', 'cursor', '--base-url', 'https://app.assethub.io']).catch(
      (error: {stdout: string}) => error,
    )
    const staleCheck = JSON.parse(stale.stdout).checks.find((check: {name: string}) => check.name === 'setup')
    expect(staleCheck.status).toBe('fail')
    expect(staleCheck.message).toContain('cursor-mcp')
    expect(staleCheck.hint).toContain('assethub setup')
  })

  it('rejects an unknown step', async () => {
    await expect(cli(['setup', '--skip', 'everything'])).rejects.toMatchObject({
      stderr: expect.stringContaining('Unknown setup step for --skip: everything'),
    })
  })
})

describe('skillLinkTarget', () => {
  it('uses a junction with an absolute target on Windows, which needs no Developer Mode', () => {
    expect(skillLinkTarget('win32', 'C:\\Users\\u\\.claude\\skills', 'C:\\Users\\u\\.agents\\skills\\assethub')).toEqual({
      target: 'C:\\Users\\u\\.agents\\skills\\assethub',
      type: 'junction',
    })
  })

  it('keeps a relative directory symlink elsewhere', () => {
    expect(skillLinkTarget('darwin', '/Users/u/.claude/skills', '/Users/u/.agents/skills/assethub')).toEqual({
      target: '../../.agents/skills/assethub',
      type: 'dir',
    })
  })
})
