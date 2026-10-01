import {mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile} from 'node:fs/promises'
import {readFileSync, writeFileSync} from 'node:fs'
import {execFile} from 'node:child_process'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {
  buildSessionGraphFolder,
  installHooks,
  runHooksCommand,
  saveSession,
  uninstallHooks,
  uploadPending,
  uploadSession,
} from '../hooks/index.js'
import {chunkTranscript, compactLimits} from '../hooks/graph.js'
import {MAX_SETTINGS_BACKUPS, isOurCommand, sessionSaveDisclosure} from '../hooks/install.js'
import {readMeta, updateMeta} from '../hooks/paths.js'
import {materializeSession} from '../hooks/save.js'
import {redactText} from '../hooks/redact.js'
import {buildRunUploadPlan} from '../runsUpload/buildRunUpload.js'
import {readGraphFolder} from '../runsUpload/graphFolder.js'

// 1x1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const SECRET = 'ah_live_abcdef1234567890' // gitleaks:allow
// Provider-shaped test tokens are assembled at runtime so no literal token
// is committed (GitHub push protection rejects them even when fake).
const fake = (...parts: string[]): string => parts.join('_')

let root: string
let home: string
let cwd: string

const jsonl = (...entries: unknown[]): string => `${entries.map(e => JSON.stringify(e)).join('\n')}\n`

const transcriptFor = (imagePath: string): string =>
  jsonl(
    {type: 'user', timestamp: '2026-09-29T01:00:00.000Z', message: {role: 'user', content: `make a hero, key ${SECRET}`}},
    {
      type: 'assistant', timestamp: '2026-09-29T01:00:01.000Z',
      message: {role: 'assistant', content: [
        {type: 'text', text: 'Sure, generating.'},
        {type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {command: `ASSETHUB_API_KEY=${SECRET} assethub image generate --out ${imagePath}`}},
      ]},
    },
    {
      type: 'user', timestamp: '2026-09-29T01:00:02.000Z',
      message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 'toolu_1', content: `wrote ${imagePath}`}]},
    },
    {type: 'assistant', message: {role: 'assistant', content: [{type: 'text', text: 'Done.'}]}},
  )

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ah-hooks-'))
  home = join(root, 'home')
  cwd = join(root, 'project')
  await mkdir(home, {recursive: true})
  await mkdir(cwd, {recursive: true})
})
afterEach(() => rm(root, {recursive: true, force: true}))

const writeTranscript = async (imagePath = join(cwd, 'hero.png')): Promise<string> => {
  await writeFile(join(cwd, 'hero.png'), PNG)
  const path = join(root, 'transcript.jsonl')
  await writeFile(path, transcriptFor(imagePath))
  return path
}

