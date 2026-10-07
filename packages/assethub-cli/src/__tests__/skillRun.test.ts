import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import type {WorkspaceSkillRun} from '@assethub/api-client'
import {
  describeSkillRunProgress,
  listRunnableSkills,
  nextSkillRunAction,
  pinSkill,
  saveSkillRunAttempts,
  saveSkillRunOutputs,
  waitForSkillRun,
  type SkillRunClient,
} from '../skillRun.js'

const runId = '33333333-3333-4333-8333-333333333333'

const tempDirs: string[] = []
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skill-run-'))
  tempDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, {recursive: true, force: true})))
})
const sha = 'a'.repeat(64)

const view = (patch: Partial<WorkspaceSkillRun> = {}): WorkspaceSkillRun => ({
  runId,
  skillId: 'figure-clay',
  status: 'running',
  budget: {credits: 100, spentCredits: 0, remainingCredits: 100},
  steps: [],
  verdicts: [],
  outputs: [],
  outcome: null,
  parts: [],
  ...patch,
})

const client = (over: Partial<SkillRunClient['v2']> = {}): SkillRunClient => ({
  v2: {
    getWorkspaceSkill: async () => ({
      skill: {skillId: 'figure-clay', revision: 5, contentSha256: sha, title: 'Figure → clay'},
    }),
    startWorkspaceSkillRun: async () => {
      throw new Error('not expected')
    },
    getWorkspaceSkillRun: async () => view(),
    getAsset: async assetId => ({url: `https://files.test/${assetId}.png`}),
    ...over,
  },
})

describe('pinSkill', () => {
  it('pins the current revision and hash when none is named', async () => {
    expect(await pinSkill(client(), 'figure-clay', {})).toEqual({
      skillId: 'figure-clay',
      title: 'Figure → clay',
      revision: 5,
      contentSha256: sha,
    })
  })

  it('refuses a revision whose content is not what the person approved', async () => {
    await expect(
      pinSkill(client(), 'figure-clay', {revision: 5, contentSha256: 'b'.repeat(64)}),
    ).rejects.toThrow(/not the version you approved/)
  })

  it('asks the server for the named revision', async () => {
    const asked: unknown[] = []
    await pinSkill(
      client({
        getWorkspaceSkill: async (_id, options) => {
          asked.push(options)
          return {skill: {skillId: 'figure-clay', revision: 3, contentSha256: sha, title: 't'}}
        },
      }),
      'figure-clay',
      {revision: 3},
    )
    expect(asked).toEqual([{revision: 3}])
  })
})

describe('describeSkillRunProgress', () => {
  it('says each finished try and every AI check in plain words, once', () => {
    const first = view({
      steps: [
        {stepId: 's1', stage: 'image', attempt: 1, status: 'completed', artifactId: 'a1'},
        {stepId: 's1', stage: 'review', attempt: 1, status: 'completed', artifactId: 'r1'},
      ],
      verdicts: [
        {stepId: 's1', attempt: 1, pass: false, by: 'ai', reason: 'the fingers look fused'},
      ],
    })
    expect(describeSkillRunProgress(undefined, first)).toEqual([
      'Try 1: Making the image - done.',
      'AI check (try 1): the fingers look fused. Correcting it automatically.',
    ])
    const second = view({
      ...first,
      status: 'completed',
      steps: [
        ...first.steps,
        {stepId: 's1', stage: 'image', attempt: 2, status: 'completed', artifactId: 'a2'},
      ],
      verdicts: [
        ...first.verdicts,
        {stepId: 's1', attempt: 2, pass: true, by: 'ai', reason: null},
      ],
    })
    expect(describeSkillRunProgress(first, second)).toEqual([
      'Try 2: Making the image - done.',
      'AI check (try 2): looks right.',
      'Finished.',
    ])
  })

  it('says when the spending limit pauses the run', () => {
    expect(
      describeSkillRunProgress(
        view(),
        view({
          status: 'budget_exhausted',
          budget: {credits: 100, spentCredits: 96, remainingCredits: 4},
        }),
      ),
    ).toEqual(['Paused: the spending limit is reached (96 of 100 credits used).'])
  })
})

