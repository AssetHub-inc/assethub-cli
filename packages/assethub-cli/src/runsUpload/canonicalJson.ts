// Vendored from assethub-ml
// research/artifact-graph/artifact-graph-js/src/graph/commit-reducer.js
// (canonicalJson and its private helpers ONLY), via the identical vendoring in
// apps/frontend/src/feature/artifactGraph/export/canonicalJson.ts.
//
// These produce byte-identical output to the artifact-graph Python library's
// `json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`
// — which is what the registry recomputes a pushed snapshot's graphHash with.
// Any drift here makes every push fail validation with an opaque 400, so do NOT
// edit without re-running the golden vector in
// src/__tests__/runsUploadPlan.test.ts.
//
// One deliberate divergence from the web copy: `sha256Hex` delegates to
// node:crypto instead of carrying a hand-rolled SHA-256. The web copy runs in
// the browser/edge bundle and cannot; the CLI is Node-only, and the digest of
// the same bytes is the same digest.

import {createHash} from 'node:crypto'

export const canonicalJson = (value: unknown): string => {
  const out: string[] = []
  writeCanonicalJson(value, out)
  return out.join('')
}

// Sorted-key JSON with numbers rendered exactly as Python's json.dumps renders
// the reducer's coerced values, so both runtimes produce byte-identical
// canonical strings (and therefore graph hashes) for the same graph.
const writeCanonicalJson = (value: unknown, out: string[]): void => {
  if (value === null || value === undefined) {
    out.push('null')
    return
  }
  const type = typeof value
  if (type === 'string') {
    out.push(JSON.stringify(value))
    return
  }
  if (type === 'boolean') {
    out.push(value ? 'true' : 'false')
    return
  }
  if (type === 'number') {
    out.push(canonicalNumber(value as number))
    return
  }
  if (Array.isArray(value)) {
    out.push('[')
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) out.push(',')
      writeCanonicalJson(value[index] === undefined ? null : value[index], out)
    }
    out.push(']')
    return
  }
  if (isPlainObject(value)) {
    out.push('{')
    let first = true
    for (const key of Object.keys(value).sort()) {
      const entry = value[key]
      if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') continue
      if (!first) out.push(',')
      first = false
      out.push(JSON.stringify(key), ':')
      writeCanonicalJson(entry, out)
    }
    out.push('}')
    return
  }
  out.push(JSON.stringify(value) ?? 'null')
}

const canonicalNumber = (value: number): string => {
  if (!Number.isFinite(value)) return 'null'
  // Integral doubles below 2^53 print as plain digits, matching the Python
  // reducer, which coerces exactly that range to int at ingestion. Above
  // 2^53 exact-integer digits and shortest-digit rendering diverge, so those
  // take the float path on both sides.
  if (Number.isInteger(value) && Math.abs(value) < 9007199254740992) return String(value)
  return pythonFloatRepr(value)
}

// CPython float repr for a finite double: shortest round-trip digits, fixed
// notation while -4 < decpt <= 16 (with a trailing ".0" for integral values),
// otherwise scientific with a signed, zero-padded-to-two-digits exponent
// (1e-05, 1.5e+22). The shortest-digit sequence itself is identical in both
// runtimes; only the placement rules differ from ECMAScript's String(x).
const pythonFloatRepr = (value: number): string => {
  const exponential = value.toExponential()
  const [mantissa, exponentRaw] = exponential.split('e')
  const sign = mantissa.startsWith('-') ? '-' : ''
  const digits = mantissa.replace('-', '').replace('.', '')
  const decpt = Number(exponentRaw) + 1
  if (decpt > -4 && decpt <= 16) {
    if (decpt <= 0) return `${sign}0.${'0'.repeat(-decpt)}${digits}`
    if (decpt >= digits.length) return `${sign}${digits}${'0'.repeat(decpt - digits.length)}.0`
    return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`
  }
  const exponent = decpt - 1
  const exponentDigits = String(Math.abs(exponent)).padStart(2, '0')
  const fraction = digits.length > 1 ? `.${digits.slice(1)}` : ''
  return `${sign}${digits[0]}${fraction}e${exponent < 0 ? '-' : '+'}${exponentDigits}`
}

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export const sha256Hex = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex')

export const utf8ByteLength = (input: string): number => Buffer.byteLength(input, 'utf8')
