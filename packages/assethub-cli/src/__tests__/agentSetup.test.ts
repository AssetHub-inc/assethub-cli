import {execFile} from 'node:child_process'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {promisify} from 'node:util'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  canonicalSkillDir,
  initAgents,
  syncInstalledSkill,
} from '../agentSetup.js'
import {cliVersion} from '../setup.js'

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  )

describe('assethub init', () => {
  let home: string
  let cwd: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'assethub-init-home-'))
    cwd = await mkdtemp(join(tmpdir(), 'assethub-init-cwd-'))
    vi.stubEnv('ASSETHUB_CLI_HOME', home)
    vi.stubEnv('ASSETHUB_API_KEY', '')
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(home, {recursive: true, force: true})
    await rm(cwd, {recursive: true, force: true})
  })

  it('configures every detected agent, merging into existing files', async () => {
    await mkdir(join(home, '.claude'), {recursive: true})
    await mkdir(join(home, '.codex'), {recursive: true})
    // Existing settings on both sides must survive untouched.
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({
        theme: 'dark',
        mcpServers: {other: {command: 'other-mcp'}},
      }),
    )
    await writeFile(
      join(home, '.codex', 'config.toml'),
      'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other-mcp"\n',
    )

    const report = await initAgents({
      baseUrl: 'https://app.assethub.io',
      workspaceId: 'ws_123',
      home,
      cwd,
    })

    expect(report.scope).toBe('global')
    expect(report.agents.map(agent => agent.id)).toEqual(['claude-code', 'codex'])
    expect(report.skill.status).toBe('installed')
    expect(report.skill.version).toBe(await cliVersion())

    const claude = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'))
    expect(claude.theme).toBe('dark')
    expect(claude.mcpServers.other).toEqual({command: 'other-mcp'})
    expect(claude.mcpServers.assethub).toEqual({
      type: 'http',
      url: 'https://app.assethub.io/api/mcp',
      headers: {
        Authorization: 'Bearer ${ASSETHUB_API_KEY}',
        'X-AssetHub-Workspace': 'ws_123',
      },
    })

    const codex = await readFile(join(home, '.codex', 'config.toml'), 'utf8')
    expect(codex).toContain('model = "gpt-5"')
    expect(codex).toContain('[mcp_servers.other]\ncommand = "other-mcp"')
    expect(codex).toContain(
      '[mcp_servers.assethub]\nurl = "https://app.assethub.io/api/mcp"\nbearer_token_env_var = "ASSETHUB_API_KEY"',
    )
    expect(codex).not.toContain('ah_live')

    // The skill lives once under ~/.agents and is linked into each agent.
    const canonical = canonicalSkillDir(home)
    expect(await readFile(join(canonical, 'SKILL.md'), 'utf8')).toContain('name: assethub')
    expect((await readFile(join(canonical, '.assethub-cli-version'), 'utf8')).trim()).toBe(
      await cliVersion(),
    )
    for (const dir of ['.claude/skills', '.codex/skills']) {
      const link = join(home, dir, 'assethub')
      expect((await lstat(link)).isSymbolicLink()).toBe(true)
      expect(resolve(join(home, dir), await readlink(link))).toBe(canonical)
    }
    expect(await exists(join(home, '.cursor'))).toBe(false)
    expect(report.next.join(' ')).toContain('ASSETHUB_API_KEY')
  })

  it('is idempotent and replaces a stale codex table in place', async () => {
    await mkdir(join(home, '.codex'), {recursive: true})
    await writeFile(
      join(home, '.codex', 'config.toml'),
      '[mcp_servers.assethub]\nurl = "https://old.example/api/mcp"\nbearer_token_env_var = "OLD"\n\n[mcp_servers.other]\ncommand = "other-mcp"\n',
    )
    const first = await initAgents({baseUrl: 'https://app.assethub.io', home, cwd})
    expect(first.agents[0].mcp.status).toBe('updated')
    const codex = await readFile(join(home, '.codex', 'config.toml'), 'utf8')
    expect(codex).not.toContain('old.example')
    expect(codex.match(/\[mcp_servers\.assethub\]/g)).toHaveLength(1)
    expect(codex).toContain('[mcp_servers.other]\ncommand = "other-mcp"')

    const second = await initAgents({baseUrl: 'https://app.assethub.io', home, cwd})
    expect(second.agents[0].mcp.status).toBe('unchanged')
    expect(second.agents[0].skill.status).toBe('unchanged')
    expect(second.skill.status).toBe('unchanged')
  })

  it('writes project-level config into the working directory when asked', async () => {
    await mkdir(join(home, '.cursor'), {recursive: true})
    const report = await initAgents({
      baseUrl: 'https://app.assethub.io',
      agents: ['cursor', 'claude-code'],
      project: true,
      home,
      cwd,
    })
    expect(report.scope).toBe('project')
    expect(report.agents.find(agent => agent.id === 'claude-code')?.detected).toBe(false)
    const cursor = JSON.parse(await readFile(join(cwd, '.cursor', 'mcp.json'), 'utf8'))
    expect(cursor.mcpServers.assethub.headers.Authorization).toBe('Bearer ${env:ASSETHUB_API_KEY}')
    const claude = JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8'))
    expect(claude.mcpServers.assethub.type).toBe('http')
    expect(await exists(join(home, '.claude.json'))).toBe(false)
  })

  it('reports without writing under --dry-run', async () => {
    await mkdir(join(home, '.claude'), {recursive: true})
    const report = await initAgents({baseUrl: 'https://app.assethub.io', dryRun: true, home, cwd})
    expect(report.dryRun).toBe(true)
    expect(report.agents[0].mcp.status).toBe('created')
    expect(report.skill.status).toBe('installed')
    expect(await exists(join(home, '.claude.json'))).toBe(false)
    expect(await exists(canonicalSkillDir(home))).toBe(false)
    expect(await exists(join(home, '.claude', 'skills'))).toBe(false)
  })

  it('never overwrites a directory it did not create', async () => {
    await mkdir(join(home, '.claude', 'skills', 'assethub'), {recursive: true})
    await writeFile(join(home, '.claude', 'skills', 'assethub', 'SKILL.md'), 'mine')
    await mkdir(canonicalSkillDir(home), {recursive: true})
    await writeFile(join(canonicalSkillDir(home), 'SKILL.md'), 'also mine')
    const report = await initAgents({baseUrl: 'https://app.assethub.io', home, cwd})
    expect(report.skill.status).toBe('kept-existing')
    expect(report.agents[0].skill.status).toBe('kept-existing')
    expect(await readFile(join(home, '.claude', 'skills', 'assethub', 'SKILL.md'), 'utf8')).toBe('mine')
    expect(await readFile(join(canonicalSkillDir(home), 'SKILL.md'), 'utf8')).toBe('also mine')
  })

  it('refuses unknown agents, an empty machine, and unparseable config', async () => {
    await expect(
      initAgents({baseUrl: 'https://app.assethub.io', agents: ['vim'], home, cwd}),
    ).rejects.toThrow('Unknown agent: vim')
    await expect(initAgents({baseUrl: 'https://app.assethub.io', home, cwd})).rejects.toThrow(
      'No supported coding agent found',
    )
    await mkdir(join(home, '.cursor'), {recursive: true})
    await writeFile(join(home, '.cursor', 'mcp.json'), '{not json')
    await expect(initAgents({baseUrl: 'https://app.assethub.io', home, cwd})).rejects.toThrow(
      'is not valid JSON',
    )
    expect(await readFile(join(home, '.cursor', 'mcp.json'), 'utf8')).toBe('{not json')
  })

  it('refreshes an installed skill after a CLI upgrade and stays quiet otherwise', async () => {
    await mkdir(join(home, '.claude'), {recursive: true})
    await initAgents({baseUrl: 'https://app.assethub.io', home, cwd})
    const canonical = canonicalSkillDir(home)
    await writeFile(join(canonical, '.assethub-cli-version'), '0.0.1\n')
    await writeFile(join(canonical, 'SKILL.md'), 'stale')

    await syncInstalledSkill()

    expect((await readFile(join(canonical, '.assethub-cli-version'), 'utf8')).trim()).toBe(
      await cliVersion(),
    )
    expect(await readFile(join(canonical, 'SKILL.md'), 'utf8')).toContain('name: assethub')
    expect(await exists(`${canonical}.next`)).toBe(false)
  })
})

// The installed binary is what users run; a real process proves the command is
// wired, prints one JSON object, and honors ASSETHUB_CLI_HOME.
it('runs through the built entrypoint', async () => {
  const home = await mkdtemp(join(tmpdir(), 'assethub-init-bin-'))
  try {
    await mkdir(join(home, '.cursor'), {recursive: true})
    const {stdout} = await promisify(execFile)(
      process.execPath,
      [resolve('packages/assethub-cli/dist/index.js'), 'init', '--dry-run', '--base-url', 'https://app.assethub.io'],
      {env: {...process.env, ASSETHUB_CLI_HOME: home, ASSETHUB_API_BASE_URL: undefined}},
    )
    const report = JSON.parse(stdout)
    expect(report.dryRun).toBe(true)
    expect(report.agents.map((agent: {id: string}) => agent.id)).toEqual(['cursor'])
    expect(report.agents[0].mcp.path).toBe(join(home, '.cursor', 'mcp.json'))
    expect(await exists(join(home, '.cursor', 'mcp.json'))).toBe(false)
  } finally {
    await rm(home, {recursive: true, force: true})
  }
})
