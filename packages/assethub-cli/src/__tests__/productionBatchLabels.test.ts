import {describe, expect, it} from 'vitest'

import {productionBatchImageName, productionBatchLabels} from '../productionBatch.js'

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

describe('source URLs without a file name', () => {
  // A signed URL can carry its credentials in the query string; a URL with no
  // file name must not fall back to printing or filing it whole.
  const signed = 'https://cdn.example.test/?X-Amz-Signature=secret-sig&X-Amz-Credential=secret-cred'

  it('names the image by its host, never by the query string', () => {
    const name = productionBatchImageName({flag: 'source-url', value: signed})
    expect(name).toBe('cdn.example.test')
    expect(name).not.toContain('secret')
  })

  it('labels the download folder by its host, never by the query string', () => {
    const [label] = productionBatchLabels([{flag: 'source-url', value: signed}])
    expect(label).toBe('cdn.example.test')
    expect(label).not.toContain('secret')
  })

  it('still uses the file name when the URL has one', () => {
    const value = 'https://cdn.example.test/heroes/knight.png?X-Amz-Signature=secret-sig'
    expect(productionBatchImageName({flag: 'source-url', value})).toBe('knight.png')
    expect(productionBatchLabels([{flag: 'source-url', value}])).toEqual(['knight'])
  })
})
