import {readdir, readFile, stat} from 'node:fs/promises'
import {dirname, join, relative, sep} from 'node:path'

/** Skips editor and OS litter such as `.DS_Store`. */
const isHidden = (name: string) => name.startsWith('.')

const listFiles = async (dir: string): Promise<string[]> => {
  // A skill without references/ is fine; any other read failure would drop files silently.
  const entries = await readdir(dir, {withFileTypes: true}).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const nested = await Promise.all(
    entries
      .filter(entry => !isHidden(entry.name))
      .map(entry =>
        entry.isDirectory()
          ? listFiles(join(dir, entry.name))
          : Promise.resolve(entry.isFile() ? [join(dir, entry.name)] : []),
      ),
  )
  return nested.flat()
}

/**
 * What `skills import-goal` sends: the skill.json and the texts under the
 * `references/` folder beside it (scripts such as weapon_checks.py, rubrics),
 * so the goal runner's Blender sandbox can run them. Takes the skill folder
 * or its skill.json.
 */
export const readGoalSkillImport = async (
  path: string,
): Promise<{skill: Record<string, unknown>; files: Record<string, string>}> => {
  const isDir = (await stat(path)).isDirectory()
  const root = isDir ? path : dirname(path)
  const skill = JSON.parse(
    await readFile(isDir ? join(path, 'skill.json') : path, 'utf8'),
  ) as Record<string, unknown>
  const paths = (await listFiles(join(root, 'references'))).sort()
  const files: Record<string, string> = {}
  for (const file of paths)
    files[relative(root, file).split(sep).join('/')] = await readFile(
      file,
      'utf8',
    )
  return {skill, files}
}
