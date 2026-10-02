import {describe, expect, it, vi} from 'vitest'
import {describeError, trustSystemCertificates} from '../networkErrors.js'

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
