import {describe, expect, it} from 'vitest'

import {productionBatchLabels} from '../productionBatch.js'

describe('productionBatchLabels', () => {
  it('names each image by its file, asset ID or URL', () => {
    expect(
      productionBatchLabels([
        {flag: 'file', value: '/art/harpy.png'},
        {flag: 'source-id', value: 'asset-1'},
        {flag: 'source-url', value: 'https://cdn.example.com/c/satyr.webp?x=1'},
      ]),
    ).toEqual(['harpy', 'asset-1', 'satyr'])
  })

  it('adds the folder when two files share a name, so names and download folders stay apart', () => {
    expect(
      productionBatchLabels([
        {flag: 'file', value: '/dl/harpy/concept.jpg'},
        {flag: 'file', value: '/dl/satyr/concept.jpg'},
        {flag: 'file', value: '/dl/knight.png'},
      ]),
    ).toEqual(['harpy-concept', 'satyr-concept', 'knight'])
  })

  it('falls back to the position when names still collide', () => {
    expect(
      productionBatchLabels([
        {flag: 'source-id', value: 'same'},
        {flag: 'source-id', value: 'same'},
      ]),
    ).toEqual(['same-1', 'same-2'])
  })
})
