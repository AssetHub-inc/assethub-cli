// Secret redaction for saved agent transcripts.
//
// Applied to raw JSONL text line by line. Every replacement is the literal
// `[REDACTED]`, and every matcher stops at quotes, backslashes and whitespace,
// so redacting a JSON line never breaks its JSON.

export const REDACTED = '[REDACTED]'

// Token bodies never contain quotes/backslashes/whitespace, so a JSON string
// boundary always ends a match.
const TOKEN = String.raw`[A-Za-z0-9._~+/=-]`

const WHOLE_MATCH_PATTERNS: RegExp[] = [
  // AssetHub keys: ah_live_..., ah_test_..., ah_pat_...
  new RegExp(String.raw`\bah_(?:live|test|pat)_[A-Za-z0-9_-]{6,}`, 'g'),
  // Anthropic before the generic sk- rule.
  new RegExp(String.raw`\bsk-ant-[A-Za-z0-9_-]{8,}`, 'g'),
  // OpenAI (sk-..., sk-proj-...).
  new RegExp(String.raw`\bsk-[A-Za-z0-9_-]{16,}`, 'g'),
  // Stripe secret/restricted/publishable keys and webhook secrets (sk_live_, rk_test_, whsec_...).
  new RegExp(String.raw`\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}`, 'g'),
  new RegExp(String.raw`\bwhsec_[A-Za-z0-9]{16,}`, 'g'),
  // Supabase secret keys.
  new RegExp(String.raw`\bsb_secret_[A-Za-z0-9_-]{16,}`, 'g'),
  // AssetHub legacy / ElevenLabs style sk_<hex or alnum>.
  new RegExp(String.raw`\bsk_[A-Za-z0-9]{16,}`, 'g'),
  // JWTs, including Supabase anon/service-role keys.
  new RegExp(String.raw`\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`, 'g'),
  // Slack tokens.
  new RegExp(String.raw`\bxox[abposr]-[A-Za-z0-9-]{10,}`, 'g'),
  // Google API keys.
  new RegExp(String.raw`\bAIza[0-9A-Za-z_-]{30,}`, 'g'),
  // AWS access key ids.
  new RegExp(String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`, 'g'),
  // GitHub tokens.
  new RegExp(String.raw`\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}`, 'g'),
  // Bearer tokens, anywhere.
  new RegExp(String.raw`\bBearer\s+${TOKEN}{8,}`, 'gi'),
]

// PEM private keys. In JSONL the newlines are escaped (`\n`), so the block is one line.
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g

// Credentials inside a URL: scheme://user:password@host keeps the user and host.
const URL_CREDENTIALS_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@"'\\]+:)[^\s@/"'\\]+@/gi

// `Authorization: <scheme> <value>` / `"Authorization": "..."` / xi-api-key.
const HEADER_PATTERN = new RegExp(
  String.raw`((?:authorization|x-api-key|xi-api-key)\\?["']?\s*[:=]\s*\\?["']?)(?:(?:Bearer|Basic|Token)\s+)?[^\s"'\\,;]+`,
  'gi',
)

// NAME=value where NAME looks like a secret variable (ASSETHUB_API_KEY, AWS_SECRET_ACCESS_KEY, ...).
const ASSIGNMENT_PATTERN = new RegExp(
  String.raw`\b([A-Za-z0-9_]*(?:API_KEY|APIKEY|SECRET|_KEY|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|DSN|DATABASE_URL)[A-Za-z0-9_]*)(\s*=\s*)(?:\\?["'])?[^\s"'\\]+`,
  'gi',
)

// A JSON key that names a secret: password, secret, api_key/apiKey, token,
// clientSecret, service_role_key, AWS_SECRET_ACCESS_KEY, ... ("input_tokens" does not match).
const SECRET_KEY = String.raw`[A-Za-z0-9_-]*(?:api[_-]?key|secret|token|password|passwd|[_-]key|credentials?)`

// "key": "value" at the top level of a JSON line. The value may contain
// escapes; only the string contents are replaced, so the JSON stays valid.
const JSON_FIELD_PATTERN = new RegExp(
  String.raw`("${SECRET_KEY}"\s*:\s*")((?:[^"\\]|\\.)*)(")`,
  'gi',
)

// The same field inside a JSON string that itself holds JSON (tool inputs are
// often serialised twice): \"key\": \"value\".
const ESCAPED_JSON_FIELD_PATTERN = new RegExp(
  String.raw`(\\"${SECRET_KEY}\\"\s*:\s*\\")((?:[^"\\]|\\\\|\\[^"\\])*)(\\")`,
  'gi',
)

export const redactText = (text: string): string => {
  let out = text
  out = out.replace(PRIVATE_KEY_PATTERN, REDACTED)
  out = out.replace(URL_CREDENTIALS_PATTERN, (_m, prefix: string) => `${prefix}${REDACTED}@`)
  out = out.replace(ESCAPED_JSON_FIELD_PATTERN, (_m, open: string, _v: string, close: string) => `${open}${REDACTED}${close}`)
  out = out.replace(JSON_FIELD_PATTERN, (_m, open: string, _v: string, close: string) => `${open}${REDACTED}${close}`)
  out = out.replace(HEADER_PATTERN, (_m, prefix: string) => `${prefix}${REDACTED}`)
  out = out.replace(ASSIGNMENT_PATTERN, (_m, name: string, eq: string) => `${name}${eq}${REDACTED}`)
  for (const pattern of WHOLE_MATCH_PATTERNS) out = out.replace(pattern, REDACTED)
  return out
}

/** Redact a whole JSONL document, one line at a time. */
export const redactJsonl = (raw: string): string => raw.split('\n').map(redactText).join('\n')