const hook = (transcript: string, event: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({session_id: 'sess-1', transcript_path: transcript, cwd, hook_event_name: event, ...extra})

const now = () => new Date('2026-09-29T02:00:00.000Z')
const UPLOAD_OFF = {ASSETHUB_SESSION_UPLOAD: 'off'}

describe('redactText', () => {
  it('redacts JSON-style secret fields and keeps the line valid JSON', () => {
    const line = JSON.stringify({
      password: 'hunter2', // gitleaks:allow
      API_KEY: 'plainvalue123', // gitleaks:allow
      input: JSON.stringify({api_key: 'nested-secret-9', clientSecret: 'cs-777'}), // gitleaks:allow
      input_tokens: 5,
      name: 'top',
    })
    const out = redactText(line)
    for (const leaked of ['hunter2', 'plainvalue123', 'nested-secret-9', 'cs-777']) expect(out).not.toContain(leaked)
    const parsed = JSON.parse(out)
    expect(parsed.password).toBe('[REDACTED]')
    expect(parsed.API_KEY).toBe('[REDACTED]')
    expect(JSON.parse(parsed.input)).toEqual({api_key: '[REDACTED]', clientSecret: '[REDACTED]'})
    expect(parsed.input_tokens).toBe(5)
    expect(parsed.name).toBe('top')
  })

  const cases: [string, string][] = [
    ['key ah_live_abcdef1234567890 x', 'ah_live_'],
    ['ah_test_zzzzzzzzzzzz', 'ah_test_'],
    ['ah_pat_abcdefghijkl', 'ah_pat_'],
    ['sk_0123456789abcdef0123', 'sk_0123'],
    ['sk-ant-api03-abcdefghijklmnop', 'sk-ant-'],
    ['sk-proj-abcdefghijklmnopqrstuvwx', 'sk-proj'],
    ['Authorization: Bearer abc.def.ghi-12345', 'abc.def'],
    ['curl -H "Authorization: Bearer abc.def.ghi-12345"', 'abc.def'], // gitleaks:allow
    ['{"Authorization":"Basic dXNlcjpwYXNz"}', 'dXNlcjpwYXNz'],
    ['header xi-api-key: 1234567890abcdef', '1234567890abcdef'], // gitleaks:allow
    ['AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
    ['ASSETHUB_API_KEY=plainvalue123', 'plainvalue123'],
    ['export ELEVENLABS_API_KEY="abc123xyz"', 'abc123xyz'],
    ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG', 'wJalrXUtnFEMI'], // gitleaks:allow
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123', 'ghp_abc'],
    [fake('sk', 'live', '51Habcdefghijklmnopqrstuvwxyz'), '51Habc'],
    [fake('rk', 'test', '51Habcdefghijklmnop'), '51Habc'],
    [fake('whsec', 'abcdefghijklmnopqrstuvwx'), 'abcdefgh'],
    [fake('sb', 'secret', 'abcdefghijklmnopqrstuvwx'), 'abcdefgh'],
    [['eyJhbGciOiJIUzI1NiJ9', 'eyJyb2xlIjoieCJ9', 'abcdefghijk'].join('.'), 'abcdefghijk'],
    ['SUPABASE_SERVICE_ROLE_KEY=opaque-value-1234', 'opaque-value'], // gitleaks:allow
    ['DATABASE_URL=postgres://postgres:hunter2pass@db.x.supabase.co:5432/postgres', 'hunter2pass'], // gitleaks:allow
    ['psql "postgresql://admin:s3cretpw@localhost/db"', 's3cretpw'], // gitleaks:allow
    [['xoxb', '1234567890', 'abcdefghijklmnop'].join('-'), '1234567890'],
    [`AIza${'SyA1234567890abcdefghijklmnopqrstu'}`, 'SyA1234'],
    ['-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG\\n-----END PRIVATE KEY-----', 'MIIEvQ'], // gitleaks:allow
    ['{"service_role_key":"opaque-value-1234"}', 'opaque-value'], // gitleaks:allow
    ['PASSWORD=hunter2 npm start', 'hunter2'], // gitleaks:allow
    ['TOKEN=abc123def npm start', 'abc123def'], // gitleaks:allow
    ['DATABASE_URL=mysql://db.internal/app', 'db.internal'],
  ]
  it.each(cases)('redacts %s', (input, leaked) => {
    const out = redactText(input)
    expect(out).toContain('[REDACTED]')
    expect(out).not.toContain(leaked)
  })

  it('keeps variable names and ordinary text', () => {
    expect(redactText('ASSETHUB_API_KEY=abc')).toBe('ASSETHUB_API_KEY=[REDACTED]')
    expect(redactText('postgres://postgres:pw@db.test/x')).toBe('postgres://postgres:[REDACTED]@db.test/x')
    expect(redactText('see https://example.com/a.png and user@example.com')).toBe(
      'see https://example.com/a.png and user@example.com',
    )
    expect(redactText('hello world, task-list sk-short')).toBe('hello world, task-list sk-short')
  })

  it('keeps JSON lines valid', () => {
    const line = JSON.stringify({
      a: `Authorization: Bearer abcdefghijkl and ASSETHUB_API_KEY="${SECRET}"`,
      b: {headers: {Authorization: 'Bearer abcdefghijkl'}},
      c: `sk-ant-api03-abcdefghijklmnop\nnext`,
    })
    const out = redactText(line)
    expect(() => JSON.parse(out)).not.toThrow()
    expect(out).not.toMatch(/abcdefghijkl|ah_live_/)
  })
})

describe('installHooks / uninstallHooks', () => {
  const settingsPath = () => join(home, '.claude', 'settings.json')

  it('creates settings.json when missing', async () => {
    const result = await installHooks({client: 'claude', home})
    expect(result.installed).toBe(true)
    const settings = JSON.parse(await readFile(settingsPath(), 'utf8'))
    for (const event of ['Stop', 'PreCompact']) {
      expect(settings.hooks[event]).toEqual([
        {hooks: [{type: 'command', command: 'assethub hooks save', timeout: 30, async: true}]},
      ])
    }
    // SessionEnd stays synchronous; its timeout raises Claude Code's 1.5 s budget.
    expect(settings.hooks.SessionEnd).toEqual([
      {hooks: [{type: 'command', command: 'assethub hooks save', timeout: 10}]},
    ])
    expect((await readdir(join(home, '.claude'))).filter(n => n.includes('.tmp'))).toEqual([])
  })

  it('upgrades entries from an older install in place', async () => {
    await mkdir(join(home, '.claude'), {recursive: true})
    const old = {type: 'command', command: 'assethub hooks save', timeout: 30}
    await writeFile(
      settingsPath(),
      JSON.stringify({hooks: {Stop: [{hooks: [old]}], SessionEnd: [{hooks: [old]}], PreCompact: [{hooks: [old]}]}}),
    )
    await installHooks({client: 'claude', home})
    const settings = JSON.parse(await readFile(settingsPath(), 'utf8'))
    expect(settings.hooks.Stop).toEqual([{hooks: [{...old, async: true}]}])
    expect(settings.hooks.SessionEnd).toEqual([{hooks: [{...old, timeout: 10}]}])
  })

  it('keeps only the newest settings backups', async () => {
    await mkdir(join(home, '.claude'), {recursive: true})
    await writeFile(settingsPath(), '{}')
    for (const stamp of [1, 2, 3, 4, 5]) {
      await writeFile(join(home, '.claude', `settings.json.bak-${stamp}`), '{}')
    }
    await writeFile(join(home, '.claude', 'settings.json.bak-mine'), '{}')
    await installHooks({client: 'claude', home})
    const names = await readdir(join(home, '.claude'))
    const ours = names.filter(n => /^settings\.json\.bak-\d+$/.test(n))
    expect(ours).toHaveLength(MAX_SETTINGS_BACKUPS)
    expect(ours).not.toContain('settings.json.bak-1')
    expect(names).toContain('settings.json.bak-mine')
  })

  it('merges, backs up, keeps existing hooks, and is idempotent', async () => {
    await mkdir(join(home, '.claude'), {recursive: true})
    const original = {
      theme: 'dark',
      hooks: {Stop: [{hooks: [{type: 'command', command: 'echo mine'}]}], PreToolUse: [{matcher: 'Bash', hooks: [{type: 'command', command: 'x'}]}]},
    }
    await writeFile(settingsPath(), JSON.stringify(original))
    await installHooks({client: 'claude', home, cliPath: '/opt/assethub/bin/assethub'})
    const again = await installHooks({client: 'claude', home, cliPath: '/opt/assethub/bin/assethub'})
    expect(again.installed).toBe(true)

    const settings = JSON.parse(await readFile(settingsPath(), 'utf8'))
    expect(settings.theme).toBe('dark')
    expect(settings.hooks.PreToolUse).toEqual(original.hooks.PreToolUse)
    expect(settings.hooks.Stop).toHaveLength(2)
    expect(settings.hooks.Stop[0]).toEqual(original.hooks.Stop[0])
    const ours = JSON.stringify(settings).match(/\/opt\/assethub\/bin\/assethub hooks save/g)
    expect(ours).toHaveLength(4)

    const backups = (await readdir(join(home, '.claude'))).filter(n => n.startsWith('settings.json.bak-'))
    expect(backups).toHaveLength(1)
    expect(JSON.parse(await readFile(join(home, '.claude', backups[0]), 'utf8'))).toEqual(original)
  })

  it('replaces our entry when the cli path changes instead of duplicating', async () => {
    await installHooks({client: 'claude', home})
    await installHooks({client: 'claude', home, cliPath: '/new/assethub'})
    const settings = JSON.parse(await readFile(settingsPath(), 'utf8'))
    expect(settings.hooks.Stop).toHaveLength(1)
    expect(settings.hooks.Stop[0].hooks[0].command).toBe('/new/assethub hooks save')
  })

  it('refuses to overwrite invalid JSON', async () => {
    await mkdir(join(home, '.claude'), {recursive: true})
    await writeFile(settingsPath(), '{not json')
    const result = await installHooks({client: 'claude', home})
    expect(result.installed).toBe(false)
    expect(await readFile(settingsPath(), 'utf8')).toBe('{not json')
  })

  it('does not write codex hooks', async () => {
    expect(await installHooks({client: 'codex', home})).toEqual({
      installed: false,
      detail: 'Codex: run `assethub hooks save --transcript <path>` manually for now',
    })
    await expect(stat(settingsPath())).rejects.toThrow()
  })

  it('uninstall removes only our entries', async () => {
    await mkdir(join(home, '.claude'), {recursive: true})
    await writeFile(
      settingsPath(),
      JSON.stringify({hooks: {Stop: [{hooks: [{type: 'command', command: 'echo mine'}]}]}, other: 1}),
    )
    await installHooks({client: 'claude', home})
    const result = await uninstallHooks({client: 'claude', home})
    expect(result.removed).toBe(true)
    const settings = JSON.parse(await readFile(settingsPath(), 'utf8'))
    expect(settings).toEqual({hooks: {Stop: [{hooks: [{type: 'command', command: 'echo mine'}]}]}, other: 1})
  })

  it('uninstall drops an emptied hooks key', async () => {
    await installHooks({client: 'claude', home})
    await uninstallHooks({client: 'claude', home})
    expect(JSON.parse(await readFile(settingsPath(), 'utf8'))).toEqual({})
  })

  const projectSettings = () => join(cwd, '.claude', 'settings.local.json')

  it('with projectDir writes only that folder\'s settings.local.json', async () => {
    const result = await installHooks({client: 'claude', home, projectDir: cwd})
    expect(result).toMatchObject({installed: true, detail: expect.stringContaining(projectSettings())})
    const settings = JSON.parse(await readFile(projectSettings(), 'utf8'))
    expect(JSON.stringify(settings).match(/assethub hooks save/g)).toHaveLength(4)
    await expect(stat(settingsPath())).rejects.toThrow()
  })

  it('with projectDir uninstalls from that folder and leaves the global file alone', async () => {
    await installHooks({client: 'claude', home})
    await installHooks({client: 'claude', home, projectDir: cwd})
    const result = await uninstallHooks({client: 'claude', home, projectDir: cwd})
    expect(result.removed).toBe(true)
    expect(JSON.parse(await readFile(projectSettings(), 'utf8'))).toEqual({})
    expect(JSON.stringify(JSON.parse(await readFile(settingsPath(), 'utf8'))).match(/assethub hooks save/g)).toHaveLength(4)
  })

  it('refuses a projectDir that is the home folder, where it would apply everywhere', async () => {
    const result = await installHooks({client: 'claude', home, projectDir: home})
    expect(result).toMatchObject({installed: false, detail: expect.stringContaining('--global')})
    await expect(stat(join(home, '.claude'))).rejects.toThrow()
  })

  it('keeps settings.local.json backups separate from settings.json ones', async () => {
    await mkdir(join(cwd, '.claude'), {recursive: true})
    await writeFile(projectSettings(), '{}')
    for (const stamp of [1, 2, 3, 4, 5]) {
      await writeFile(join(cwd, '.claude', `settings.local.json.bak-${stamp}`), '{}')
    }
    await installHooks({client: 'claude', home, projectDir: cwd})
    const ours = (await readdir(join(cwd, '.claude'))).filter(n => /^settings\.local\.json\.bak-\d+$/.test(n))
    expect(ours).toHaveLength(MAX_SETTINGS_BACKUPS)
  })
})

describe('sessionSaveDisclosure', () => {
  it('names the folder for a project install and says it applies nowhere else', () => {
    const text = sessionSaveDisclosure({projectDir: '/work/hero'})
    expect(text).toContain('/work/hero/.claude/settings.local.json')
    expect(text).toContain('opened in /work/hero')
    expect(text).not.toContain('in any project')
  })

  it('says every project for a global install', () => {
    const text = sessionSaveDisclosure({})
    expect(text).toContain('~/.claude/settings.json')
    expect(text).toContain('in any project')
    expect(text).toContain('--global')
  })
})

describe('saveSession', () => {
  it('copies a redacted transcript, meta and images', async () => {
    const transcript = await writeTranscript()
    await writeFile(join(cwd, '.assethub-canvas-ignored'), '')
    await mkdir(join(cwd, '.assethub'), {recursive: true})
    await writeFile(join(cwd, '.assethub', 'canvas'), 'canvas_42\n')
    const result = await saveSession({stdin: hook(transcript, 'SessionEnd'), home, now, env: UPLOAD_OFF})

    expect(result.sessionDir).toBe(join(home, '.assethub', 'sessions', '2026-09-29_sess-1'))
    const saved = await readFile(join(result.sessionDir, 'transcript.jsonl'), 'utf8')
    expect(saved).not.toContain(SECRET)
    expect(saved).toContain('[REDACTED]')
    saved.trim().split('\n').forEach(line => expect(() => JSON.parse(line)).not.toThrow())

    const meta = JSON.parse(await readFile(join(result.sessionDir, 'meta.json'), 'utf8'))
    expect(meta).toMatchObject({sessionId: 'sess-1', cwd, client: 'claude', lastEvent: 'SessionEnd', canvasId: 'canvas_42', status: 'pending-upload', dirty: false})
    expect(meta.images).toHaveLength(1)
    expect(await readFile(join(result.sessionDir, 'images', meta.images[0].file))).toEqual(PNG)
  })

  it('keeps session files private to the user', async () => {
    const transcript = await writeTranscript()
    const {sessionDir} = await saveSession({stdin: hook(transcript, 'SessionEnd'), home, now, env: UPLOAD_OFF})
    const mode = async (path: string) => (await stat(path)).mode & 0o777
    expect(await mode(join(home, '.assethub', 'sessions'))).toBe(0o700)
    expect(await mode(sessionDir)).toBe(0o700)
    expect(await mode(join(sessionDir, 'transcript.jsonl'))).toBe(0o600)
    expect(await mode(join(sessionDir, 'meta.json'))).toBe(0o600)
    const meta = JSON.parse(await readFile(join(sessionDir, 'meta.json'), 'utf8'))
    expect(await mode(join(sessionDir, 'images'))).toBe(0o700)
    expect(await mode(join(sessionDir, 'images', meta.images[0].file))).toBe(0o600)
  })

  it('does not reuse a directory whose name only ends with the session id', async () => {
    const other = join(home, '.assethub', 'sessions', '2026-09-28_other_sess-1')
    await mkdir(other, {recursive: true})
    const transcript = await writeTranscript()
    const {sessionDir} = await saveSession({stdin: hook(transcript, 'Stop'), home, now, env: {}})
    expect(sessionDir).toBe(join(home, '.assethub', 'sessions', '2026-09-29_sess-1'))
  })

  it('a late Stop never shrinks the saved transcript or undoes SessionEnd', async () => {
    const full = await writeTranscript()
    const startUpload = vi.fn()
    const {sessionDir} = await saveSession({stdin: hook(full, 'SessionEnd'), home, now, env: {}, startUpload})
    const saved = await readFile(join(sessionDir, 'transcript.jsonl'), 'utf8')

    // The previous turn's async Stop finishes last, holding an older, shorter read.
    const older = join(root, 'older.jsonl')
    await writeFile(older, jsonl({type: 'user', message: {role: 'user', content: 'hi'}}))
    await saveSession({stdin: hook(older, 'Stop'), home, now, env: {}})

    expect(await readFile(join(sessionDir, 'transcript.jsonl'), 'utf8')).toBe(saved)
    expect(JSON.parse(await readFile(join(sessionDir, 'meta.json'), 'utf8')).status).toBe('pending-upload')
  })

  it('Stop only records the session; nothing is copied until it ends', async () => {
    const transcript = await writeTranscript()
    const {sessionDir} = await saveSession({stdin: hook(transcript, 'Stop'), home, now, env: {}})
    const meta = JSON.parse(await readFile(join(sessionDir, 'meta.json'), 'utf8'))
    expect(meta).toMatchObject({status: 'saved', dirty: true, transcriptPath: transcript, lastEvent: 'Stop'})
    await expect(stat(join(sessionDir, 'transcript.jsonl'))).rejects.toThrow()
  })

  it('SessionStart queues abandoned sessions and starts the retry sweep', async () => {
    const sessions = join(home, '.assethub', 'sessions')
    const write = async (name: string, meta: Record<string, unknown>) => {
      await mkdir(join(sessions, name), {recursive: true})
      await writeFile(join(sessions, name, 'meta.json'), JSON.stringify(meta))
    }
    await write('2026-09-28_crashed', {sessionId: 'crashed', status: 'saved', savedAt: '2026-09-28T20:00:00.000Z'})
    await write('2026-09-29_open', {sessionId: 'open', status: 'saved', savedAt: '2026-09-29T01:30:00.000Z'})
    await write('2026-09-28_current', {sessionId: 'current', status: 'saved', savedAt: '2026-09-28T20:00:00.000Z'})
    const startSweep = vi.fn()
    const result = await saveSession({
      stdin: JSON.stringify({session_id: 'current', cwd, hook_event_name: 'SessionStart', source: 'resume'}),
      home, now, env: {}, startSweep, upload: {profile: 'work'},
    })
    expect(result).toMatchObject({event: 'SessionStart', abandoned: 1, uploadStarted: true})
    expect(startSweep).toHaveBeenCalledWith('work')
    const statusOf = async (name: string) => JSON.parse(await readFile(join(sessions, name, 'meta.json'), 'utf8'))
    expect(await statusOf('2026-09-28_crashed')).toMatchObject({status: 'pending-upload', abandoned: true})
    // Quiet for only 30 minutes: may still be open in another terminal.
    expect((await statusOf('2026-09-29_open')).status).toBe('saved')
    // The session that is starting now is not abandoned.
    expect((await statusOf('2026-09-28_current')).status).toBe('saved')
  })

  it('SessionStart starts no sweep with uploads off or nothing saved', async () => {
    const startSweep = vi.fn()
    const stdin = JSON.stringify({session_id: 's', cwd, hook_event_name: 'SessionStart'})
    await saveSession({stdin, home, now, env: {}, startSweep})
    expect(startSweep).not.toHaveBeenCalled()
    await mkdir(join(home, '.assethub', 'sessions', '2026-09-29_x'), {recursive: true})
    await saveSession({stdin, home, now, env: UPLOAD_OFF, startSweep})
    expect(startSweep).not.toHaveBeenCalled()
  })

  it('reuses the session directory on later events', async () => {
    const transcript = await writeTranscript()
    await saveSession({stdin: hook(transcript, 'Stop'), home, now, env: {}})
    const later = await saveSession({
      stdin: hook(transcript, 'Stop'), home, env: {}, now: () => new Date('2026-09-30T00:00:00Z'),
    })
    expect(later.sessionDir).toContain('2026-09-29_sess-1')
    expect(await readdir(join(home, '.assethub', 'sessions'))).toHaveLength(1)
  })

  it('honours ASSETHUB_SESSION_SAVE=off and .assethub/no-session-save in a parent', async () => {
    const transcript = await writeTranscript()
    expect((await saveSession({stdin: hook(transcript, 'Stop'), home, env: {ASSETHUB_SESSION_SAVE: 'off'}})).skipped).toBe('opt-out')
    await mkdir(join(root, '.assethub'), {recursive: true})
    await writeFile(join(root, '.assethub', 'no-session-save'), '')
    expect((await saveSession({stdin: hook(transcript, 'Stop'), home, env: {}})).skipped).toBe('opt-out')
    await expect(stat(join(home, '.assethub', 'sessions'))).rejects.toThrow()
  })

  it('only collects images inside cwd, and caps the count', async () => {
    const outside = join(root, 'outside.png')
    await writeFile(outside, PNG)
    const lines: unknown[] = [{type: 'user', message: {role: 'user', content: `see ${outside}`}}]
    for (let i = 0; i < 55; i += 1) {
      await writeFile(join(cwd, `img${i}.png`), PNG)
      lines.push({type: 'user', message: {role: 'user', content: `look ${join(cwd, `img${i}.png`)}`}})
    }
    lines.push({type: 'user', message: {role: 'user', content: `missing ${join(cwd, 'nope.png')}`}})
    const transcript = join(root, 't.jsonl')
    await writeFile(transcript, jsonl(...lines))
    const result = await saveSession({stdin: hook(transcript, 'SessionEnd'), home, now, env: UPLOAD_OFF})
    const meta = JSON.parse(await readFile(join(result.sessionDir, 'meta.json'), 'utf8'))
    expect(meta.images).toHaveLength(50)
    expect(meta.images.map((i: {original: string}) => i.original)).not.toContain(outside)
  })

  it('skips images over 20 MB', async () => {
    await writeFile(join(cwd, 'big.png'), Buffer.alloc(20 * 1024 * 1024 + 1))
    const transcript = join(root, 't.jsonl')
    await writeFile(transcript, jsonl({type: 'user', message: {role: 'user', content: `big ${join(cwd, 'big.png')}`}}))
    const result = await saveSession({stdin: hook(transcript, 'SessionEnd'), home, now, env: UPLOAD_OFF})
    expect(JSON.parse(await readFile(join(result.sessionDir, 'meta.json'), 'utf8')).images).toEqual([])
  })

  it('never throws and logs to errors.log', async () => {
    // The session directory's name is taken by a file, so nothing can be saved.
    const sessions = join(home, '.assethub', 'sessions')
    await mkdir(sessions, {recursive: true})
    await writeFile(join(sessions, '2026-09-29_sess-1'), 'not a directory')
    const result = await saveSession({stdin: hook(join(root, 'missing.jsonl'), 'Stop'), home, now, env: {}})
    expect(result.sessionDir).toBe('')
    expect(await readFile(join(home, '.assethub', 'sessions', 'errors.log'), 'utf8')).toMatch(/EEXIST|ENOTDIR/)
    await expect(saveSession({stdin: '{{{', home, env: {}})).resolves.toBeDefined()
    await expect(saveSession({home, env: {}})).resolves.toMatchObject({skipped: 'no-input'})
  })

  it('SessionEnd marks pending-upload and starts the upload outside the hook', async () => {
    const transcript = await writeTranscript()
    const startUpload = vi.fn()
    const result = await saveSession({
      stdin: hook(transcript, 'SessionEnd'), home, now, env: {},
      upload: {profile: 'work'}, startUpload,
    })
    expect(result.uploadStarted).toBe(true)
    expect(startUpload).toHaveBeenCalledWith(result.sessionDir, 'work')
    const meta = JSON.parse(await readFile(join(result.sessionDir, 'meta.json'), 'utf8'))
    expect(meta.status).toBe('pending-upload')
  })

  it('Stop never starts an upload', async () => {
    const transcript = await writeTranscript()
    const startUpload = vi.fn()
    await saveSession({stdin: hook(transcript, 'Stop'), home, now, env: {}, startUpload})
    expect(startUpload).not.toHaveBeenCalled()
  })

  it('SessionEnd with ASSETHUB_SESSION_UPLOAD=off stays pending', async () => {
    const transcript = await writeTranscript()
    const startUpload = vi.fn()
    const result = await saveSession({
      stdin: hook(transcript, 'SessionEnd'), home, now, env: {ASSETHUB_SESSION_UPLOAD: 'off'}, startUpload,
    })
    expect(result.uploadStarted).toBeUndefined()
    expect(startUpload).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(join(result.sessionDir, 'meta.json'), 'utf8')).status).toBe('pending-upload')
  })

  it('deletes saved sessions older than the retention period', async () => {
    const transcript = await writeTranscript()
    const sessions = join(home, '.assethub', 'sessions')
    const old = join(sessions, '2026-08-01_old')
    const recent = join(sessions, '2026-09-20_recent')
    const noMeta = join(sessions, '2026-07-01_nometa')
    for (const dir of [old, recent, noMeta]) await mkdir(dir, {recursive: true})
    await writeFile(join(old, 'meta.json'), JSON.stringify({savedAt: '2026-08-01T00:00:00.000Z', status: 'pending-upload'}))
    await writeFile(join(recent, 'meta.json'), JSON.stringify({savedAt: '2026-09-20T00:00:00.000Z', status: 'saved'}))
    await utimes(noMeta, new Date('2026-07-01'), new Date('2026-07-01'))

    const result = await saveSession({stdin: hook(transcript, 'SessionEnd'), home, now, env: UPLOAD_OFF})
    expect(result.pruned).toBe(2)
    const left = await readdir(sessions)
    expect(left).toContain('2026-09-20_recent')
    expect(left).not.toContain('2026-08-01_old')
    expect(left).not.toContain('2026-07-01_nometa')
    expect(left.some(name => name.endsWith('_sess-1'))).toBe(true)

    await mkdir(old, {recursive: true})
    await writeFile(join(old, 'meta.json'), JSON.stringify({savedAt: '2026-08-01T00:00:00.000Z'}))
    const kept = await saveSession({stdin: hook(transcript, 'SessionEnd'), home, now, env: {...UPLOAD_OFF, ASSETHUB_SESSION_RETENTION_DAYS: 'off'}})
    expect(kept.pruned).toBeUndefined()
    expect(await readdir(sessions)).toContain('2026-08-01_old')
  })
})

