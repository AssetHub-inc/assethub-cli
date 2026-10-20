import {mkdir, mkdtemp, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
import {readGoalSkillImport} from '../goalSkillImport.js'

const skill = {schemaVersion: 'ag.memory-skill.v8', skillId: 'weapon'}

const folder = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-skill-'))
  await writeFile(join(dir, 'skill.json'), JSON.stringify(skill))
  await mkdir(join(dir, 'references', 'extra'), {recursive: true})
  await writeFile(join(dir, 'references', 'weapon_checks.py'), 'print(1)')
  await writeFile(join(dir, 'references', 'extra', 'rubric.md'), '# r')
  await writeFile(join(dir, 'references', '.DS_Store'), 'x')
  return dir
}

describe('readGoalSkillImport', () => {
  it('reads a skill folder: skill.json plus every file under references/', async () => {
    const dir = await folder()
    expect(await readGoalSkillImport(dir)).toEqual({
      skill,
      files: {
        'references/extra/rubric.md': '# r',
        'references/weapon_checks.py': 'print(1)',
      },
    })
  })

  it('reads the references/ next to a skill.json path too', async () => {
    const dir = await folder()
    const result = await readGoalSkillImport(join(dir, 'skill.json'))
    expect(Object.keys(result.files)).toEqual([
      'references/extra/rubric.md',
      'references/weapon_checks.py',
    ])
  })

  it('sends no files when the skill has no references/', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goal-skill-'))
    await writeFile(join(dir, 'skill.json'), JSON.stringify(skill))
    expect(await readGoalSkillImport(join(dir, 'skill.json'))).toEqual({
      skill,
      files: {},
    })
  })
})