describe('waitForSkillRun', () => {
  it('polls until the run settles and reports progress on the way', async () => {
    const states = [
      view(),
      view({
        steps: [{stepId: 's', stage: 'image', attempt: 1, status: 'completed', artifactId: 'a'}],
      }),
      view({
        status: 'budget_exhausted',
        steps: [{stepId: 's', stage: 'image', attempt: 1, status: 'completed', artifactId: 'a'}],
        budget: {credits: 50, spentCredits: 50, remainingCredits: 0},
      }),
    ]
    const lines: string[] = []
    const {run, timedOut} = await waitForSkillRun({
      client: client({getWorkspaceSkillRun: async () => states.shift()!}),
      skillId: 'figure-clay',
      runId,
      onProgress: line => lines.push(line),
      sleep: async () => undefined,
    })
    expect(timedOut).toBe(false)
    expect(run.status).toBe('budget_exhausted')
    expect(lines).toEqual([
      'Try 1: Making the image - done.',
      'Paused: the spending limit is reached (50 of 50 credits used).',
    ])
  })

  it('retries a poll that stalls instead of hanging on it', async () => {
    let calls = 0
    const {run, timedOut} = await waitForSkillRun({
      client: client({
        getWorkspaceSkillRun: async () => {
          calls++
          if (calls === 1) return new Promise<never>(() => undefined)
          return view({status: 'completed'})
        },
      }),
      skillId: 'figure-clay',
      runId,
      onProgress: () => undefined,
      sleep: async () => undefined,
      requestTimeoutMs: 5,
    })
    expect(calls).toBe(2)
    expect(timedOut).toBe(false)
    expect(run.status).toBe('completed')
  })

  it('stops waiting at the deadline without touching the run', async () => {
    let time = 0
    const {timedOut, run} = await waitForSkillRun({
      client: client(),
      skillId: 'figure-clay',
      runId,
      onProgress: () => undefined,
      timeoutMs: 10,
      now: () => time,
      sleep: async ms => {
        time += ms
      },
      pollMs: 6,
    })
    expect(timedOut).toBe(true)
    expect(run.status).toBe('running')
  })
})

describe('saveSkillRunOutputs', () => {
  const png = new Uint8Array([137, 80, 78, 71])
  const fetchImpl = (async () =>
    new Response(png, {headers: {'content-type': 'image/png'}})) as typeof fetch

  it('saves verified outputs next to the original and never overwrites a file', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'cat.png'), 'original')
    await writeFile(join(dir, 'cat.figure-clay.png'), 'an earlier result')
    const result = await saveSkillRunOutputs({
      client: client(),
      run: view({
        status: 'completed',
        outputs: [
          {artifactId: 'a', stepId: 's', kind: 'image', assetId: 'img_1', verified: true},
          {artifactId: 'b', stepId: 's', kind: 'image', assetId: 'img_2', verified: false},
        ],
      }),
      skillTitle: 'Figure → clay',
      outDir: dir,
      sourceFileName: 'cat.png',
      fetchImpl,
    })
    expect(result.failed).toEqual([])
    expect(result.saved).toEqual([
      {assetId: 'img_1', path: join(dir, 'cat.figure-clay-2.png')},
    ])
    expect(await readFile(join(dir, 'cat.png'), 'utf8')).toBe('original')
    expect(await readFile(join(dir, 'cat.figure-clay.png'), 'utf8')).toBe(
      'an earlier result',
    )
    expect((await readdir(dir)).sort()).toEqual([
      'cat.figure-clay-2.png',
      'cat.figure-clay.png',
      'cat.png',
    ])
  })

  it('creates an --out-dir that does not exist yet', async () => {
    const dir = join(await tempDir(), 'new', 'folder')
    const result = await saveSkillRunOutputs({
      client: client(),
      run: view({
        outputs: [{artifactId: 'a', stepId: 's', kind: 'image', assetId: 'img_1', verified: true}],
      }),
      skillTitle: 'Clay',
      outDir: dir,
      fetchImpl,
    })
    expect(result.failed).toEqual([])
    expect(await readFile(join(dir, 'result.clay.png'))).toEqual(Buffer.from(png))
  })

  it('records a download that failed instead of dropping it', async () => {
    const dir = await tempDir()
    const result = await saveSkillRunOutputs({
      client: client(),
      run: view({
        outputs: [{artifactId: 'a', stepId: 's', kind: 'image', assetId: 'img_1', verified: true}],
      }),
      skillTitle: 'x',
      outDir: dir,
      fetchImpl: (async () => new Response('', {status: 403})) as typeof fetch,
    })
    expect(result).toEqual({saved: [], failed: [{assetId: 'img_1', error: 'HTTP 403'}]})
  })
})

