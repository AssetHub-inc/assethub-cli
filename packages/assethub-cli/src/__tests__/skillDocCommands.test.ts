import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'
import {usage} from '../index.js'

// The bundled agent skill is what artists' assistants follow. A command or flag
// it names that this CLI does not have makes the assistant fail at that step,
// so every one of them must appear in the CLI's own usage text.
const skill = readFileSync(
  fileURLToPath(new URL('../../skills/assethub/SKILL.md', import.meta.url)),
  'utf8',
)

const VERB = /^[a-z][a-z0-9-]*$/


/** Every `assethub …` invocation in code spans and code blocks. */
const invocations = (): string[] => {
  const code = [
    ...skill.matchAll(/```[a-z]*\n([\s\S]*?)```/g),
    ...skill.matchAll(/`([^`\n]+)`/g),
  ].map(match => match[1])
  return code
    .flatMap(text => text.replace(/\\\n\s*/g, ' ').split('\n'))
    .flatMap(line => [...line.matchAll(/assethub\s+[^#&|;]+/g)].map(m => m[0].trim()))
}

const commandOf = (invocation: string) => {
  const words = invocation.split(/\s+/).slice(1)
  const verbs: string[] = []
  for (const word of words) {
    if (!VERB.test(word) || verbs.length === 3) break
    verbs.push(word)
  }
  return verbs
}

describe('bundled SKILL.md', () => {
  const found = invocations()

  it('names commands at all (the extractor works)', () => {
    expect(found.length).toBeGreaterThan(30)
    expect(found).toContain('assethub skills list --runnable')
  })

  it('names only commands this CLI has', () => {
    const missing = found
      .map(commandOf)
      .filter(verbs => verbs.length > 0)
      .filter(verbs => {
        // Longest documented prefix: `skills official install` and `skills run`
        // are both real; `skills list` is real even though `list --runnable`
        // carries a flag.
        for (let n = verbs.length; n > 0; n--)
          if (usage.includes(`assethub ${verbs.slice(0, n).join(' ')}`)) return false
        return true
      })
      .map(verbs => verbs.join(' '))
    expect([...new Set(missing)]).toEqual([])
  })

  // Agents on Windows run these in PowerShell or cmd.exe. A trailing `\` is
  // not a continuation there (PowerShell runs the first half alone, dropping
  // e.g. the revision pin), `$(…)` is not command substitution in cmd and runs
  // a missing `uuidgen` in PowerShell, and single quotes do not quote in cmd.
  it('writes every command so PowerShell and cmd.exe run it as written', () => {
    const unsafe = found.filter(
      invocation => /\\\s*$|\$\(|\s'[^']*'/.test(invocation),
    )
    const blocks = [...skill.matchAll(/```(?:bash|sh|shell)?\n([\s\S]*?)```/g)]
      .flatMap(match => match[1].split('\n'))
      .filter(line => /\\\s*$|\$\(/.test(line))
    expect([...unsafe, ...blocks]).toEqual([])
  })

  it('names only flags this CLI documents', () => {
    const flags = new Set(
      found.flatMap(invocation => [...invocation.matchAll(/\s(--[a-z][a-z0-9-]*)/g)].map(m => m[1])),
    )
    const documented = (flag: string) =>
      new RegExp(`${flag}(?![a-z0-9-])`).test(usage)
    const missing = [...flags].filter(flag => !documented(flag))
    expect(missing).toEqual([])
  })
})
