// Keep only the conversation from a Claude Code transcript before it is saved
// or uploaded: the artist's prompts, the agent's replies, its tool calls and
// their results, and compaction summaries. Everything else Claude Code writes
// to the file (skill, tool and agent listings, the system prompt, hook
// context, the environment, the signed-in email, file-history snapshots) is
// dropped. So is per-line bookkeeping such as the working directory, git
// branch, token usage and thinking blocks. Image pixels are saved separately,
// so an inline image keeps only its media type.

/**
 * Recorded in a session's meta once its copy holds only the conversation. A
 * copy without it was saved by an older CLI and is trimmed before upload.
 */
export const TRANSCRIPT_FORMAT = 'conversation-v1'

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  value != null && typeof value === 'object' && !Array.isArray(value)

/** Line types a Claude Code transcript uses; any of them marks the file as one. */
const CLAUDE_LINE_TYPES = new Set([
  'user',
  'assistant',
  'summary',
  'system',
  'attachment',
  'queue-operation',
  'file-history-snapshot',
  'last-prompt',
])

// Claude Code can append context (for example CLAUDE.md) inside a message.
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>\s*/g
const cleanText = (text: string): string => text.replace(SYSTEM_REMINDER, '')

const cleanBlock = (block: unknown): Json | undefined => {
  if (!isObject(block)) return undefined
  switch (block.type) {
    case 'text': {
      const text = cleanText(typeof block.text === 'string' ? block.text : '')
      return text.trim() ? {type: 'text', text} : undefined
    }
    case 'tool_use':
      return {type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {}}
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        ...(block.is_error === true ? {is_error: true} : {}),
        content: cleanContent(block.content) ?? '',
      }
    case 'image': {
      const source = isObject(block.source) ? block.source : {}
      return {type: 'image', ...(typeof source.media_type === 'string' ? {media_type: source.media_type} : {})}
    }
    default:
      // thinking, redacted_thinking and anything else that is not conversation
      return undefined
  }
}

const cleanContent = (content: unknown): string | Json[] | undefined => {
  if (typeof content === 'string') return cleanText(content)
  if (!Array.isArray(content)) return undefined
  return content.map(cleanBlock).filter((block): block is Json => block !== undefined)
}

const isEmpty = (content: string | Json[] | undefined): boolean =>
  content === undefined || (typeof content === 'string' ? !content.trim() : content.length === 0)

/** One transcript entry reduced to what the conversation needs, or undefined to drop it. */
export const trimTranscriptEntry = (entry: unknown): Json | undefined => {
  if (!isObject(entry)) return undefined
  if (entry.type === 'summary' && typeof entry.summary === 'string')
    return {type: 'summary', summary: entry.summary, ...(typeof entry.leafUuid === 'string' ? {leafUuid: entry.leafUuid} : {})}
  if ((entry.type !== 'user' && entry.type !== 'assistant') || entry.isMeta === true || !isObject(entry.message))
    return undefined
  const content = cleanContent(entry.message.content)
  if (isEmpty(content)) return undefined
  const message = entry.message
  return {
    type: entry.type,
    ...(typeof entry.uuid === 'string' ? {uuid: entry.uuid} : {}),
    ...('parentUuid' in entry ? {parentUuid: entry.parentUuid ?? null} : {}),
    ...(typeof entry.isSidechain === 'boolean' ? {isSidechain: entry.isSidechain} : {}),
    ...(typeof entry.timestamp === 'string' ? {timestamp: entry.timestamp} : {}),
    message: {
      role: typeof message.role === 'string' ? message.role : entry.type,
      ...(typeof message.model === 'string' ? {model: message.model} : {}),
      content,
    },
  }
}

/**
 * Trim a JSONL transcript. A file that is not a Claude Code transcript (for
 * example a Codex rollout saved by hand) is returned unchanged.
 */
export const trimTranscript = (raw: string): string => {
  const entries = raw
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      try {
        return JSON.parse(line) as unknown
      } catch {
        return undefined
      }
    })
  if (!entries.some(entry => isObject(entry) && CLAUDE_LINE_TYPES.has(String(entry.type)))) return raw
  const kept = entries.map(trimTranscriptEntry).filter((entry): entry is Json => entry !== undefined)
  return kept.map(entry => `${JSON.stringify(entry)}\n`).join('')
}
