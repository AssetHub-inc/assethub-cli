import {describe, expect, it, vi} from 'vitest'
import {AssetHubApiError} from '@assethub/api-client'
import {describeError, isFeatureNotAvailableError, trustSystemCertificates} from '../networkErrors.js'
import {MeshReviewSyncError} from '../meshReview/syncMeshReview.js'
import {explainMeshReviewError} from '../meshReview/errors.js'

describe('describeError', () => {
  it('appends the cause that fetch hides behind "fetch failed"', () => {
    const cause = Object.assign(new Error('invalid Authorization header'), {code: 'UND_ERR_INVALID_ARG'})
    expect(describeError(new TypeError('fetch failed', {cause}))).toBe(
      'fetch failed: invalid Authorization header (UND_ERR_INVALID_ARG)',
    )
  })

  it('reports a certificate code that has no message of its own', () => {
    const cause = Object.assign(new Error(''), {code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'})
    expect(describeError(new TypeError('fetch failed', {cause}))).toBe('fetch failed: UNABLE_TO_VERIFY_LEAF_SIGNATURE')
  })

  it('leaves an error without a cause unchanged', () => {
    expect(describeError(new Error('No workspace selected.'))).toBe('No workspace selected.')
    expect(describeError('plain')).toBe('plain')
  })
})

describe('trustSystemCertificates', () => {
  it('adds the operating system store to the certificates Node already trusts', () => {
    const setDefaultCACertificates = vi.fn()
    const tls = {
      getCACertificates: (type: string) => (type === 'default' ? ['bundled', 'shared'] : ['shared', 'corporate-root']),
      setDefaultCACertificates,
    }
    expect(trustSystemCertificates(tls)).toBe(true)
    expect(setDefaultCACertificates).toHaveBeenCalledWith(['bundled', 'shared', 'corporate-root'])
  })

  it('does nothing on a Node without the API', () => {
    expect(trustSystemCertificates({})).toBe(false)
  })

  it('never throws when the system store cannot be read', () => {
    const tls = {
      getCACertificates: () => {
        throw new Error('store unavailable')
      },
      setDefaultCACertificates: vi.fn(),
    }
    expect(trustSystemCertificates(tls)).toBe(false)
    expect(tls.setDefaultCACertificates).not.toHaveBeenCalled()
  })
})

describe('isFeatureNotAvailableError', () => {
  const unknownEndpoint = 'No such endpoint. See https://app.assethub.io/api/v2/openapi.json for the available operations.'
  const apiError = (status: number, code: string, message: string) =>
    new AssetHubApiError({status, code, message, payload: {}})

  it('recognises the 404 an internal-only route gives a key without access', () => {
    expect(isFeatureNotAvailableError(apiError(404, 'NOT_FOUND', unknownEndpoint))).toBe(true)
    expect(isFeatureNotAvailableError(new MeshReviewSyncError('NOT_FOUND', `${unknownEndpoint} (NOT_FOUND).`, {status: 404}))).toBe(true)
  })

  it('leaves other not-found answers alone', () => {
    expect(isFeatureNotAvailableError(apiError(404, 'NOT_FOUND', 'Run not found'))).toBe(false)
    expect(isFeatureNotAvailableError(apiError(404, 'SKILL_NOT_FOUND', unknownEndpoint))).toBe(false)
    expect(isFeatureNotAvailableError(apiError(500, 'NOT_FOUND', unknownEndpoint))).toBe(false)
    expect(isFeatureNotAvailableError(new Error(unknownEndpoint))).toBe(false)
  })

  it('words a mesh-review denial as not yet available', () => {
    const error = new MeshReviewSyncError('NOT_FOUND', `${unknownEndpoint} (NOT_FOUND).`, {status: 404})
    expect(explainMeshReviewError(error, {profile: 'default'})).toBe('This feature is not yet available for this account.')
  })
})
