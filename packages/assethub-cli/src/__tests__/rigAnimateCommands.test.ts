import {describe, expect, it} from 'vitest'

import {
  buildAnimationRetargetRequest,
  buildRigCreateOptions,
} from '../index.js'

/**
 * The flag-shaped halves of `rig create` and `animate retarget`.
 *
 * Both were previously assembled inline with `as` casts, so a typo in
 * `--rig-type` reached the server and came back as an opaque 400, and the
 * five-animation cap was discoverable only by exceeding it. These pin the
 * local validation that replaced the casts.
 */

type Flags = Record<string, string | boolean | string[]>

const rigFlags = (flags: Flags = {}) => buildRigCreateOptions(flags)
const retargetFlags = (flags: Flags = {}) =>
  buildAnimationRetargetRequest({'resource-id': 'rig_x', ...flags})

describe('buildRigCreateOptions', () => {
  it('passes every recognised value through', () => {
    expect(
      rigFlags({
        model: 'v2.5-20260210',
        'rig-type': 'quadruped',
        spec: 'mixamo',
        'out-format': 'fbx',
        name: 'Wolf rig',
      }),
    ).toEqual({
      model: 'v2.5-20260210',
      rigType: 'quadruped',
      spec: 'mixamo',
      outFormat: 'fbx',
      name: 'Wolf rig',
    })
  })

  it('leaves every optional flag undefined when none are supplied', () => {
    expect(rigFlags()).toEqual({
      model: undefined,
      rigType: undefined,
      spec: undefined,
      outFormat: undefined,
      name: undefined,
    })
  })

  it.each([
    ['rig-type', 'bipd', /--rig-type must be one of: biped, quadruped/],
    ['model', 'v3.0', /--model must be one of: v1\.0-20240301, v2\.5-20260210/],
    ['spec', 'unreal', /--spec must be one of: tripo, mixamo/],
    ['out-format', 'obj', /--out-format must be one of: glb, fbx/],
  ])('rejects an unrecognised --%s locally, naming the valid values', (
    flag,
    value,
    expected,
  ) => {
    expect(() => rigFlags({[flag]: value})).toThrow(expected)
  })

  // A bare `--rig-type` parses to boolean true, which must not slip through as
  // the string "true" and reach the server as a rig type.
  it('rejects a valueless enum flag', () => {
    expect(() => rigFlags({'rig-type': true})).toThrow(/--rig-type must be one of/)
  })
})

describe('buildAnimationRetargetRequest', () => {
  it('sends a single preset as `animation`, not a one-element array', () => {
    const request = retargetFlags({animation: 'preset:idle'})
    expect(request).toMatchObject({resourceId: 'rig_x', animation: 'preset:idle'})
    expect(request).not.toHaveProperty('animations')
  })

  it('sends several presets as `animations`', () => {
    const request = retargetFlags({animation: ['preset:idle', 'preset:walk']})
    expect(request).toMatchObject({animations: ['preset:idle', 'preset:walk']})
    expect(request).not.toHaveProperty('animation')
  })

  it('carries the optional knobs through', () => {
    expect(
      retargetFlags({
        animation: 'preset:idle',
        'out-format': 'fbx',
        'bake-animation': 'true',
        'export-with-geometry': 'false',
        'animate-in-place': 'true',
        name: 'Idle take',
      }),
    ).toMatchObject({
      outFormat: 'fbx',
      bakeAnimation: true,
      exportWithGeometry: false,
      animateInPlace: true,
      name: 'Idle take',
    })
  })

  it('requires at least one --animation', () => {
    expect(() => retargetFlags()).toThrow(/Missing required flag: --animation/)
  })

  it('requires --resource-id', () => {
    expect(() =>
      buildAnimationRetargetRequest({animation: 'preset:idle'}),
    ).toThrow(/Missing required flag: --resource-id/)
  })

  // The server caps `animations` at 5. Rejecting the sixth here means the
  // limit is visible before a request is built rather than as a 400 after.
  it('accepts five presets and rejects a sixth', () => {
    const five = ['a', 'b', 'c', 'd', 'e']
    expect(retargetFlags({animation: five})).toMatchObject({animations: five})
    expect(() => retargetFlags({animation: [...five, 'f']})).toThrow(
      /--animation accepts at most 5 values, got 6/,
    )
  })

  it('validates --out-format the same way rig create does', () => {
    expect(() =>
      retargetFlags({animation: 'preset:idle', 'out-format': 'obj'}),
    ).toThrow(/--out-format must be one of: glb, fbx/)
  })
})