type Call = {url: string; method: string; headers: Record<string, string>; body?: unknown}
const fakeServer = (respond?: (c: Call) => Response) => {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = {url: String(input), method: String(init?.method ?? 'GET'), headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body}
    calls.push(call)
    if (respond) return respond(call)
    if (call.method === 'HEAD') return new Response(null, {status: 404})
    return new Response(JSON.stringify({success: true, data: {status: 'published'}}), {status: 200, headers: {'content-type': 'application/json'}})
  }) as unknown as typeof fetch
  return {calls, fetchImpl}
}

describe('buildSessionGraphFolder', () => {
  it('round-trips through readGraphFolder + buildRunUploadPlan', async () => {
    const transcript = await writeTranscript()
    const {sessionDir} = await saveSession({stdin: hook(transcript, 'SessionEnd'), home, now, env: UPLOAD_OFF})
    const folderPath = await buildSessionGraphFolder(sessionDir)
    const folder = await readGraphFolder(folderPath)
    const plan = await buildRunUploadPlan({folder, graphId: 'import_session_test'})

    const kinds = folder.graph.nodes.map(n => n.artifactKind).sort()
    expect(kinds).toEqual(['console', 'file', 'image', 'json', 'run', 'text', 'text'])
    const session = folder.graph.nodes.find(n => n.artifactKind === 'console')!
    expect(session.tags).toEqual(['agent:claude', 'session'])
    const prompt = folder.graph.nodes.find(n => n.artifactKind === 'json')!
    expect(prompt.semanticType).toBe('prompt')
    expect((prompt.payload as {text: string}).text).not.toContain(SECRET)
    const run = folder.graph.nodes.find(n => n.artifactKind === 'run')!
    expect(JSON.stringify(run.payload)).not.toContain(SECRET)
    expect((run.payload as {toolName: string}).toolName).toBe('Bash')

    expect(folder.graph.edges.filter(e => e.kind === 'continues')).toHaveLength(4)
    const uses = folder.graph.edges.filter(e => e.kind === 'uses')
    expect(uses).toHaveLength(1)
    expect(uses[0].from).toBe(run.id)
    // The image and the one transcript chunk.
    expect(plan.blobs).toHaveLength(2)
    expect(plan.counts.nodes).toBe(7)
    const part = folder.graph.nodes.find(n => n.artifactKind === 'file')!
    expect(part.semanticType).toBe('transcript')
    expect(folder.graph.edges.filter(e => e.kind === 'contains').map(e => [e.from, e.to])).toEqual([['session', part.id]])
  })

  it('keeps a long session under the push limit, newest messages first', async () => {
    const transcript = join(root, 'long.jsonl')
    const entries = Array.from({length: 600}, (_, i) => ({
      type: 'assistant',
      message: {role: 'assistant', content: [{type: 'text', text: `reply ${i} ${'y'.repeat(12_000)}`}]},
    }))
    await writeFile(transcript, jsonl(...entries))
    const {sessionDir} = await saveSession({stdin: hook(transcript, 'SessionEnd'), home, now, env: UPLOAD_OFF})
    const folder = await readGraphFolder(await buildSessionGraphFolder(sessionDir))
    await expect(buildRunUploadPlan({folder, graphId: 'import_session_test'})).resolves.toBeDefined()

    const texts = folder.graph.nodes
      .filter(n => n.artifactKind === 'text')
      .map(n => (n.payload as {text: string}).text)
    expect(texts.some(text => text.startsWith('reply 599 '))).toBe(true)
    expect(texts.some(text => text.startsWith('reply 0 '))).toBe(false)
    const session = folder.graph.nodes.find(n => n.artifactKind === 'console')!
    expect(session.metadata).toMatchObject({messageCount: 600, droppedMessages: expect.any(Number)})
    expect((session.metadata as {droppedMessages: number}).droppedMessages).toBeGreaterThan(0)
  })

  it('chunks the transcript on line boundaries, and a grown transcript keeps its earlier chunks', () => {
    const lines = Array.from({length: 40}, (_, i) => `{"n":${i},"t":"${'z'.repeat(20)}"}\n`).join('')
    const bytes = Buffer.from(lines)
    const chunks = chunkTranscript(bytes, 100)
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true)
    expect(chunks.every(c => c.length <= 100 && c.toString().endsWith('\n'))).toBe(true)
    const grown = chunkTranscript(Buffer.concat([bytes, Buffer.from('{"n":40}\n')]), 100)
    expect(grown.slice(0, chunks.length - 1).map(String)).toEqual(chunks.slice(0, -1).map(String))
    // A single line longer than a chunk is cut mid-line and still reassembles.
    const long = Buffer.from(`${'q'.repeat(250)}\n`)
    expect(Buffer.concat(chunkTranscript(long, 100)).equals(long)).toBe(true)
  })

  it('compacts the index and leaves images out from level 2', async () => {
    expect(compactLimits(1).indexBytes).toBe(compactLimits(0).indexBytes / 2)
    const transcript = await writeTranscript()
    const {sessionDir} = await saveSession({stdin: hook(transcript, 'SessionEnd'), home, now, env: UPLOAD_OFF})
    const folder = await readGraphFolder(await buildSessionGraphFolder(sessionDir, {compactLevel: 2}))
    expect(folder.graph.nodes.some(n => n.artifactKind === 'image')).toBe(false)
    expect(folder.graph.nodes.some(n => n.semanticType === 'transcript')).toBe(true)
    expect(folder.graph.nodes.find(n => n.artifactKind === 'console')!.metadata).toMatchObject({compactLevel: 2, skippedImages: 1})
  })

  it('truncates large tool input to 8KB', async () => {
    const transcript = join(root, 't.jsonl')
    await writeFile(transcript, jsonl(
      {type: 'assistant', message: {role: 'assistant', content: [{type: 'tool_use', id: 't', name: 'Write', input: {content: 'x'.repeat(50_000)}}]}},
    ))
    const {sessionDir} = await saveSession({stdin: hook(transcript, 'SessionEnd'), home, now, env: UPLOAD_OFF})
    const folder = await readGraphFolder(await buildSessionGraphFolder(sessionDir))
    const run = folder.graph.nodes.find(n => n.artifactKind === 'run')!
    expect(JSON.stringify(run.payload).length).toBeLessThan(9 * 1024)
    await buildRunUploadPlan({folder, graphId: 'import_session_test'})
  })
})

