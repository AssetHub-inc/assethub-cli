import {lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import type {SkillPackage, SkillPackagePushInput} from '@assethub/api-client'
import {
  describePull,
  filesSha256,
  findSkillFolders,
  findSkillProblems,
  planPush,
  pullSkills,
  pushSkills,
  readLock,
  readSkillFolder,
  slugSkillId,
  useSkillRevision,
  type TeamSkillsApi,
} from '../teamSkills.js'

/** An in-memory workspace store with the server's revision rules. */
const fakeApi = (): TeamSkillsApi & {rows: SkillPackage[]} => {
  const rows: SkillPackage[] = []
  const latest = (skillId: string) =>
    rows.filter(row => row.skillId === skillId).sort((a, b) => b.revision - a.revision)[0]
  const summary = ({files: _files, ...rest}: SkillPackage) => rest
  return {
    rows,
    async pushSkillPackage(body: SkillPackagePushInput) {
      const sha = filesSha256(body.files)
      const same = rows.find(row => row.skillId === body.skillId && row.filesSha256 === sha)
      if (same) return {...summary(same), created: false}
      const top = latest(body.skillId)
      if (top && (body.baseRevision ?? 0) < top.revision)
        throw Object.assign(new Error('stale'), {code: 'SKILL_PACKAGE_STALE', details: {latest: summary(top)}})
      const row: SkillPackage = {
        skillId: body.skillId,
        name: body.name,
        description: body.description,
        revision: (top?.revision ?? 0) + 1,
        filesSha256: sha,
        fileCount: Object.keys(body.files).length,
        bytes: 0,
        note: body.note ?? null,
        source: body.source ?? null,
        author: 'Gino',
        createdAt: '2026-10-29T10:00:00Z',
        files: body.files,
      }
      rows.push(row)
      return {...summary(row), created: true}
    },
    async listSkillPackages() {
      const ids = [...new Set(rows.map(row => row.skillId))]
      return {items: ids.map(id => summary(latest(id)))}
    },
    async getSkillPackage(skillId: string, options: {revision?: number} = {}) {
      const row =
        options.revision === undefined
          ? latest(skillId)
          : rows.find(r => r.skillId === skillId && r.revision === options.revision)
      if (!row) throw new Error('not found')
      return row
    },
  }
}

let root: string
let gino: string
let ivan: string

const writeSkill = async (dir: string, files: Record<string, string | Buffer>) => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), {recursive: true})
    await writeFile(join(dir, path), content)
  }
}

const RIG_SKILL = '---\nname: cc2-rig-adapt\ndescription: Adapt a CC2 template rig to a new character\n---\n\n# Rig adapt\n'

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'team-skills-'))
  gino = join(root, 'gino')
  ivan = join(root, 'ivan')
})

afterEach(async () => {
  await rm(root, {recursive: true, force: true})
})

describe('reading a skill folder', () => {
  it('takes the id from SKILL.md, evens out line endings and leaves out binaries, hidden files and local.json', async () => {
    const dir = join(root, 'src', 'rig')
    await writeSkill(dir, {
      'SKILL.md': RIG_SKILL.replace(/\n/g, '\r\n'),
      'scripts/rig_adapt.py': 'print("hi")\r\n',
      'templates/PL018.mb': Buffer.from([0x4d, 0x00, 0x01]),
      'templates/latin1.bin': Buffer.from([0x4d, 0xe9, 0xff, 0x41]),
      'local.json': '{"maya": "C:/Users/gino/maya"}',
      '.DS_Store': 'x',
    })
    const folder = await readSkillFolder(dir)
    expect(folder.skillId).toBe('cc2-rig-adapt')
    expect(folder.description).toBe('Adapt a CC2 template rig to a new character')
    expect(Object.keys(folder.files)).toEqual(['SKILL.md', 'scripts/rig_adapt.py'])
    expect(folder.files['scripts/rig_adapt.py']).toBe('print("hi")\n')
    expect(folder.skipped.map(s => s.path).sort()).toEqual(['local.json', 'templates/PL018.mb', 'templates/latin1.bin'])
  })

  it('reads every skill of a Claude Code plugin with its name and version', async () => {
    const plugin = join(root, 'drecom-colour-mask-parts')
    await writeSkill(plugin, {
      '.claude-plugin/plugin.json': JSON.stringify({name: 'drecom-colour-mask-parts', version: '0.4.0'}),
      'skills/colour-mask/SKILL.md': '---\nname: drecom-colour-mask\ndescription: Split a concept by colour mask\n---\n',
      'skills/part-views/SKILL.md': '---\nname: drecom-part-views\ndescription: Make views per part\n---\n',
      'hooks/hooks.json': '{}',
    })
    const folders = await findSkillFolders(plugin)
    expect(folders.map(f => f.skillId)).toEqual(['drecom-colour-mask', 'drecom-part-views'])
    expect(folders[0].source).toEqual({plugin: 'drecom-colour-mask-parts', pluginVersion: '0.4.0'})
  })

  it('makes ids from names', () => {
    expect(slugSkillId('Rig Adapt (CC2)')).toBe('rig-adapt-cc2')
  })
})

