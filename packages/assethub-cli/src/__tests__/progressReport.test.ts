import type {
  CanvasExecution,
  CharacterAssemblyProgress,
} from '@assethub/api-client'
import {describe, expect, it} from 'vitest'

import {
  batchReporter,
  failureText,
  runReporter,
  stepText,
} from '../progressReport.js'

type Part = CharacterAssemblyProgress['parts'][number]
const part = (label: string, state: Part['state'], note?: string): Part => ({
  label,
  state,
  stateText: state,
  drawingAttempts: 1,
  meshAttempts: 1,
  ...(note ? {note} : {}),
})
const progress = (
  overrides: Partial<CharacterAssemblyProgress> = {},
): CharacterAssemblyProgress => ({
  kind: 'character_assembly',
  phase: 'parts',
  step: 3,
  steps: 4,
  summary: 'Step 3 of 4 · Making the parts · 1 of 9 meshes ready',
  headline: '1 of 9 meshes ready',
  partsReady: 1,
  partsTotal: 9,
  parts: [],
  rounds: [],
  ...overrides,
})
const run = (
  status: CanvasExecution['status'],
  extra: Partial<CanvasExecution> = {},
) =>
  ({
    runId: '4e9acd99-2072-4b9e-917d-e0ff6586d27b',
    status,
    createdAt: new Date(2026, 8, 30, 19, 41).toISOString(),
    history: {status: 'recorded'},
    ...extra,
  }) as CanvasExecution

/** A clock the test moves by hand; lines carry its local HH:MM. */
const clock = () => {
  let now = new Date(2026, 8, 30, 19, 41)
  return {
    now: () => now,
    at: (hours: number, minutes: number) => {
      now = new Date(2026, 8, 30, hours, minutes)
    },
  }
}
const sink = () => {
  const lines: string[] = []
  return {
    lines,
    write: (text: string) => lines.push(...text.replace(/\n$/, '').split('\n')),
  }
}

describe('stepText', () => {
  it('shortens "Step 3 of 4" and leaves the rest of the summary', () => {
    expect(stepText(run('running', {progress: progress()}))).toBe(
      '3/4 Making the parts · 1 of 9 meshes ready',
    )
  })

  it('is the status for a run without progress', () => {
    expect(stepText(run('queued'))).toBe('queued')
  })
})

describe('failureText', () => {
  it('turns the backend list of findings into plain text', () => {
    expect(
      failureText(
        run('failed', {
          error: {
            code: 'CHARACTER_ASSEMBLY_NOT_ACCEPTED',
            message:
              "[{'code': 'planner_failed', 'path': '$', 'message': 'Planner run failed.'}]",
          },
        }),
      ),
    ).toBe('Planner run failed. (planner_failed)')
  })

  it('falls back to the outcome detail, then the history error, then the status', () => {
    expect(
      failureText(
        run('failed', {
          progress: progress({
            outcome: {
              accepted: false,
              outcome: 'stopped',
              detail: 'Blender assembly failed',
            },
          }),
        }),
      ),
    ).toBe('Blender assembly failed')
    expect(
      failureText(run('failed', {history: {status: 'failed', error: 'boom'}})),
    ).toBe('boom')
    expect(failureText(run('cancelled'))).toBe('cancelled')
  })
})

