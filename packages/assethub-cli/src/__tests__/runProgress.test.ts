import type {CanvasExecution} from '@assethub/api-client'
import {describe, expect, it} from 'vitest'

import {runProgressLine} from '../runProgress.js'

const execution = (progress?: CanvasExecution['progress']) =>
  ({runId: 'run-1', status: 'running', progress}) as CanvasExecution

describe('runProgressLine', () => {
  it('is the status for a run without progress', () => {
    expect(runProgressLine(execution())).toBe('running')
  })

  it('adds how many parts are busy, by state, to the summary', () => {
    expect(
      runProgressLine(
        execution({
          kind: 'character_assembly',
          phase: 'parts',
          step: 3,
          steps: 4,
          summary: 'Step 3 of 4 · Making the parts · 1 of 3 meshes ready',
          headline: '1 of 3 meshes ready',
          partsReady: 1,
          partsTotal: 3,
          parts: [
            {
              label: 'Body',
              state: 'ready',
              stateText: 'Ready',
              drawingAttempts: 1,
              meshAttempts: 1,
            },
            {
              label: 'Coat',
              state: 'redoing',
              stateText: 'Redoing',
              drawingAttempts: 2,
              meshAttempts: 0,
            },
            {
              label: 'Hat',
              state: 'kept',
              stateText: 'Kept · issue',
              drawingAttempts: 1,
              meshAttempts: 1,
            },
            {
              label: 'Belt',
              state: 'waiting',
              stateText: 'Waiting',
              drawingAttempts: 0,
              meshAttempts: 0,
            },
          ],
          rounds: [],
        }),
      ),
    ).toBe(
      'Step 3 of 4 · Making the parts · 1 of 3 meshes ready · 1 redoing, 1 kept · issue',
    )
  })
})