describe('uploadSession', () => {
  const setup = async (event = 'Stop') => {
    const transcript = await writeTranscript()
    return (await saveSession({stdin: hook(transcript, event), home, now, env: {ASSETHUB_SESSION_UPLOAD: 'off'}})).sessionDir
  }
  const auth = {apiKey: 'ah_live_secretsecret', baseUrl: 'https://x.test'}
  const metaOf = async (dir: string) => JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'))

  it('uploads register, blob and snapshot with the bearer key', async () => {
    const dir = await setup()
    const {fetchImpl, calls} = fakeServer()
    const result = await uploadSession(dir, {fetchImpl, auth})
    expect(result.ok).toBe(true)
    expect(result.graphId).toMatch(/^import_session_2026-09-29_sess-1$/)
    // Register, then HEAD + PUT for the image and the transcript chunk, then the snapshot.
    expect(calls.map(c => c.method)).toEqual(['POST', 'HEAD', 'PUT', 'HEAD', 'PUT', 'PUT'])
    expect(calls.every(c => c.headers.authorization === `Bearer ${auth.apiKey}`)).toBe(true)
    // The coding-agent session store, never Production Control's run uploads.
    expect(calls.every(c => c.url.startsWith('https://x.test/api/v2/coding-agent-sessions/'))).toBe(true)
    expect(calls[0].url).toBe('https://x.test/api/v2/coding-agent-sessions/graphs')
    expect(JSON.parse(String(calls[0].body)).session).toEqual({client: 'claude', sessionId: 'sess-1', canvasId: null})
    expect(await metaOf(dir)).toMatchObject({status: 'uploaded', uploadedRev: 0})
  })

  it('sends the project canvas id when .assethub/canvas names one', async () => {
    await mkdir(join(cwd, '.assethub'), {recursive: true})
    await writeFile(join(cwd, '.assethub', 'canvas'), '57215\n')
    const dir = await setup()
    const {fetchImpl, calls} = fakeServer()
    await uploadSession(dir, {fetchImpl, auth})
    expect(JSON.parse(String(calls[0].body)).session.canvasId).toBe(57215)

    await writeFile(join(cwd, '.assethub', 'canvas'), 'not-a-canvas\n')
    const other = await setup()
    const second = fakeServer()
    await uploadSession(other, {fetchImpl: second.fetchImpl, auth})
    expect(JSON.parse(String(second.calls[0].body)).session.canvasId).toBeNull()
  })

  it('a re-upload after growth uses the next rev', async () => {
    const dir = await setup()
    await uploadSession(dir, {fetchImpl: fakeServer().fetchImpl, auth})
    const {fetchImpl, calls} = fakeServer()
    await uploadSession(dir, {fetchImpl, auth})
    const snapshot = calls.find(c => c.url.includes('/snapshot'))!
    expect(snapshot).toBeDefined()
    expect(await metaOf(dir)).toMatchObject({uploadedRev: 1})
  })

  it('never re-sends a revision whose snapshot may have landed', async () => {
    const dir = await setup()
    // The snapshot PUT reaches the server, then the response is lost.
    const lost = fakeServer(call => {
      if (call.url.includes('/snapshot')) throw new TypeError('fetch failed')
      if (call.method === 'HEAD') return new Response(null, {status: 404})
      return new Response(JSON.stringify({success: true, data: {}}), {status: 200, headers: {'content-type': 'application/json'}})
    })
    expect((await uploadSession(dir, {fetchImpl: lost.fetchImpl, auth})).ok).toBe(false)
    expect(JSON.parse(String(lost.calls.find(c => c.url.includes('/snapshot'))!.body)).rev).toBe(0)

    const {fetchImpl, calls} = fakeServer()
    expect((await uploadSession(dir, {fetchImpl, auth, force: true})).ok).toBe(true)
    expect(JSON.parse(String(calls.find(c => c.url.includes('/snapshot'))!.body)).rev).toBe(1)
    expect(await metaOf(dir)).toMatchObject({status: 'uploaded', uploadedRev: 1})
  })

  it('a timeout compacts the next attempt, which waits before retrying on its own', async () => {
    const dir = await setup()
    const at = (minutes: number) => () => new Date(now().getTime() + minutes * 60_000)
    const slow = fakeServer(call => {
      if (call.method === 'PUT' && call.url.includes('/blobs/')) throw new DOMException('timed out', 'TimeoutError')
      if (call.method === 'HEAD') return new Response(null, {status: 404})
      return new Response(JSON.stringify({success: true, data: {}}), {status: 200, headers: {'content-type': 'application/json'}})
    })
    expect((await uploadSession(dir, {fetchImpl: slow.fetchImpl, auth, now: at(0)})).ok).toBe(false)
    expect(await metaOf(dir)).toMatchObject({status: 'pending-upload', compactLevel: 1, failedAttempts: 1})

    const early = fakeServer()
    expect(await uploadSession(dir, {fetchImpl: early.fetchImpl, auth, now: at(30)})).toMatchObject({reason: 'retry-later', throttled: true})
    expect(early.calls).toHaveLength(0)

    const later = fakeServer()
    expect((await uploadSession(dir, {fetchImpl: later.fetchImpl, auth, now: at(61)})).ok).toBe(true)
    const push = JSON.parse(String(later.calls.find(c => c.url.includes('/snapshot'))!.body))
    const session = push.snapshot.nodes.find((n: {id: string}) => n.id === 'session')
    expect(session.metadata.compactLevel).toBe(1)
    expect(await metaOf(dir)).toMatchObject({status: 'uploaded', failedAttempts: 0})
  })

  it('uploads a session that only ever saw Stop, copying it first', async () => {
    const transcript = await writeTranscript()
    const {sessionDir} = await saveSession({stdin: hook(transcript, 'Stop'), home, now, env: {}})
    const {fetchImpl, calls} = fakeServer()
    expect((await uploadSession(sessionDir, {fetchImpl, auth, force: true})).ok).toBe(true)
    expect(await readFile(join(sessionDir, 'transcript.jsonl'), 'utf8')).not.toContain(SECRET)
    expect(await metaOf(sessionDir)).toMatchObject({dirty: false, status: 'uploaded'})
    expect(calls.some(c => c.url.includes('/snapshot'))).toBe(true)
  })

  it('uploadPending tries the newest first, up to a limit, skipping throttled ones', async () => {
    const sessions = join(home, '.assethub', 'sessions')
    const make = async (name: string, savedAt: string, extra: Record<string, unknown> = {}) => {
      const transcript = join(root, `${name}.jsonl`)
      await writeFile(transcript, jsonl({type: 'user', message: {role: 'user', content: name}}))
      const {sessionDir} = await saveSession({
        stdin: JSON.stringify({session_id: name, transcript_path: transcript, cwd, hook_event_name: 'SessionEnd'}),
        home, now: () => new Date(savedAt), env: UPLOAD_OFF,
      })
      if (Object.keys(extra).length) {
        const meta = JSON.parse(await readFile(join(sessionDir, 'meta.json'), 'utf8'))
        await writeFile(join(sessionDir, 'meta.json'), JSON.stringify({...meta, ...extra}))
      }
      return sessionDir
    }
    const oldest = await make('a', '2026-09-20T00:00:00.000Z')
    const middle = await make('b', '2026-09-25T00:00:00.000Z')
    const waiting = await make('c', '2026-09-28T00:00:00.000Z', {failedAttempts: 1, lastUploadAttemptAt: '2026-09-29T01:50:00.000Z'})
    const newest = await make('d', '2026-09-29T00:00:00.000Z')
    const {fetchImpl} = fakeServer()
    const results = await uploadPending({home, fetchImpl, auth, now, limit: 2, exclude: newest})
    expect(results.map(r => r.session)).toEqual([waiting, middle, oldest])
    expect(results.map(r => r.outcome.ok)).toEqual([false, true, true])
    expect(await readdir(sessions)).toHaveLength(4)
  })

  it('keeps fields a concurrent save wrote while the upload ran', async () => {
    const dir = await setup()
    const {fetchImpl} = fakeServer(call => {
      if (call.method === 'POST') {
        const current = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
        writeFileSync(join(dir, 'meta.json'), JSON.stringify({...current, savedAt: '2026-09-29T03:00:00.000Z', lastEvent: 'Stop'}))
      }
      if (call.method === 'HEAD') return new Response(null, {status: 404})
      return new Response(JSON.stringify({success: true, data: {}}), {status: 200, headers: {'content-type': 'application/json'}})
    })
    await uploadSession(dir, {fetchImpl, auth})
    expect(await metaOf(dir)).toMatchObject({status: 'uploaded', savedAt: '2026-09-29T03:00:00.000Z'})
  })

  it('404 keeps the session pending with no-upload-access and throttles for a day', async () => {
    const dir = await setup('SessionEnd')
    const notFound = (_c: Call) => new Response(JSON.stringify({success: false, error: {code: 'NOT_FOUND', message: 'nf'}}), {status: 404})
    const first = fakeServer(notFound)
    const t0 = new Date('2026-09-29T02:00:00Z')
    expect(await uploadSession(dir, {fetchImpl: first.fetchImpl, auth, now: () => t0})).toEqual({ok: false, reason: 'no-upload-access'})
    expect(await metaOf(dir)).toMatchObject({status: 'pending-upload', reason: 'no-upload-access'})
    expect(first.calls).toHaveLength(1)

    const second = fakeServer(notFound)
    await uploadSession(dir, {fetchImpl: second.fetchImpl, auth, now: () => new Date(t0.getTime() + 3600_000)})
    expect(second.calls).toHaveLength(0)

    const third = fakeServer(notFound)
    await uploadSession(dir, {fetchImpl: third.fetchImpl, auth, now: () => new Date(t0.getTime() + 25 * 3600_000)})
    expect(third.calls).toHaveLength(1)
  })

  it('reports a server failure as pending without leaking the key', async () => {
    const dir = await setup()
    const {fetchImpl} = fakeServer(() => new Response(JSON.stringify({success: false, error: {code: 'X', message: `boom ${auth.apiKey}`}}), {status: 500}))
    const result = await uploadSession(dir, {fetchImpl, auth})
    expect(result.ok).toBe(false)
    expect(result.reason).not.toContain(auth.apiKey)
    expect((await metaOf(dir)).status).toBe('pending-upload')
  })

  it('reports missing credentials', async () => {
    const dir = await setup()
    const result = await uploadSession(dir, {home, env: {}, fetchImpl: fakeServer().fetchImpl})
    expect(result).toEqual({ok: false, reason: 'no-credentials'})
  })

  it('reads the profile key from config.json', async () => {
    const dir = await setup()
    await writeFile(join(home, '.assethub', 'config.json'), JSON.stringify({defaultProfile: 'default', profiles: {default: {apiKey: 'ah_live_fromconfig1', baseUrl: 'https://cfg.test', updatedAt: ''}}}))
    const {fetchImpl, calls} = fakeServer()
    expect((await uploadSession(dir, {home, env: {}, fetchImpl})).ok).toBe(true)
    expect(calls[0].url.startsWith('https://cfg.test/')).toBe(true)
    expect(calls[0].headers.authorization).toBe('Bearer ah_live_fromconfig1')
    expect(calls[0].headers['x-assethub-workspace']).toBeUndefined()
  })

  // Personal keys are refused without it, so a saved session would stay pending forever.
  it("sends the profile's selected workspace with every upload request", async () => {
    const dir = await setup()
    await writeFile(join(home, '.assethub', 'config.json'), JSON.stringify({defaultProfile: 'personal', profiles: {personal: {
      apiKey: 'ah_live_fromconfig1', authentication: 'personal', workspaceId: 'ws-personal', baseUrl: 'https://cfg.test', updatedAt: '',
    }}}))
    const {fetchImpl, calls} = fakeServer()
    expect((await uploadSession(dir, {home, env: {}, fetchImpl})).ok).toBe(true)
    expect(calls.length).toBeGreaterThan(1)
    expect(calls.every(c => c.headers['x-assethub-workspace'] === 'ws-personal')).toBe(true)
  })

  it('sends no workspace for an environment key without a saved profile', async () => {
    const dir = await setup()
    const {fetchImpl, calls} = fakeServer()
    expect((await uploadSession(dir, {home, env: {ASSETHUB_API_KEY: 'test-env-key-not-secret'}, fetchImpl})).ok).toBe(true)
    expect(calls.every(c => c.headers['x-assethub-workspace'] === undefined)).toBe(true)
  })

  it('uploadPending uploads only pending sessions', async () => {
    await setup('SessionEnd')
    const results = await uploadPending({home, env: {}, fetchImpl: fakeServer().fetchImpl, auth})
    expect(results).toHaveLength(1)
    expect(results[0].outcome.ok).toBe(true)
    expect(await uploadPending({home, env: {}, fetchImpl: fakeServer().fetchImpl, auth})).toEqual([])
  })
})