describe('checks before a push', () => {
  it('blocks keys, private links, secret files and paths on one computer, but not placeholders', () => {
    const problems = findSkillProblems({
      'SKILL.md': [
        'Use the key sk-abcdefghijklmnopqrstuvwxyz123456',
        'Download https://bucket.s3.amazonaws.com/a.png?X-Amz-Signature=0123456789abcdef0123',
        'Open C:\\Users\\gino\\Documents\\maya',
        'Your folder: /Users/<you>/Documents',
        'Run with $HOME/.config',
      ].join('\n'),
      '.env': 'A=1',
    })
    expect(problems.map(p => `${p.path}:${p.line} ${p.kind}`)).toEqual([
      'SKILL.md:1 API key or token',
      'SKILL.md:2 signed or private link',
      'SKILL.md:3 path on one computer (move it to local.json)',
      '.env:0 secret file',
    ])
  })

  it('refuses the id of the CLI guide', async () => {
    const dir = join(root, 'assethub')
    await writeSkill(dir, {'SKILL.md': '---\nname: assethub\n---\n'})
    await expect(planPush(dir, gino)).rejects.toThrow(/own guide/)
  })
})

describe('push then pull', () => {
  it('gives a teammate the skill in each agent, and says what changed', async () => {
    const api = fakeApi()
    const src = join(root, 'gino-src')
    await writeSkill(src, {'SKILL.md': RIG_SKILL, 'scripts/rig_adapt.py': 'v1\n'})
    const {plan, folders} = await planPush(src, gino)
    expect(plan.problems).toEqual([])
    expect(plan.skills[0].baseRevision).toBeNull()
    expect(await pushSkills(api, gino, folders, {note: 'first version'})).toMatchObject([
      {skillId: 'cc2-rig-adapt', revision: 1, created: true},
    ])

    const first = await pullSkills(api, ivan, ['claude-code', 'codex'])
    expect(first[0]).toMatchObject({status: 'installed', revision: 1})
    const installed = join(ivan, '.agents', 'skills', 'cc2-rig-adapt')
    expect(await readFile(join(installed, 'scripts', 'rig_adapt.py'), 'utf8')).toBe('v1\n')
    for (const agentDir of ['.claude', '.codex']) {
      const link = join(ivan, agentDir, 'skills', 'cc2-rig-adapt')
      expect((await lstat(link)).isSymbolicLink()).toBe(true)
      expect(await readlink(link)).toContain('cc2-rig-adapt')
    }
    expect(describePull(await pullSkills(api, ivan, ['claude-code']))).toEqual([])

    await writeSkill(src, {'scripts/rig_adapt.py': 'v2\n'})
    const again = await planPush(src, gino)
    expect(again.plan.skills[0].baseRevision).toBe(1)
    await pushSkills(api, gino, again.folders, {note: 'fingers in one pass'})
    expect(describePull(await pullSkills(api, ivan, ['claude-code']))).toEqual([
      'cc2-rig-adapt rev 1 -> rev 2 (Gino: fingers in one pass)',
    ])
    expect(await readFile(join(installed, 'scripts', 'rig_adapt.py'), 'utf8')).toBe('v2\n')
  })

  it('returns the stored revision for identical content', async () => {
    const api = fakeApi()
    const src = join(root, 'src')
    await writeSkill(src, {'SKILL.md': RIG_SKILL})
    await pushSkills(api, gino, (await planPush(src, gino)).folders)
    expect(await pushSkills(api, gino, (await planPush(src, gino)).folders)).toMatchObject([{revision: 1, created: false}])
  })

  it('stops when a teammate saved a newer revision, and saves on top when asked', async () => {
    const api = fakeApi()
    const src = join(root, 'src')
    await writeSkill(src, {'SKILL.md': RIG_SKILL})
    await pushSkills(api, gino, (await planPush(src, gino)).folders)
    await writeSkill(src, {'notes.md': 'mine\n'})
    // Iván has never pulled, so his push starts from no revision.
    await expect(pushSkills(api, ivan, (await planPush(src, ivan)).folders)).rejects.toMatchObject({code: 'SKILL_PACKAGE_STALE'})
    expect(await pushSkills(api, ivan, (await planPush(src, ivan)).folders, {onTop: true})).toMatchObject([{revision: 2}])
  })

  it('keeps a copy the person changed, and replaces it only when asked; local.json always stays', async () => {
    const api = fakeApi()
    const src = join(root, 'src')
    await writeSkill(src, {'SKILL.md': RIG_SKILL})
    await pushSkills(api, gino, (await planPush(src, gino)).folders)
    await pullSkills(api, ivan, ['claude-code'])
    const installed = join(ivan, '.agents', 'skills', 'cc2-rig-adapt')
    await writeFile(join(installed, 'SKILL.md'), `${RIG_SKILL}\nIván's fix\n`)
    await writeFile(join(installed, 'local.json'), '{"maya": "D:/maya"}')
    await writeSkill(src, {'notes.md': 'team change\n'})
    await pushSkills(api, gino, (await planPush(src, gino)).folders)

    const kept = await pullSkills(api, ivan, ['claude-code'])
    expect(kept[0].status).toBe('kept-local')
    expect(describePull(kept)[0]).toMatch(/you changed your copy, so it was kept/)
    expect(await readFile(join(installed, 'SKILL.md'), 'utf8')).toContain("Iván's fix")

    const replaced = await pullSkills(api, ivan, ['claude-code'], {replaceLocal: ['cc2-rig-adapt']})
    expect(replaced[0].status).toBe('updated')
    expect(await readFile(join(installed, 'SKILL.md'), 'utf8')).not.toContain("Iván's fix")
    expect(await readFile(join(installed, 'local.json'), 'utf8')).toBe('{"maya": "D:/maya"}')
  })

  it('pushing the installed copy makes it the team revision, so pull is quiet afterwards', async () => {
    const api = fakeApi()
    const src = join(root, 'src')
    await writeSkill(src, {'SKILL.md': RIG_SKILL})
    await pushSkills(api, gino, (await planPush(src, gino)).folders)
    await pullSkills(api, ivan, ['claude-code'])
    const installed = join(ivan, '.agents', 'skills', 'cc2-rig-adapt')
    await writeFile(join(installed, 'SKILL.md'), `${RIG_SKILL}\nfeet fix\n`)
    expect(await pushSkills(api, ivan, (await planPush(installed, ivan)).folders)).toMatchObject([{revision: 2}])
    expect((await pullSkills(api, ivan, ['claude-code']))[0].status).toBe('unchanged')
  })

  it('leaves a folder it did not write alone', async () => {
    const api = fakeApi()
    const src = join(root, 'src')
    await writeSkill(src, {'SKILL.md': RIG_SKILL})
    await pushSkills(api, gino, (await planPush(src, gino)).folders)
    await writeSkill(join(ivan, '.agents', 'skills', 'cc2-rig-adapt'), {'SKILL.md': 'my own\n'})
    expect((await pullSkills(api, ivan, ['claude-code']))[0].status).toBe('kept-existing')
  })

  it('pins a revision until the person follows the newest again', async () => {
    const api = fakeApi()
    const src = join(root, 'src')
    await writeSkill(src, {'SKILL.md': RIG_SKILL})
    await pushSkills(api, gino, (await planPush(src, gino)).folders)
    await writeSkill(src, {'notes.md': 'v2\n'})
    await pushSkills(api, gino, (await planPush(src, gino)).folders)

    await useSkillRevision(api, ivan, ['claude-code'], 'cc2-rig-adapt', 1)
    expect((await pullSkills(api, ivan, ['claude-code']))[0]).toMatchObject({status: 'pinned', revision: 1})
    expect((await readLock(ivan)).skills['cc2-rig-adapt']).toMatchObject({revision: 1, pinned: true})
    await useSkillRevision(api, ivan, ['claude-code'], 'cc2-rig-adapt', 'latest')
    expect((await readLock(ivan)).skills['cc2-rig-adapt']).toMatchObject({revision: 2})
    expect((await readLock(ivan)).skills['cc2-rig-adapt'].pinned).toBeUndefined()
  })
  it('saves none of a plugin\'s skills when one of them is behind the team', async () => {
    const api = fakeApi()
    const plugin = join(root, 'plugin')
    await writeSkill(plugin, {
      'skills/a/SKILL.md': '---\nname: skill-a\n---\n',
      'skills/b/SKILL.md': '---\nname: skill-b\n---\n',
    })
    const other = join(root, 'other-b')
    await writeSkill(other, {'SKILL.md': '---\nname: skill-b\n---\nteammate version\n'})
    await pushSkills(api, ivan, (await planPush(other, ivan)).folders)
    await expect(pushSkills(api, gino, (await planPush(plugin, gino)).folders)).rejects.toMatchObject({code: 'SKILL_PACKAGE_STALE'})
    expect(api.rows.map(row => row.skillId)).toEqual(['skill-b'])
  })

  it('brings back a pinned copy that was deleted, at its pinned revision', async () => {
    const api = fakeApi()
    const src = join(root, 'src')
    await writeSkill(src, {'SKILL.md': RIG_SKILL})
    await pushSkills(api, gino, (await planPush(src, gino)).folders)
    await writeSkill(src, {'notes.md': 'v2\n'})
    await pushSkills(api, gino, (await planPush(src, gino)).folders)
    await useSkillRevision(api, ivan, ['claude-code'], 'cc2-rig-adapt', 1)
    await rm(join(ivan, '.agents', 'skills', 'cc2-rig-adapt'), {recursive: true})
    expect((await pullSkills(api, ivan, ['claude-code']))[0]).toMatchObject({status: 'pinned', revision: 1})
    expect((await readLock(ivan)).skills['cc2-rig-adapt']).toMatchObject({revision: 1, pinned: true})
  })

  it('keeps an edited copy even when the lock file was lost', async () => {
    const api = fakeApi()
    const src = join(root, 'src')
    await writeSkill(src, {'SKILL.md': RIG_SKILL})
    await pushSkills(api, gino, (await planPush(src, gino)).folders)
    await pullSkills(api, ivan, ['claude-code'])
    const installed = join(ivan, '.agents', 'skills', 'cc2-rig-adapt')
    await writeFile(join(installed, 'SKILL.md'), `${RIG_SKILL}\nmine\n`)
    await rm(join(ivan, '.agents', 'skills', '.assethub-team-skills.json'))
    await writeSkill(src, {'notes.md': 'v2\n'})
    await pushSkills(api, gino, (await planPush(src, gino)).folders)
    expect((await pullSkills(api, ivan, ['claude-code']))[0].status).toBe('kept-local')
    expect(await readFile(join(installed, 'SKILL.md'), 'utf8')).toContain('mine')
  })
})