describe('nextSkillRunAction', () => {
  it('points a paused run at resume, never at a new run', () => {
    expect(nextSkillRunAction(view({status: 'budget_exhausted'}))).toBe(
      `Ask before spending more, then: assethub skills run-resume figure-clay ${runId} --add-credits <n> --wait`,
    )
  })
})

describe('listRunnableSkills', () => {
  const row = (skillId: string, patch: Record<string, unknown> = {}) => ({
    skillId,
    summary: `Summary of ${skillId}`,
    schemaVersion: 'ag.memory-skill.v7',
    mode: 'manual',
    revision: 1,
    taskKind: 'concept_art',
    ...patch,
  })

  it('keeps only v7 skills that are not off, across every page, and flags look-alikes', async () => {
    const pages: Record<string, {items: ReturnType<typeof row>[]; nextCursor: string | null}> = {
      first: {
        items: [
          row('turn-a', {summary: 'Turnaround view Make one view'}),
          row('old', {schemaVersion: 'ag.memory-skill.v3'}),
          row('paused', {mode: 'off'}),
        ],
        nextCursor: 'c2',
      },
      c2: {items: [row('turn-b', {summary: 'Turnaround view Make one view'}), row('clay')], nextCursor: null},
    }
    const result = await listRunnableSkills(async cursor => pages[cursor ?? 'first'])
    expect(result.items.map(item => item.skillId)).toEqual(['turn-a', 'turn-b', 'clay'])
    expect(result.items[0]).toEqual({
      skillId: 'turn-a',
      summary: 'Turnaround view Make one view',
      revision: 1,
      mode: 'manual',
      taskKind: 'concept_art',
      sameSummaryAs: ['turn-b'],
    })
    expect(result.items[2]).not.toHaveProperty('sameSummaryAs')
    expect(result.notRunnable).toEqual({total: 2, off: 1, otherVersion: 1})
  })

  it('explains what to do when nothing can run', async () => {
    const result = await listRunnableSkills(async () => ({
      items: [row('old', {schemaVersion: 'ag.memory-skill.v4'})],
      nextCursor: null,
    }))
    expect(result.items).toEqual([])
    expect(result.hint).toMatch(/No skill in this workspace can run on an image yet/)
  })
})