describe('runHooksCommand', () => {
  const run = async (argv: string[], deps = {}) => {
    let out = ''
    const code = await runHooksCommand(argv, {home, env: {}, write: t => { out += t }, ...deps})
    return {code, out}
  }

  it('stays silent on SessionStart, whose output would reach the model', async () => {
    const readStdin = async () => JSON.stringify({session_id: 's', cwd, hook_event_name: 'SessionStart'})
    const {code, out} = await run(['save'], {readStdin, startSweep: vi.fn(), now})
    expect(code).toBe(0)
    expect(out).toBe('')
  })

  it('upload --session --sweep also retries older pending sessions', async () => {
    const make = async (name: string) => {
      const transcript = join(root, `${name}.jsonl`)
      await writeFile(transcript, jsonl({type: 'user', message: {role: 'user', content: name}}))
      return (await saveSession({
        stdin: JSON.stringify({session_id: name, transcript_path: transcript, cwd, hook_event_name: 'SessionEnd'}),
        home, now, env: UPLOAD_OFF,
      })).sessionDir
    }
    const current = await make('cur')
    const older = await make('old')
    const {fetchImpl, calls} = fakeServer()
    const env = {ASSETHUB_API_KEY: 'ah_live_secretsecret', ASSETHUB_API_BASE_URL: 'https://x.test'}
    const {code} = await run(['upload', '--session', current, '--auto', '--sweep', '3'], {fetchImpl, env, now})
    expect(code).toBe(0)
    expect(calls.filter(c => c.url.endsWith('/graphs'))).toHaveLength(2)
    expect(JSON.parse(await readFile(join(older, 'meta.json'), 'utf8')).status).toBe('uploaded')
  })

  const probeServer = (status: number) =>
    fakeServer(call => new Response(JSON.stringify({success: false, error: {code: 'X', message: 'x'}}), {status, headers: {'content-type': 'application/json'}}))
  const withKey = {ASSETHUB_API_KEY: 'test-env-key-not-secret', ASSETHUB_API_BASE_URL: 'https://x.test'}

  it('refuses to install for an account that may not upload sessions, and changes nothing', async () => {
    const {fetchImpl, calls} = probeServer(404)
    const result = await run(['install', '--client', 'claude'], {env: withKey, fetchImpl})
    expect(result.code).toBe(1)
    expect(result.out).toBe('Session saving is not available for this account.\n')
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual(['POST https://x.test/api/v2/coding-agent-sessions/graphs'])
    await expect(stat(join(home, '.claude', 'settings.json'))).rejects.toThrow()
    expect((await run(['install', '--client', 'claude'])).code).toBe(1)
  })

  it('installs into the current folder by default, and uninstalls from it', async () => {
    const installed = await run(['install', '--client', 'claude'], {cwd, env: withKey, fetchImpl: probeServer(400).fetchImpl})
    expect(installed.code).toBe(0)
    expect(installed.out).toContain(sessionSaveDisclosure({projectDir: cwd}))
    expect(await readFile(join(cwd, '.claude', 'settings.local.json'), 'utf8')).toContain('assethub hooks save')
    await expect(stat(join(home, '.claude', 'settings.json'))).rejects.toThrow()
    expect((await run(['install', '--client', 'codex'], {cwd})).out).toContain('Codex')
    const removed = await run(['uninstall', '--client', 'claude'], {cwd})
    expect(removed).toMatchObject({code: 0, out: expect.stringContaining('settings.local.json')})
    expect((await run(['install'])).code).toBe(2)
  })

  it('--global installs into ~/.claude/settings.json for every project', async () => {
    const installed = await run(['install', '--client', 'claude', '--global'], {cwd, env: withKey, fetchImpl: probeServer(400).fetchImpl})
    expect(installed.code).toBe(0)
    expect(installed.out).toContain(sessionSaveDisclosure({}))
    expect(await readFile(join(home, '.claude', 'settings.json'), 'utf8')).toContain('assethub hooks save')
    await expect(stat(join(cwd, '.claude'))).rejects.toThrow()
    expect((await run(['uninstall', '--client', 'claude', '--global'], {cwd})).out).toContain('settings.json')
  })

  it('refuses a default install from the home folder and points at --global', async () => {
    const result = await run(['install', '--client', 'claude'], {cwd: home, env: withKey, fetchImpl: probeServer(400).fetchImpl})
    expect(result.code).toBe(1)
    expect(result.out).toContain('--global')
    await expect(stat(join(home, '.claude'))).rejects.toThrow()
  })

  it('saves from stdin JSON and from flags, then lists and reports status as JSON', async () => {
    const transcript = await writeTranscript()
    expect((await run(['save'], {readStdin: async () => hook(transcript, 'Stop'), now})).code).toBe(0)
    expect((await run(['save', '--transcript', transcript, '--session-id', 'manual-1'], {cwd, now})).code).toBe(0)
    const list = await run(['list', '--json'])
    expect(JSON.parse(list.out)).toHaveLength(2)
    const status = await run(['status', '--json'])
    expect(JSON.parse(status.out)).toMatchObject({total: 2})
  })

  it('save exits 0 even on garbage stdin', async () => {
    expect((await run(['save'], {readStdin: async () => 'garbage'})).code).toBe(0)
  })

  it('upload --session --auto keeps the daily limit; a manual upload retries now', async () => {
    const transcript = await writeTranscript()
    const {sessionDir} = await saveSession({stdin: hook(transcript, 'SessionEnd'), home, now, env: {}, startUpload: () => {}})
    const refused = fakeServer(() => new Response(JSON.stringify({success: false}), {status: 404}))
    const auth = {ASSETHUB_API_KEY: 'k', ASSETHUB_CLI_CONFIG: join(root, 'none.json')}
    await run(['upload', '--session', sessionDir, '--auto'], {env: auth, fetchImpl: refused.fetchImpl, now})
    const firstCalls = refused.calls.length
    expect(firstCalls).toBeGreaterThan(0)
    await run(['upload', '--session', sessionDir, '--auto'], {env: auth, fetchImpl: refused.fetchImpl, now})
    expect(refused.calls.length).toBe(firstCalls)
    await run(['upload', '--session', sessionDir], {env: auth, fetchImpl: refused.fetchImpl, now})
    expect(refused.calls.length).toBeGreaterThan(firstCalls)
  })

  it('upload --session prints the reason and exits 1 when refused', async () => {
    const transcript = await writeTranscript()
    const {sessionDir} = await saveSession({stdin: hook(transcript, 'Stop'), home, now, env: {}})
    const {code, out} = await run(['upload', '--session', sessionDir], {env: {}})
    expect(code).toBe(1)
    expect(out).toContain('no-credentials')
  })
})

