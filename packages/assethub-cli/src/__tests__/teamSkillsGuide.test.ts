import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  canonicalSkillDir,
  installSkill,
  packagedSkillDir,
  refreshTeamSkillsGuide,
} from '../agentSetup.js'
import {
  packagedTeamSkillsSection,
  readTeamSkillsFlag,
  withTeamSkills,
  writeTeamSkillsFlag,
} from '../teamSkillsGuide.js'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'assethub-team-guide-'))
  vi.stubEnv('ASSETHUB_CLI_HOME', home)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(home, {recursive: true, force: true})
})

const installed = () => readFile(join(canonicalSkillDir(home), 'SKILL.md'), 'utf8')
const bundled = () => readFile(join(packagedSkillDir(), 'SKILL.md'), 'utf8')

describe('withTeamSkills', () => {
  it('adds the trigger inside the description and the section at the end, once', async () => {
    const section = await readFile(packagedTeamSkillsSection(), 'utf8')
    const once = withTeamSkills(await bundled(), section)
    const frontmatter = once.split('\n---\n')[0]
    expect(frontmatter).toContain('"save skill", "simpan skill"')
    expect(frontmatter.indexOf('save skill')).toBeLessThan(frontmatter.indexOf('DO NOT TRIGGER for:'))
    expect(once.trimEnd().endsWith(section.trim())).toBe(true)
    expect(withTeamSkills(once, section)).toBe(once)
  })
})

describe('the installed guide', () => {
  it('stays exactly the bundled guide on a computer without team skills', async () => {
    await installSkill({root: home, version: '9.9.9', dryRun: false})
    expect(await installed()).toBe(await bundled())
    expect(await installed()).not.toContain('Team skills')
    expect(await installed()).not.toMatch(/skills list --runnable|workspace skill/i)
  })

  it('carries the team skills section once the account has team skills, and drops it again', async () => {
    await installSkill({root: home, version: '9.9.9', dryRun: false})
    await refreshTeamSkillsGuide(home, true)
    expect(await readTeamSkillsFlag(home)).toBe(true)
    expect(await installed()).toContain('Save a skill: it is shared with everyone in the workspace, so always ask.')
    expect(await installed()).toContain("## Workspace skills: the team's saved methods")
    expect(await installed()).toContain('Using, listing, or choosing a workspace skill')
    await refreshTeamSkillsGuide(home, false)
    expect(await installed()).toBe(await bundled())
  })

  it('keeps the section through a CLI upgrade', async () => {
    await writeTeamSkillsFlag(home, true)
    await installSkill({root: home, version: '9.9.9', dryRun: false})
    expect(await installed()).toContain('Team skills: your team')
    await installSkill({root: home, version: '9.9.10', dryRun: false})
    const text = await installed()
    expect(text.split('<!-- assethub-team-skills:').length).toBe(2)
  })

  it('records the flag even before the guide is installed', async () => {
    await refreshTeamSkillsGuide(home, true)
    expect(await readTeamSkillsFlag(home)).toBe(true)
  })
})