describe('saveSkillRunAttempts', () => {
  const png = new Uint8Array([137, 80, 78, 71])
  const fetchImpl = (async () =>
    new Response(png, {headers: {'content-type': 'image/png'}})) as typeof fetch

  it('saves every image try, named by try and by what the AI check said, without overwriting', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'hero.png'), 'original')
    const result = await saveSkillRunAttempts({
      client: client(),
      run: view({
        status: 'budget_exhausted',
        steps: [
          {stepId: 's', stage: 'author', attempt: 1, status: 'succeeded', artifactId: 'a0'},
          {stepId: 's', stage: 'image', attempt: 1, status: 'succeeded', artifactId: 'a1', assetId: 'img_1'},
          {stepId: 's', stage: 'image', attempt: 2, status: 'succeeded', artifactId: 'a2', assetId: 'img_2', part: 'Red bow'},
          {stepId: 's', stage: 'image', attempt: 3, status: 'succeeded', artifactId: 'a3', assetId: 'img_3'},
        ],
        verdicts: [
          {stepId: 's', attempt: 1, pass: false, by: 'ai', reason: 'combined into one image'},
          {stepId: 's', attempt: 2, pass: true, by: 'ai', reason: null},
        ],
      }),
      skillTitle: 'Pluffy Accessory Extraction',
      outDir: dir,
      sourceFileName: 'hero.png',
      fetchImpl,
    })
    expect(result.failed).toEqual([])
    expect(result.saved).toEqual([
      {assetId: 'img_1', attempt: 1, check: 'rejected', reason: 'combined into one image', path: join(dir, 'hero.pluffy-accessory-extraction.try1-rejected.png')},
      {assetId: 'img_2', attempt: 2, check: 'passed', part: 'Red bow', path: join(dir, 'hero.pluffy-accessory-extraction.try2-red-bow-passed.png')},
      {assetId: 'img_3', attempt: 3, check: 'unchecked', path: join(dir, 'hero.pluffy-accessory-extraction.try3-unchecked.png')},
    ])
    expect(await readFile(join(dir, 'hero.png'), 'utf8')).toBe('original')
  })
})

