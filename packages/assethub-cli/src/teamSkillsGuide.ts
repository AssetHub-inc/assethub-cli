import {readFile, writeFile, mkdir} from 'node:fs/promises'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

/**
 * Workspace skills and team skills are for AssetHub staff accounts, but the
 * bundled `assethub` skill is installed for every CLI user. So their guides are
 * separate sections the CLI appends to the installed SKILL.md only on a
 * computer whose account has them (remembered in `~/.assethub/team-skills.json`).
 * Everyone else keeps the bundled guide exactly as shipped.
 */

const MARKER = '<!-- assethub-team-skills:'
/** Added to the frontmatter's TRIGGER list so agents load the skill for these requests. */
const TRIGGERS = [
  '  - Any "I want …" request to make or change an asset, even when no skill is named ("I want a turnaround of hero.png", "bikin side view dong"): check the team\'s skills first, ask once, then run',
  '  - Using, listing, or choosing a workspace skill / method ("use the clay skill on this", "スキルを使って", "which skills do we have?")',
  '  - Making a new skill or saving a way of working ("make a skill from this", "save this as our method", "スキルにして", "bikin skill buat turnaround")',
  '  - Sharing a skill with AssetHub staff, or running one staff shared ("share it with staff", "stop sharing it", "which shared skills can I use?")',
  '  - Saving or sharing a team skill (a SKILL.md folder, its scripts, a Claude Code plugin) or getting the team\'s skills: "save skill", "simpan skill", "push my skill", "share my plugin", "スキルを保存", "pull the team skills"',
].join('\n')

export const packagedTeamSkillsSection = (): string =>
  fileURLToPath(new URL('../skills/team-skills.md', import.meta.url))

export const packagedWorkspaceSkillsSection = (): string =>
  fileURLToPath(new URL('../skills/workspace-skills.md', import.meta.url))

/** Workspace skills first, then team skills: the order an agent needs them. */
export const readStaffGuide = async (): Promise<string> =>
  `${(await readFile(packagedWorkspaceSkillsSection(), 'utf8')).trim()}\n\n${(await readFile(packagedTeamSkillsSection(), 'utf8')).trim()}\n`

const flagPath = (home: string) => join(home, '.assethub', 'team-skills.json')

export const readTeamSkillsFlag = async (home: string): Promise<boolean> => {
  try {
    return JSON.parse(await readFile(flagPath(home), 'utf8')).enabled === true
  } catch {
    return false
  }
}

export const writeTeamSkillsFlag = async (home: string, enabled: boolean): Promise<void> => {
  await mkdir(dirname(flagPath(home)), {recursive: true})
  await writeFile(flagPath(home), `${JSON.stringify({enabled, checkedAt: new Date().toISOString()})}\n`)
}

/** The bundled SKILL.md with the staff triggers and sections; idempotent. */
export const withTeamSkills = (skillMd: string, section: string): string => {
  if (skillMd.includes(MARKER)) return skillMd
  const doNot = '\n\n  DO NOT TRIGGER for:'
  const withTrigger = skillMd.includes(doNot) ? skillMd.replace(doNot, `\n${TRIGGERS}${doNot}`) : skillMd
  return `${withTrigger.replace(/\s*$/, '\n')}\n${section.trim()}\n`
}

/** Appends the section to `<skillDir>/SKILL.md` when enabled; a no-op otherwise. */
export const applyTeamSkillsSection = async (skillDir: string, enabled: boolean): Promise<void> => {
  if (!enabled) return
  const file = join(skillDir, 'SKILL.md')
  await writeFile(file, withTeamSkills(await readFile(file, 'utf8'), await readStaffGuide()))
}
