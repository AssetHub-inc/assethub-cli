type CertificateApi = {
  getCACertificates?: (type: 'default' | 'system') => string[]
  setDefaultCACertificates?: (certificates: string[]) => void
}

/**
 * Trust the operating system's certificate store as well as Node's bundled one.
 * Antivirus HTTPS scanning and company proxies re-sign traffic with a root that
 * only the OS trusts; without this every request fails with
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE. Needs Node 22.19 or 24.5; older versions keep
 * the default behavior. Never throws: a missing store must not stop a command.
 */
export const trustSystemCertificates = (tls: CertificateApi): boolean => {
  if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') return false
  try {
    const certificates = [...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])]
    tls.setDefaultCACertificates(certificates)
    return true
  } catch {
    return false
  }
}

/** The message plus the cause fetch hides behind its generic "fetch failed". */
export const describeError = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error)
  const cause: unknown = error.cause
  if (!(cause instanceof Error)) return error.message
  const code = (cause as {code?: unknown}).code
  const detail = cause.message && typeof code === 'string' ? `${cause.message} (${code})` : cause.message || code
  return typeof detail === 'string' && detail ? `${error.message}: ${detail}` : error.message
}

/**
 * The server answers an internal-only route with the same 404 as a path it does
 * not have, so a key without access cannot tell the two apart. Every route the
 * CLI calls exists, so that answer means the feature is not open to this key.
 */
export const FEATURE_NOT_AVAILABLE_MESSAGE = 'This feature is not yet available for this account.'

export const isFeatureNotAvailableError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  const {status, code} = error as {status?: unknown; code?: unknown}
  return (status === undefined || status === 404) && code === 'NOT_FOUND' && error.message.startsWith('No such endpoint')
}
