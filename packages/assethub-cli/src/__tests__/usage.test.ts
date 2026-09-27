import {describe, expect, it} from 'vitest'
import {usage} from '../index.js'

describe('CLI usage / --help', () => {
  it('documents the new production run and watch commands', () => {
    expect(usage).toContain('assethub production run --order-id <id> --mission-id <id>')
    expect(usage).toContain('[--run-mode full_auto|approval]')
    expect(usage).toContain('[--max-cost-credits <n>]')
    expect(usage).toContain('assethub production watch <order-id>')
  })

  // The one-shot "image -> finished asset" flow is a different command from
  // the mission-based `production run --order-id ...` above (same verb,
  // gated on --image), so both usage lines need to keep coexisting.
  it('documents production run --image (the one-shot flow) alongside the mission-based run', () => {
    expect(usage).toContain('assethub production run --image <file|asset-id>')
    expect(usage).toContain('[--compose v6|none]')
    expect(usage).toContain('[--mesh-model <id>]')
    expect(usage).toContain('[--max-cost <credits>]')
    expect(usage).toContain('[--estimate]')
    expect(usage).toContain('production run --order-id <id> --mission-id <id>')
  })

  it('documents runs get --summary and runs wait', () => {
    expect(usage).toContain('assethub runs get|watch|wait <run-id>')
    expect(usage).toContain('[--summary]')
    expect(usage).toContain('assethub runs wait run_x')
  })

  // Both verbs are documented, not only the write. An append is one write per op
  // rather than one transaction, so a caller who cannot list the log has no way
  // to establish what a partial failure left behind.
  it('documents both intervention commands and the idempotency key', () => {
    expect(usage).toContain('assethub production intervene <order-id>')
    expect(usage).toContain('assethub production interventions <order-id>')
    expect(usage).toContain('[--idempotency-key <key>]')
    expect(usage).toContain('--ops-json <json|@file|@->')
  })

  // --dry-run is documented alongside the command rather than buried in a
  // guide: it is the only way to find out that a run folder is corrupt without
  // sending anything to production.
  it('documents runs upload with --dry-run and the resumable flags', () => {
    expect(usage).toContain('assethub runs upload <path>')
    expect(usage).toContain('[--dry-run]')
    expect(usage).toContain('[--rev <n>]')
    expect(usage).toContain('[--graph-id <id>]')
    expect(usage).toContain('assethub runs upload ./out/pluffy-run-2026-07-30 --dry-run')
  })

  it('documents the rig and animate commands', () => {
    expect(usage).toContain('assethub rig check (')
    expect(usage).toContain('assethub rig create (')
    expect(usage).toContain('[--rig-type biped|quadruped|hexapod|octopod|avian|serpentine|aquatic]')
    expect(usage).toContain('assethub animate presets')
    expect(usage).toContain('assethub animate retarget --resource-id <id> --animation <preset-id>')
    // The server caps `animations` at 5; --help says so rather than letting a
    // sixth flag come back as a 400.
    expect(usage).toContain('[--animation <preset-id>... up to 5 total]')
  })

  it('matches the committed help snapshot', () => {
    expect(usage).toMatchSnapshot()
  })
})