describe('saveSkillRunAttempts: which AI check belongs to which try', () => {
  const png = new Uint8Array([137, 80, 78, 71])
  const fetchImpl = (async () =>
    new Response(png, {headers: {'content-type': 'image/png'}})) as typeof fetch

  it('reads the review verdict for its try, as runs record them (image step "isolate", verdict "review")', async () => {
    const dir = await tempDir()
    const {saved} = await saveSkillRunAttempts({
      client: client(),
      run: view({
        steps: [
          {stepId: 'isolate', stage: 'image', attempt: 1, status: 'succeeded', artifactId: 'a1', assetId: 'img_1'},
          {stepId: 'review', stage: 'review', attempt: 1, status: 'succeeded', artifactId: 'r1'},
        ],
        verdicts: [{stepId: 'review', attempt: 1, pass: false, by: 'ai', reason: 'combined into one image'}],
      }),
      skillTitle: 'X',
      outDir: dir,
      fetchImpl,
    })
    expect(saved.map(item => [item.check, item.reason])).toEqual([['rejected', 'combined into one image']])
  })

  it('does not guess when several images share a try and their checks cannot be told apart', async () => {
    const dir = await tempDir()
    const {saved} = await saveSkillRunAttempts({
      client: client(),
      run: view({
        steps: [
          {stepId: 'isolate', stage: 'image', attempt: 1, status: 'succeeded', artifactId: 'a1', assetId: 'img_1', part: 'Hat'},
          {stepId: 'isolate', stage: 'image', attempt: 1, status: 'succeeded', artifactId: 'a2', assetId: 'img_2', part: 'Bag'},
        ],
        verdicts: [
          {stepId: 'review', attempt: 1, pass: true, by: 'ai', reason: null},
          {stepId: 'review', attempt: 1, pass: false, by: 'ai', reason: 'strap cut off'},
        ],
      }),
      skillTitle: 'X',
      outDir: dir,
      fetchImpl,
    })
    expect(saved.map(item => item.check)).toEqual(['unchecked', 'unchecked'])
  })

  it('uses a verdict recorded on the image step itself when there is one', async () => {
    const dir = await tempDir()
    const {saved} = await saveSkillRunAttempts({
      client: client(),
      run: view({
        steps: [
          {stepId: 'img_a', stage: 'image', attempt: 1, status: 'succeeded', artifactId: 'a1', assetId: 'img_1'},
          {stepId: 'img_b', stage: 'image', attempt: 1, status: 'succeeded', artifactId: 'a2', assetId: 'img_2'},
        ],
        verdicts: [
          {stepId: 'img_b', attempt: 1, pass: false, by: 'ai', reason: 'b is wrong'},
          {stepId: 'img_a', attempt: 1, pass: true, by: 'ai', reason: null},
        ],
      }),
      skillTitle: 'X',
      outDir: dir,
      fetchImpl,
    })
    expect(saved.map(item => [item.assetId, item.check])).toEqual([['img_1', 'passed'], ['img_2', 'rejected']])
  })

  it('labels each part of a multi-part run from its final and its retries, as a real Pluffy run recorded them', async () => {
    const dir = await tempDir()
    const image = (part: string, attempt: number, id: string, assetId?: string) => ({
      stepId: 'isolate', stage: 'image', attempt, status: assetId ? 'succeeded' : 'pending', artifactId: id, part, ...(assetId ? {assetId} : {}),
    })
    const {saved} = await saveSkillRunAttempts({
      client: client(),
      run: view({
        status: 'budget_exhausted',
        steps: [
          image('pants', 1, 'p1', 'img_p1'), image('helmet', 1, 'h1', 'img_h1'), image('jacket', 1, 'j1', 'img_j1'),
          image('pants', 2, 'p2', 'img_p2'), image('helmet', 2, 'h2', 'img_h2'),
          image('pants', 3, 'p3'),
        ],
        // The review verdicts name no part, and come back in another order than the parts.
        verdicts: [
          {stepId: 'review', attempt: 1, pass: false, by: 'ai', reason: 'off-centre'},
          {stepId: 'review', attempt: 1, pass: true, by: 'ai', reason: null},
          {stepId: 'review', attempt: 1, pass: false, by: 'ai', reason: 'invented 2D'},
          {stepId: 'review', attempt: 2, pass: false, by: 'ai', reason: 'invented 2D again'},
          {stepId: 'review', attempt: 2, pass: true, by: 'ai', reason: null},
        ],
        parts: [
          {id: 'helmet', key: 'helmet', note: '', status: 'completed', finals: ['h2'], reason: ''},
          {id: 'jacket', key: 'jacket', note: '', status: 'completed', finals: ['j1'], reason: ''},
          {id: 'pants', key: 'pants', note: '', status: 'running', finals: [], reason: ''},
        ],
      }),
      skillTitle: 'X',
      outDir: dir,
      fetchImpl,
    })
    expect(saved.map(item => [item.part, item.attempt, item.check])).toEqual([
      ['pants', 1, 'rejected'],
      ['helmet', 1, 'rejected'],
      ['jacket', 1, 'passed'],
      ['pants', 2, 'rejected'],
      ['helmet', 2, 'passed'],
    ])
  })

  it('takes the reason from a verdict that names its part', async () => {
    const dir = await tempDir()
    const {saved} = await saveSkillRunAttempts({
      client: client(),
      run: view({
        steps: [
          {stepId: 'isolate', stage: 'image', attempt: 1, status: 'succeeded', artifactId: 'a1', assetId: 'img_1', part: 'Hat'},
          {stepId: 'isolate', stage: 'image', attempt: 1, status: 'succeeded', artifactId: 'a2', assetId: 'img_2', part: 'Bag'},
        ],
        verdicts: [
          {stepId: 'review', attempt: 1, pass: false, by: 'ai', reason: 'strap cut off', part: 'Bag'},
          {stepId: 'review', attempt: 1, pass: true, by: 'ai', reason: null, part: 'Hat'},
        ] as never,
      }),
      skillTitle: 'X',
      outDir: dir,
      fetchImpl,
    })
    expect(saved.map(item => [item.part, item.check, item.reason])).toEqual([['Hat', 'passed', undefined], ['Bag', 'rejected', 'strap cut off']])
  })
})
