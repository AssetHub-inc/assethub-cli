import {describe, expect, it} from 'vitest'
import type {WorkspaceSkillRun} from '@assethub/api-client'
import {describeSkillRunProgress, isSkillRunSettled} from '../skillRun.js'

const runId = '33333333-3333-4333-8333-333333333333'

const goal = (
  over: Partial<NonNullable<WorkspaceSkillRun['goal']>> = {},
  base: Partial<WorkspaceSkillRun> = {},
): WorkspaceSkillRun => ({
  runId,
  skillId: 'drecom-weapon-concept-to-3d',
  status: 'running',
  budget: {credits: 600, spentCredits: 228, remainingCredits: 372},
  steps: [],
  verdicts: [],
  outputs: [],
  outcome: null,
  parts: [],
  kind: 'goal',
  goal: {
    result: 'running',
    now: 'Redrawing the gem picture',
    question: null,
    checks: [
      {
        acceptanceId: 'ac_views',
        text: '**Views**: orthographic',
        required: true,
        verdict: 'passed',
        judgedBy: 'vlm_3x',
        tries: 1,
        note: 'matches',
      },
      {
        acceptanceId: 'ac_front',
        text: '**Front silhouette**: matches',
        required: true,
        verdict: 'not_checked',
        judgedBy: null,
        tries: 0,
        note: null,
      },
    ],
    counts: {passed: 1, failed: 0, notChecked: 1},
    drafts: [],
    reason: null,
    ...over,
  },
  ...base,
})

describe('goal run progress in the CLI', () => {
  it('says what the agent does now and each newly judged check', () => {
    const before = goal({
      now: 'Drawing the views',
      checks: [
        {
          acceptanceId: 'ac_views',
          text: '**Views**: orthographic',
          required: true,
          verdict: 'not_checked',
          judgedBy: null,
          tries: 0,
          note: null,
        },
        {
          acceptanceId: 'ac_front',
          text: '**Front silhouette**: matches',
          required: true,
          verdict: 'not_checked',
          judgedBy: null,
          tries: 0,
          note: null,
        },
      ],
    })
    expect(describeSkillRunProgress(before, goal())).toEqual([
      'Now: Redrawing the gem picture',
      'Check "Views" passed (try 1): matches',
    ])
  })

  it('a question stops the wait and names the command to answer it', () => {
    const asked = goal(
      {
        result: 'waiting',
        question: {
          question: 'The sheet has no side view.',
          options: ['Add a side view', 'Continue without it'],
        },
      },
      {status: 'running'},
    )
    expect(describeSkillRunProgress(goal(), asked)).toContain(
      `Needs your answer: The sheet has no side view. Answer with: assethub skills run-answer drecom-weapon-concept-to-3d ${runId} --answer 'Add a side view' (or 'Continue without it')`,
    )
    expect(isSkillRunSettled(asked)).toBe(true)
  })

  it('a finished goal run reports passed, failed and not checked, and needs review honestly', () => {
    const done = goal(
      {result: 'needs_review', counts: {passed: 9, failed: 0, notChecked: 4}},
      {status: 'completed'},
    )
    expect(describeSkillRunProgress(goal(), done)).toContain(
      'Needs review: 9 passed, 0 failed, 4 not checked. Not checked is not passed; look over the model.',
    )
  })
})
