import {readFile, writeFile, mkdir} from 'node:fs/promises'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

/**
 * Team skills are internal-only, but the bundled `assethub` skill is installed
 * for every CLI user. So their guide is a separate section the CLI appends to
 * the installed SKILL.md only on a computer whose account has team skills
 * (remembered in `~/.assethub/team-skills.json`). Everyone else keeps the
 * bundled guide exactly as shipped.
 */

const MARKER = '<!-- assethub-team-skills:'
/** Added to the frontmatter's TRIGGER list so agents load the skill for these requests. */
const TRIGGER =
  '  - Saving or sharing a team skill (a SKILL.md folder, its scripts, a Claude Code plugin) or getting the team\'s skills: "save skill", "simpan skill", "push my skill", "share my plugin", "スキルを保存", "pull the team skills"'

export const packagedTeamSkillsSection = (): string =>
  fileURLToPath(new URL('../skills/team-skills.md', import.meta.url))

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

/** The bundled SKILL.md with the team skills trigger and section; idempotent. */
export const withTeamSkills = (skillMd: string, section: string): string => {
  if (skillMd.includes(MARKER)) return skillMd
  const doNot = '\n\n  DO NOT TRIGGER for:'
  const withTrigger = skillMd.includes(doNot) ? skillMd.replace(doNot, `\n${TRIGGER}${doNot}`) : skillMd
  return `${withTrigger.replace(/\s*$/, '\n')}\n${section.trim()}\n`
}

/** Appends the section to `<skillDir>/SKILL.md` when enabled; a no-op otherwise. */
export const applyTeamSkillsSection = async (skillDir: string, enabled: boolean): Promise<void> => {
  if (!enabled) return
  const file = join(skillDir, 'SKILL.md')
  const section = await readFile(packagedTeamSkillsSection(), 'utf8')
  await writeFile(file, withTeamSkills(await readFile(file, 'utf8'), section))
}
