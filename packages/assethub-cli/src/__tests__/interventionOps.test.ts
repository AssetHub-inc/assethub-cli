import {describe, expect, it} from 'vitest'
import {interventionOpsFromArgs} from '../index.js'

describe('interventionOpsFromArgs', () => {
  // Read off the raw argv rather than the parsed flag record: that record is
  // keyed by flag name, so it cannot say whether --exclude came before
  // --add-part. seq order in the log is the operator's own order of decisions,
  // so it has to survive parsing.
  it('builds ops in the order the flags were written', () => {
    expect(
      interventionOpsFromArgs([
        'production',
        'intervene',
        'ord',
        '--exclude',
        '7',
        '--add-part',
        'wings',
        '--exclude',
        '8',
      ]),
    ).toEqual([
      {op: 'part.exclude', targetId: '7'},
      {op: 'part.add', name: 'wings'},
      {op: 'part.exclude', targetId: '8'},
    ])
  })

  it('accepts both --flag value and --flag=value', () => {
    expect(interventionOpsFromArgs(['--include=7'])).toEqual([
      {op: 'part.include', targetId: '7'},
    ])
    expect(interventionOpsFromArgs(['--include', '7'])).toEqual([
      {op: 'part.include', targetId: '7'},
    ])
  })

  it('splits --rename on the first = so a name may contain one', () => {
    expect(interventionOpsFromArgs(['--rename', '7=a=b'])).toEqual([
      {op: 'part.rename', targetId: '7', name: 'a=b'},
    ])
  })

  it('makes the reject reason optional', () => {
    expect(interventionOpsFromArgs(['--reject', '7'])).toEqual([
      {op: 'part.reject', targetId: '7'},
    ])
    expect(interventionOpsFromArgs(['--reject', '7=blurry'])).toEqual([
      {op: 'part.reject', targetId: '7', reason: 'blurry'},
    ])
  })

  it('builds a regenerate op with its mode', () => {
    expect(interventionOpsFromArgs(['--regenerate', '7=high_quality'])).toEqual([
      {op: 'part.regenerate', targetId: '7', mode: 'high_quality'},
    ])
  })

  // One decision, one op. Splitting two parameters set in the same invocation
  // into two log rows would make the log claim the operator changed their mind.
  it('merges every --set-param into a single params.set op', () => {
    expect(
      interventionOpsFromArgs([
        '--set-param',
        'views=multiview',
        '--set-param',
        'imageModel=nb2',
      ]),
    ).toEqual([
      {op: 'params.set', patch: {views: 'multiview', imageModel: 'nb2'}},
    ])
  })

  // Emitted where the first --set-param was written, so the merge does not
  // silently move the parameter decision to the end of the batch.
  it('emits the merged params.set at the position of the first --set-param', () => {
    expect(
      interventionOpsFromArgs([
        '--set-param',
        'views=single',
        '--exclude',
        '7',
        '--set-param',
        'styleTarget=toon',
      ]),
    ).toEqual([
      {op: 'params.set', patch: {views: 'single', styleTarget: 'toon'}},
      {op: 'part.exclude', targetId: '7'},
    ])
  })

  // The CLI has no zod and must not carry a second copy of the contract's key
  // list -- an unknown key is the server's 400 to give, in the one place the
  // contract is enforced. Only the shape the CLI itself has to parse is checked
  // here.
  it('passes an unrecognised param key through for the server to reject', () => {
    expect(interventionOpsFromArgs(['--set-param', 'nonsense=1'])).toEqual([
      {op: 'params.set', patch: {nonsense: '1'}},
    ])
  })

  it('rejects a --rename without a name', () => {
    expect(() => interventionOpsFromArgs(['--rename', '7'])).toThrow(
      /--rename/,
    )
  })

  it('rejects a --set-param without a value', () => {
    expect(() => interventionOpsFromArgs(['--set-param', 'views'])).toThrow(
      /--set-param/,
    )
  })

  it('rejects a flag written with no value at all', () => {
    expect(() => interventionOpsFromArgs(['--exclude'])).toThrow(/--exclude/)
    expect(() =>
      interventionOpsFromArgs(['--exclude', '--include', '7']),
    ).toThrow(/--exclude/)
  })

  it('ignores flags that are not intervention ops', () => {
    expect(
      interventionOpsFromArgs([
        '--api-key',
        'ah_live_x',
        '--exclude',
        '7',
        '--idempotency-key',
        'batch-1',
      ]),
    ).toEqual([{op: 'part.exclude', targetId: '7'}])
  })

  it('returns nothing when no op flags are present', () => {
    expect(interventionOpsFromArgs(['production', 'intervene', 'ord'])).toEqual(
      [],
    )
  })
})