describe('runReporter', () => {
  it('prints a line only when the step, the ready count or the status changes, not when parts flicker', () => {
    const {lines, write} = sink()
    const time = clock()
    const report = runReporter({write, now: time.now})

    report(
      run('running', {progress: progress({parts: [part('Coat', 'redoing')]})}),
    )
    report(
      run('running', {progress: progress({parts: [part('Coat', 'checking')]})}),
    )
    time.at(19, 52)
    report(
      run('running', {
        progress: progress({
          summary: 'Step 3 of 4 · Making the parts · 2 of 9 meshes ready',
          partsReady: 2,
        }),
      }),
    )
    time.at(20, 30)
    report(
      run('completed', {
        progress: progress({
          phase: 'done',
          step: 4,
          summary: 'Step 4 of 4 · Accepted after 1 round',
        }),
      }),
    )

    expect(lines).toEqual([
      '19:41  run 4e9acd99  3/4 Making the parts · 1 of 9 meshes ready',
      '19:52  run 4e9acd99  3/4 Making the parts · 2 of 9 meshes ready',
      '20:30  run 4e9acd99  ✓ done · 4/4 Accepted after 1 round',
    ])
  })

  it('names a part once when it is kept with an issue or fails', () => {
    const {lines, write} = sink()
    const report = runReporter({write, now: clock().now})

    report(
      run('running', {
        progress: progress({parts: [part('Cropped top', 'redoing')]}),
      }),
    )
    const kept = progress({
      summary: 'Step 3 of 4 · Making the parts · 2 of 9 meshes ready',
      partsReady: 2,
      parts: [
        part('Cropped top', 'kept', 'open hem at the lower chest'),
        part('Tail', 'failed'),
      ],
    })
    report(run('running', {progress: kept}))
    report(run('running', {progress: kept}))

    expect(lines).toEqual([
      '19:41  run 4e9acd99  3/4 Making the parts · 1 of 9 meshes ready',
      '19:41  run 4e9acd99  3/4 Making the parts · 2 of 9 meshes ready',
      '19:41  run 4e9acd99  ⚠ kept with an issue: Cropped top · open hem at the lower chest',
      '19:41  run 4e9acd99  ✗ part needs a person: Tail',
    ])
  })

  // A stopped run reports phase `done` and step 4 whatever stopped it.
  const stopped = () =>
    run('failed', {
      progress: progress({
        phase: 'done',
        step: 4,
        summary: 'Stopped · Planner run failed.',
      }),
      error: {
        code: 'CHARACTER_ASSEMBLY_NOT_ACCEPTED',
        message:
          "[{'code': 'planner_failed', 'path': '$', 'message': 'Planner run failed.'}]",
      },
    })

  it('says why a run failed, and where when it saw the run working', () => {
    const {lines, write} = sink()
    const report = runReporter({write, now: clock().now})
    report(
      run('running', {
        progress: progress({
          phase: 'plan',
          step: 1,
          summary: 'Step 1 of 4 · Planning the parts',
        }),
      }),
    )
    report(stopped())

    const watched = sink()
    runReporter({write: watched.write, now: clock().now})(stopped())

    expect(lines).toEqual([
      '19:41  run 4e9acd99  1/4 Planning the parts',
      '19:41  run 4e9acd99  ✗ FAILED · at 1/4 Planning the parts · Planner run failed. (planner_failed)',
    ])
    expect(watched.lines).toEqual([
      '19:41  run 4e9acd99  ✗ FAILED · Planner run failed. (planner_failed)',
    ])
  })
})

