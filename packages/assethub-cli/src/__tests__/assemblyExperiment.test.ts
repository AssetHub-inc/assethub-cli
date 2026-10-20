import {describe, expect, it} from 'vitest'

import {buildAssemblyExperiment} from '../assemblyExperiment.js'

describe('buildAssemblyExperiment', () => {
  // @testdoc CLI JSON forwards the V5 prepass boolean exactly; omission never opts in.
  it.each([true, false])('preserves headBodyFirst=%s', headBodyFirst => {
    expect(buildAssemblyExperiment({json: {headBodyFirst}})).toEqual({
      headBodyFirst,
    })
    expect(() =>
      buildAssemblyExperiment({json: {headBodyFirst: 'true'}}),
    ).toThrow(/headBodyFirst/)
  })
  // @testdoc The V5.3 best-of-both keys pass through; unknown image models and non-boolean switches fail before a paid request.
  it('accepts the best-of-both keys and rejects bad values', () => {
    const json = {
      v5Assembler: true,
      maskedBaseBody: true,
      partImageModel: 'openai/gpt-image-2.5-sunburst',
      shellConform: true,
      v5Start: 'fit',
      garmentFit: {penetrationRepair: true, depthGate: true},
      wholeGuide: {enabled: true},
    }
    expect(buildAssemblyExperiment({json})).toEqual(json)
    expect(() => buildAssemblyExperiment({json: {partImageModel: 'foo/bar'}})).toThrow(/partImageModel/)
    expect(() => buildAssemblyExperiment({json: {shellConform: 'yes'}})).toThrow(/shellConform/)
    expect(() => buildAssemblyExperiment({json: {maskedBaseBody: false}})).toThrow(/maskedBaseBody/)
  })
  // @testdoc Explicit Pro pins retain their provider model before a paid request.
  it.each(['google/gemini-3-pro-image'])(
    'preserves the explicitly selected image model %s', partImageModel => {
      const input = {partImageModel, shellConform: true}
      expect(buildAssemblyExperiment({json: input})).toEqual({
        partImageModel, shellConform: true,
      })
      expect(input.partImageModel).toBe(partImageModel)
    },
  )
  it('returns undefined when neither input is given', () => {
    expect(buildAssemblyExperiment({})).toBeUndefined()
  })

  it('passes a valid --assembly-experiment object through unchanged', () => {
    const json = {garmentFit: {wearGraph: true}, models: {planner: 'a/b'}}
    expect(buildAssemblyExperiment({json})).toEqual(json)
  })

  // @testdoc Explicit Pro pins remain unchanged before a remote request; unknown models fail locally.
  it.each(['google/gemini-3-pro-image'])('preserves explicit %s', partImageModel => {
    const json = {partImageModel, v5Assembler: true}
    expect(buildAssemblyExperiment({json})).toEqual({partImageModel, v5Assembler: true})
    expect(json.partImageModel).toBe(partImageModel)
  })

  // @testdoc Supported existing pins survive validation; unknown providers fail locally before paid dispatch.
  it.each(['google/gemini-3.1-flash-image', 'openai/gpt-image-2.5-sunburst'])('preserves supported %s', partImageModel => {
    expect(buildAssemblyExperiment({json: {partImageModel}})).toEqual({partImageModel})
  })
  it.each(['unpriced/model', '', 42])('rejects unsupported partImageModel %s', partImageModel => {
    expect(() => buildAssemblyExperiment({json: {partImageModel}})).toThrow('partImageModel must be one of')
  })

  it('accepts depthGate in JSON and in the --garment-fit csv', () => {
    expect(buildAssemblyExperiment({json: {garmentFit: {depthGate: true}}})).toEqual({
      garmentFit: {depthGate: true},
    })
    expect(buildAssemblyExperiment({garmentFit: 'depthGate'})).toEqual({
      garmentFit: {depthGate: true},
    })
  })

  // @testdoc Part-count flag and JSON preserve V5 switches, and agreeing values can be combined.
  it.each(['few', 'default', 'detailed'])('accepts partCount %s from flag and JSON', partCount => {
    const json = {v5Assembler: true, v5Start: 'placement', partCount}
    expect(buildAssemblyExperiment({json})).toEqual(json)
    expect(buildAssemblyExperiment({json, partCount})).toEqual(json)
    expect(buildAssemblyExperiment({partCount})).toEqual({partCount})
  })

  // @testdoc Invalid or conflicting part counts are refused before the CLI starts a paid request.
  it.each([
    {partCount: 'lots'},
    {json: {partCount: 3}},
    {json: {partCount: 'lots'}},
    {json: {partCount: 'default'}, partCount: 'few'},
  ])('rejects bad part-count input %j', input => {
    expect(() => buildAssemblyExperiment(input)).toThrow(/partCount|part-count/)
  })

  it('rejects an unknown teleport flag', () => {
    expect(() => buildAssemblyExperiment({garmentFit: 'teleport'})).toThrow(/teleport/)
  })

  it('builds garmentFit from the --garment-fit csv sugar', () => {
    expect(buildAssemblyExperiment({garmentFit: 'wearGraph, armatureFit'})).toEqual({
      garmentFit: {wearGraph: true, armatureFit: true},
    })
  })

  it.each(['placement', 'fit'])('passes v5Start %s through', v5Start => {
    const json = {v5Assembler: true, v5Start}
    expect(buildAssemblyExperiment({json})).toEqual(json)
  })

  it('merges the sugar into the JSON, with the sugar winning on a conflict', () => {
    expect(
      buildAssemblyExperiment({
        json: {garmentFit: {wearGraph: false, protectDetail: true}, models: {review: 'x/y'}},
        garmentFit: 'wearGraph,measuredGates',
      }),
    ).toEqual({
      garmentFit: {wearGraph: true, protectDetail: true, measuredGates: true},
      models: {review: 'x/y'},
    })
  })

  it.each([
    ['unknown top-level key', {json: {extra: 1}}, /extra/],
    ['unknown flag in JSON', {json: {garmentFit: {nope: true}}}, /nope/],
    ['non-boolean flag', {json: {garmentFit: {wearGraph: 'yes'}}}, /wearGraph/],
    ['unknown model role', {json: {models: {judge: 'x'}}}, /judge/],
    ['empty model id', {json: {models: {planner: ''}}}, /planner/],
    ['unknown v5Start value', {json: {v5Start: 'both'}}, /v5Start/],
    ['non-boolean v5Assembler', {json: {v5Assembler: 'yes'}}, /v5Assembler/],
    ['unknown --garment-fit name', {garmentFit: 'wearGraph,bogus'}, /bogus/],
    ['empty --garment-fit', {garmentFit: ' , '}, /garment-fit/],
  ])('rejects %s', (_name, input, message) => {
    expect(() => buildAssemblyExperiment(input as never)).toThrow(message)
  })

  // @testdoc --whole-guide opts V5.3/V5 into the whole-guide correction; the guide mesh needs the flag.
  it('builds wholeGuide from the flag and optional mesh id', () => {
    expect(buildAssemblyExperiment({wholeGuide: true})).toEqual({
      wholeGuide: {enabled: true},
    })
    expect(
      buildAssemblyExperiment({wholeGuide: true, wholeGuideMesh: 'mesh_42'}),
    ).toEqual({wholeGuide: {enabled: true, guideMeshAssetId: 'mesh_42'}})
    expect(
      buildAssemblyExperiment({json: {wholeGuide: {enabled: true}}}),
    ).toEqual({wholeGuide: {enabled: true}})
    expect(() => buildAssemblyExperiment({wholeGuideMesh: 'mesh_42'})).toThrow(
      /--whole-guide-mesh requires --whole-guide/,
    )
    expect(() =>
      buildAssemblyExperiment({wholeGuide: true, wholeGuideMesh: 'abc'}),
    ).toThrow(/mesh_<id>/)
    expect(() =>
      buildAssemblyExperiment({json: {wholeGuide: {enabled: false}}}),
    ).toThrow(/wholeGuide/)
  })
})

// @testdoc Existing V5.3 containment booleans remain explicit and fail locally for non-booleans.
it.each(['pipelineHarness', 'headBodyFirst'])('preserves %s containment controls', key => {
  for (const value of [false, true]) expect(buildAssemblyExperiment({json: {[key]: value}})).toEqual({[key]: value})
  expect(() => buildAssemblyExperiment({json: {[key]: 'true'}})).toThrow()
})