describe('runs upload', () => {
  // Through the built CLI, so the command's own wiring is covered, not just uploadRun.
  it("sends the profile's selected workspace with every request", async () => {
    const transcript = await writeTranscript()
    const {sessionDir} = await saveSession({stdin: hook(transcript, 'SessionEnd'), home, now, env: UPLOAD_OFF})
    const folder = await buildSessionGraphFolder(sessionDir)
    const seen: {method: string; url: string; workspace: string | undefined}[] = []
    const server = createServer((req, res) => {
      seen.push({method: req.method!, url: req.url!, workspace: req.headers['x-assethub-workspace'] as string | undefined})
      req.resume()
      req.on('end', () => {
        if (req.method === 'HEAD') {
          res.writeHead(404)
          res.end()
          return
        }
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({success: true, data: {status: 'published'}}))
      })
    })
    await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
    try {
      const {port} = server.address() as {port: number}
      const config = join(root, 'config.json')
      await writeFile(config, JSON.stringify({defaultProfile: 'personal', profiles: {personal: {
        apiKey: 'ah_live_fromconfig1', workspaceId: 'ws-personal', baseUrl: `http://127.0.0.1:${port}`, updatedAt: '',
      }}}))
      const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url))
      await promisify(execFile)(process.execPath, [cli, 'runs', 'upload', folder, '--profile', 'personal', '--graph-id', 'import_session_test'], {
        env: {PATH: process.env.PATH, HOME: home, ASSETHUB_CLI_CONFIG: config},
      })
    } finally {
      await new Promise<void>(closed => server.close(() => closed()))
    }
    const uploads = seen.filter(call => call.url.includes('/runs/') || call.url.includes('/graphs'))
    expect(uploads.length).toBeGreaterThan(1)
    expect(uploads.every(call => call.workspace === 'ws-personal')).toBe(true)
  })
})

