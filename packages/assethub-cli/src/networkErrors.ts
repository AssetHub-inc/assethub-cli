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