describe('batchReporter', () => {
  const images = [
    {key: '0#1', imageIndex: 0, repeat: 1, name: 'image (28).png'},
    {key: '1#1', imageIndex: 1, repeat: 1, name: 'image (29).png'},
  ]
  const item = (
    key: string,
    status: string,
    execution?: CanvasExecution,
    extra: Record<string, unknown> = {},
  ) => {
    const image = images.find(entry => entry.key === key)!
    return {
      key,
      label: 'ignored',
      imageIndex: image.imageIndex,
      repeat: image.repeat,
      attempt: 0,
      status,
      ...(execution ? {execution, runId: execution.runId} : {}),
      ...extra,
    } as Parameters<ReturnType<typeof batchReporter>['item']>[0]
  }

  it('lists the images by letter and real file name, then one line per real change', () => {
    const {lines, write} = sink()
    const time = clock()
    const report = batchReporter({
      write,
      now: time.now,
      operationId: 'a491168c-84b7-405f-a1d0-ab7d6f670c95',
      agent: 'V4 Character Assembly',
      canvasId: 59025,
      concurrency: 2,
      images,
    })

    report.header()
    report.item(
      item(
        '0#1',
        'dispatched',
        run('queued', {runId: 'cb897694-81cd-4074-a0d0-e90c222a5667'}),
      ),
    )
    report.item(item('1#1', 'dispatched', run('queued')))
    report.item(
      item(
        '0#1',
        'dispatched',
        run('running', {
          runId: 'cb897694-81cd-4074-a0d0-e90c222a5667',
          progress: progress({
            phase: 'plan',
            step: 1,
            summary: 'Step 1 of 4 · Planning the parts',
          }),
        }),
      ),
    )
    time.at(19, 52)
    report.item(
      item(
        '1#1',
        'dispatched',
        run('running', {
          progress: progress({parts: [part('Coat', 'redoing')]}),
        }),
      ),
    )
    report.item(
      item(
        '1#1',
        'dispatched',
        run('running', {
          progress: progress({parts: [part('Coat', 'checking')]}),
        }),
      ),
    )
    time.at(20, 5)
    report.item(
      item(
        '0#1',
        'failed',
        run('failed', {
          runId: 'cb897694-81cd-4074-a0d0-e90c222a5667',
          progress: progress({
            phase: 'done',
            step: 4,
            summary: 'Stopped · Planner run failed.',
          }),
          error: {
            code: 'CHARACTER_ASSEMBLY_NOT_ACCEPTED',
            message:
              "[{'code': 'planner_failed', 'path': '$', 'message': 'Planner run failed.'}]",
          },
        }),
      ),
    )
    time.at(20, 15)
    report.table('still running')

    expect(lines).toEqual([
      'Batch a491168c · V4 Character Assembly · 2 runs, 2 at a time · canvas 59025',
      '  A  image (28).png',
      '  B  image (29).png',
      '  Resume with: --operation-id a491168c-84b7-405f-a1d0-ab7d6f670c95',
      '',
      '19:41  A  image (28).png  started run cb897694 · queued',
      '19:41  B  image (29).png  started run 4e9acd99 · queued',
      '19:41  A  image (28).png  1/4 Planning the parts',
      '19:52  B  image (29).png  3/4 Making the parts · 1 of 9 meshes ready',
      '20:05  A  image (28).png  ✗ FAILED · at 1/4 Planning the parts · Planner run failed. (planner_failed)',
      '',
      '── 20:15 · still running ──',
      '  A  image (28).png  ✗ failed    at 1/4 · Planner run failed. (planner_failed)  24 min',
      '  B  image (29).png  ● running   3/4 Making the parts · 1 of 9 meshes ready  34 min',
      '',
    ])
  })

  it('adds the repeat to the letter, and says why an image waits or could not start', () => {
    const {lines, write} = sink()
    const report = batchReporter({
      write,
      now: clock().now,
      operationId: 'a491168c-84b7-405f-a1d0-ab7d6f670c95',
      agent: 'v4',
      canvasId: 42,
      concurrency: 1,
      images: [
        {key: '0#1', imageIndex: 0, repeat: 1, name: 'harpy.png'},
        {key: '0#2', imageIndex: 0, repeat: 2, name: 'harpy.png'},
      ],
    })
    const base = {label: 'harpy', imageIndex: 0, attempt: 0}
    report.item({
      ...base,
      key: '0#2',
      repeat: 2,
      status: 'deferred',
      message: 'Your plan allows up to 1 active agent run.',
    })
    report.item({
      ...base,
      key: '0#2',
      repeat: 2,
      status: 'deferred',
      message: 'Your plan allows up to 1 active agent run.',
    })
    report.item({
      ...base,
      key: '0#1',
      repeat: 1,
      status: 'failed',
      code: 'INSUFFICIENT_CREDITS',
      message: 'Not enough credits',
    })
    report.table('done')

    expect(lines).toEqual([
      '19:41  A#2  harpy.png  waiting for a free run slot · Your plan allows up to 1 active agent run.',
      '19:41  A#1  harpy.png  ✗ could not start · Not enough credits (INSUFFICIENT_CREDITS)',
      '',
      '── 19:41 · done ──',
      '  A#1  harpy.png  ✗ failed    Not enough credits (INSUFFICIENT_CREDITS)',
      '  A#2  harpy.png  … waiting   Your plan allows up to 1 active agent run.',
      '',
    ])
  })
})