describe('session hooks review fixes', () => {
  it('recognises only a command that runs the CLI itself', () => {
    for (const ours of ['assethub hooks save', '/opt/assethub/bin/assethub hooks save', '"/Users/a b/assethub" hooks save', 'assethub.js hooks save --x'])
      expect(isOurCommand(ours), ours).toBe(true)
    for (const other of ['echo assethub hooks save', 'my-tool --then assethub hooks save', 'assethub-other hooks save', 'assethub hooks saved'])
      expect(isOurCommand(other), other).toBe(false)
  })

  it('keeps every concurrent metadata update', async () => {
    const transcript = await writeTranscript()
    const {sessionDir} = await saveSession({stdin: hook(transcript, 'Stop'), home, now, env: UPLOAD_OFF})
    const base = (await readMeta(sessionDir))!
    await Promise.all(
      Array.from({length: 20}, () =>
        updateMeta(sessionDir, base, latest => ({...latest, failedAttempts: (latest.failedAttempts ?? 0) + 1})),
      ),
    )
    expect((await readMeta(sessionDir))?.failedAttempts).toBe(20)
  })

  it('lets only one upload of a session run at a time', async () => {
    const transcript = await writeTranscript()
    const {sessionDir} = await saveSession({stdin: hook(transcript, 'SessionEnd'), home, now, env: UPLOAD_OFF})
    await mkdir(join(sessionDir, '.upload.lock'))
    const {fetchImpl, calls} = fakeServer()
    const result = await uploadSession(sessionDir, {fetchImpl, auth: {apiKey: 'ah_live_x', baseUrl: 'https://x.test'}})
    expect(result).toMatchObject({ok: false, reason: 'upload-in-progress'})
    expect(calls).toHaveLength(0)
  })

  it('builds the upload folder with private permissions', async () => {
    const transcript = await writeTranscript()
    const {sessionDir} = await saveSession({stdin: hook(transcript, 'SessionEnd'), home, now, env: UPLOAD_OFF})
    const folder = await buildSessionGraphFolder(sessionDir)
    expect((await stat(folder)).mode & 0o777).toBe(0o700)
    expect((await stat(join(folder, 'blobs'))).mode & 0o777).toBe(0o700)
    for (const name of await readdir(join(folder, 'blobs'))) expect((await stat(join(folder, 'blobs', name))).mode & 0o777).toBe(0o600)
    for (const name of ['manifest.json', 'nodes.jsonl', 'edges.jsonl']) expect((await stat(join(folder, name))).mode & 0o777).toBe(0o600)
  })

  it('replaces the saved copy when the live transcript grew, even if the masked copy is shorter', async () => {
    const transcript = await writeTranscript()
    const {sessionDir} = await saveSession({stdin: hook(transcript, 'SessionEnd'), home, now, env: UPLOAD_OFF})
    // A copy saved by an older CLI that masked less: longer than today's masking produces.
    await writeFile(join(sessionDir, 'transcript.jsonl'), `${'x'.repeat(50_000)}\n`)
    await writeFile(transcript, `${readFileSync(transcript, 'utf8')}${jsonl({type: 'user', message: {role: 'user', content: 'one more turn'}})}`)
    await materializeSession(sessionDir)
    const saved = await readFile(join(sessionDir, 'transcript.jsonl'), 'utf8')
    expect(saved).toContain('one more turn')
    expect(saved).not.toContain(SECRET)
  })

  it('uses a personal saved profile over ASSETHUB_API_KEY, like the rest of the CLI', async () => {
    const transcript = await writeTranscript()
    const {sessionDir} = await saveSession({stdin: hook(transcript, 'Stop'), home, now, env: UPLOAD_OFF})
    await writeFile(join(home, '.assethub', 'config.json'), JSON.stringify({defaultProfile: 'personal', profiles: {personal: {
      apiKey: 'ah_live_fromconfig1', authentication: 'personal', baseUrl: 'https://cfg.test', updatedAt: '',
    }}}))
    const {fetchImpl, calls} = fakeServer()
    expect((await uploadSession(sessionDir, {home, env: {ASSETHUB_API_KEY: 'test-env-key-not-secret'}, fetchImpl})).ok).toBe(true)
    expect(calls[0].headers.authorization).toBe('Bearer ah_live_fromconfig1')
  })
})

