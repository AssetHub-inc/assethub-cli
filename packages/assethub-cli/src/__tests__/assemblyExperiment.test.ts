import {describe, expect, it} from 'vitest'

import {buildAssemblyExperiment} from '../assemblyExperiment.js'

describe('buildAssemblyExperiment', () => {
  it('returns undefined when neither input is given', () => {
    expect(buildAssemblyExperiment({})).toBeUndefined()
  })

  it('passes a valid --assembly-experiment object through unchanged', () => {
    const json = {garmentFit: {wearGraph: true}, models: {planner: 'a/b'}}
    expect(buildAssemblyExperiment({json})).toEqual(json)
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
})