describe('transcript trimming', () => {
  const claudeTranscript = (): string =>
    jsonl(
      {type: 'queue-operation', operation: 'enqueue', content: 'hello'},
      {type: 'attachment', attachment: {type: 'skill_listing', content: '- private-skill: brief for the weekly sync'}},
      {type: 'attachment', attachment: {type: 'session_context', context: {userEmail: 'artist@example.test'}}},
      {type: 'attachment', attachment: {type: 'environment', snapshot: {workingDirectory: '/Users/artist/secret-project'}}},
      {type: 'attachment', attachment: {type: 'prompt_snapshot', systemPrompt: ['You are Claude Code…']}},
      {type: 'user', isMeta: true, message: {role: 'user', content: 'Caveat: local command output'}},
      {
        type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false, timestamp: '2026-09-30T10:00:00Z',
        cwd: '/Users/artist/secret-project', gitBranch: 'main', version: '2.1.272', sessionId: 's1', userType: 'external',
        message: {role: 'user', content: 'make a hero'},
      },
      {
        type: 'assistant', uuid: 'a1', parentUuid: 'u1', isSidechain: false, timestamp: '2026-09-30T10:00:01Z',
        cwd: '/Users/artist/secret-project', requestId: 'req_1',
        message: {
          id: 'msg_1', role: 'assistant', model: 'claude-opus-5', usage: {input_tokens: 10}, diagnostics: null,
          content: [
            {type: 'thinking', thinking: 'internal reasoning', signature: 'sig'},
            {type: 'text', text: 'Generating.'},
            {type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {command: 'ls'}, caller: {type: 'direct'}},
          ],
        },
      },
      {
        type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: '2026-09-30T10:00:02Z', cwd: '/Users/artist/secret-project',
        toolUseResult: {stdout: 'hero.png', stderr: ''},
        message: {role: 'user', content: [
          {type: 'tool_result', tool_use_id: 'toolu_1', content: 'hero.png\n<system-reminder>Contents of CLAUDE.md: private rules</system-reminder>'},
          {type: 'image', source: {type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAA'}},
        ]},
      },
      {type: 'summary', summary: 'Made a hero image.', leafUuid: 'u2'},
      {type: 'last-prompt', lastPrompt: 'make a hero'},
    )

  it('keeps only the conversation and drops what Claude Code adds around it', async () => {
    const path = join(root, 'transcript.jsonl')
    await writeFile(path, claudeTranscript())
    const {sessionDir} = await saveSession({stdin: hook(path, 'SessionEnd'), home, now, env: UPLOAD_OFF})
    const saved = await readFile(join(sessionDir, 'transcript.jsonl'), 'utf8')
    const lines = saved.trim().split('\n').map(line => JSON.parse(line))
    expect(lines.map(line => line.type)).toEqual(['user', 'assistant', 'user', 'summary'])
    for (const dropped of ['skill_listing', 'private-skill', 'artist@example.test', 'secret-project', 'You are Claude Code', 'Caveat', 'internal reasoning', 'usage', 'CLAUDE.md', 'iVBORw0KGgo', 'toolUseResult', 'gitBranch', 'requestId'])
      expect(saved, dropped).not.toContain(dropped)
    expect(lines[0]).toEqual({type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false, timestamp: '2026-09-30T10:00:00Z', message: {role: 'user', content: 'make a hero'}})
    expect(lines[1].message).toEqual({role: 'assistant', model: 'claude-opus-5', content: [
      {type: 'text', text: 'Generating.'},
      {type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {command: 'ls'}},
    ]})
    expect(lines[2].message.content).toEqual([
      {type: 'tool_result', tool_use_id: 'toolu_1', content: 'hero.png\n'},
      {type: 'image', media_type: 'image/png'},
    ])
    expect(lines[3]).toEqual({type: 'summary', summary: 'Made a hero image.', leafUuid: 'u2'})
  })

  it('still builds prompt, reply and tool nodes from the trimmed copy', async () => {
    const path = join(root, 'transcript.jsonl')
    await writeFile(path, claudeTranscript())
    const {sessionDir} = await saveSession({stdin: hook(path, 'SessionEnd'), home, now, env: UPLOAD_OFF})
    const folder = await readGraphFolder(await buildSessionGraphFolder(sessionDir))
    const kinds = folder.graph.nodes.map(node => node.semanticType ?? node.artifactKind).sort()
    expect(kinds).toEqual(expect.arrayContaining(['agent-session', 'prompt', 'transcript']))
    expect(folder.graph.nodes.some(node => node.artifactKind === 'text' && (node.payload as {text?: string})?.text === 'Generating.')).toBe(true)
    expect(folder.graph.nodes.some(node => node.artifactKind === 'run' && (node.payload as {toolName?: string})?.toolName === 'Bash')).toBe(true)
  })

  it('leaves a transcript in another format as it is', async () => {
    const path = join(root, 'transcript.jsonl')
    const codex = jsonl({type: 'session_meta', payload: {id: 'c1'}}, {type: 'response_item', payload: {type: 'message', role: 'user'}})
    await writeFile(path, codex)
    const {sessionDir} = await saveSession({stdin: hook(path, 'SessionEnd'), home, now, env: UPLOAD_OFF})
    expect(await readFile(join(sessionDir, 'transcript.jsonl'), 'utf8')).toBe(codex)
  })
})

describe('sessions saved before transcript trimming', () => {
  const legacyTranscript = (): string =>
    jsonl(
      {type: 'attachment', attachment: {type: 'session_context', context: {userEmail: 'artist@example.test'}}},
      {type: 'attachment', attachment: {type: 'prompt_snapshot', systemPrompt: ['You are Claude Code…']}},
      {type: 'user', uuid: 'u1', cwd: '/Users/artist/secret-project', message: {role: 'user', content: 'make a hero'}},
      {type: 'assistant', uuid: 'a1', message: {role: 'assistant', content: [{type: 'text', text: 'Done.'}]}},
    )
  // What an older CLI left behind: the whole transcript, already uploaded-ready.
  const legacySession = async (keepLiveTranscript: boolean) => {
    const live = join(root, 'transcript.jsonl')
    await writeFile(live, legacyTranscript())
    const {sessionDir} = await saveSession({stdin: hook(live, 'Stop'), home, now, env: UPLOAD_OFF})
    await writeFile(join(sessionDir, 'transcript.jsonl'), legacyTranscript())
    const meta = JSON.parse(await readFile(join(sessionDir, 'meta.json'), 'utf8'))
    delete meta.transcriptFormat
    await writeFile(join(sessionDir, 'meta.json'), JSON.stringify({...meta, status: 'pending-upload', dirty: false}))
    if (!keepLiveTranscript) await rm(live)
    return sessionDir
  }
  const sentBytes = (calls: {method: string; body?: unknown}[]) =>
    calls.filter(call => call.method === 'PUT').map(call => Buffer.from(call.body as Uint8Array).toString('utf8')).join('\n')

  it.each([
    ['while Claude Code still has the live transcript', true],
    ['after Claude Code removed the live transcript', false],
  ])('trims a pending session saved by an older CLI before uploading it, %s', async (_label, keepLive) => {
    const sessionDir = await legacySession(keepLive)
    const {fetchImpl, calls} = fakeServer()
    expect((await uploadSession(sessionDir, {fetchImpl, auth: {apiKey: 'ah_live_secretsecret', baseUrl: 'https://x.test'}})).ok).toBe(true)
    const saved = await readFile(join(sessionDir, 'transcript.jsonl'), 'utf8')
    for (const text of [saved, sentBytes(calls)]) {
      expect(text).not.toContain('artist@example.test')
      expect(text).not.toContain('You are Claude Code')
      expect(text).not.toContain('secret-project')
    }
    expect(saved).toContain('make a hero')
    expect(JSON.parse(await readFile(join(sessionDir, 'meta.json'), 'utf8')).transcriptFormat).toBe('conversation-v1')
  })
})
