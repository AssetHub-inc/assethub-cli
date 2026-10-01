// Keep only the conversation from a Claude Code transcript (or a Codex rollout,
// converted to the same shape) before it is saved
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

/** Top-level record types of a Codex rollout (`~/.codex/sessions/.../rollout-*.jsonl`). */
const CODEX_LINE_TYPES = new Set(['session_meta', 'response_item', 'event_msg', 'turn_context', 'compacted'])

// Codex sends its context as user messages: AGENTS.md, and tagged blocks such
// as <environment_context> or <user_instructions>. They are not the artist's words.
const CODEX_CONTEXT_BLOCK = /<([A-Za-z][\w-]*(?:context|instructions|plugins))(?:\s[^>]*)?>[\s\S]*?<\/\1>\s*/g
const codexUserText = (text: string): string =>
  /^\s*# AGENTS\.md instructions/.test(text) ? '' : cleanText(text.replace(CODEX_CONTEXT_BLOCK, ''))

const codexText = (content: unknown, blockType: string, clean: (text: string) => string): string =>
  (Array.isArray(content) ? content : [])
    .map(block => (isObject(block) && block.type === blockType && typeof block.text === 'string' ? clean(block.text) : ''))
    .filter(text => text.trim())
    .join('\n')

// An exec result is JSON text with timing and token bookkeeping around the
// command's output; only the output is conversation.
const codexOutputText = (text: string): string => {
  if (text.trimStart().startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (isObject(parsed) && typeof parsed.output === 'string') return parsed.output
    } catch {
      // plain text that happens to start with a brace
    }
  }
  return text
}

/** Tool output: a string, `{output}`, or a list of `{type, text}` items (images are dropped). */
const codexToolOutput = (output: unknown): string => {
  if (typeof output === 'string') return cleanText(codexOutputText(output))
  if (Array.isArray(output))
    return cleanText(
      output
        .map(item => (isObject(item) && typeof item.text === 'string' ? codexOutputText(item.text) : ''))
        .filter(Boolean)
        .join('\n'),
    )
  if (isObject(output)) {
    for (const key of ['output', 'content']) if (typeof output[key] === 'string') return cleanText(output[key] as string)
  }
  return output === undefined ? '' : JSON.stringify(output)
}

const codexArguments = (value: unknown): unknown => {
  if (typeof value !== 'string') return value ?? {}
  try {
    return JSON.parse(value) as unknown
  } catch {
    return {arguments: value}
  }
}

const codexMessage = (type: 'user' | 'assistant', timestamp: unknown, content: string | Json[]): Json => ({
  type,
  ...(typeof timestamp === 'string' ? {timestamp} : {}),
  message: {role: type, content},
})

/**
 * One Codex rollout record as a conversation entry in the same shape as a
 * trimmed Claude Code transcript, or undefined to drop it. Kept: the artist's
 * prompts, the agent's replies, its tool calls and their output, and compaction
 * summaries. Dropped: session metadata (base instructions, git, cwd), developer
 * and context messages, reasoning, turn settings and the event stream, which
 * repeats the messages.
 */
export const codexEntry = (entry: unknown): Json | undefined => {
  if (!isObject(entry) || !isObject(entry.payload)) return undefined
  const {payload, timestamp} = entry
  if (entry.type === 'compacted')
    return typeof payload.message === 'string' && payload.message.trim() ? {type: 'summary', summary: payload.message} : undefined
  if (entry.type !== 'response_item') return undefined
  switch (payload.type) {
    case 'message': {
      if (payload.role === 'user') {
        const text = codexText(payload.content, 'input_text', codexUserText).trim()
        return text ? codexMessage('user', timestamp, text) : undefined
      }
      if (payload.role !== 'assistant') return undefined
      const text = codexText(payload.content, 'output_text', cleanText)
      return text.trim() ? codexMessage('assistant', timestamp, [{type: 'text', text}]) : undefined
    }
    case 'function_call':
    case 'custom_tool_call':
    case 'local_shell_call': {
      const id = typeof payload.call_id === 'string' ? payload.call_id : payload.id
      if (typeof id !== 'string') return undefined
      const name = typeof payload.name === 'string' ? payload.name : payload.type === 'local_shell_call' ? 'shell' : 'unknown'
      const input =
        payload.type === 'function_call'
          ? codexArguments(payload.arguments)
          : payload.type === 'custom_tool_call'
            ? {input: payload.input}
            : (payload.action ?? {})
      return codexMessage('assistant', timestamp, [{type: 'tool_use', id, name, input}])
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      if (typeof payload.call_id !== 'string') return undefined
      return codexMessage('user', timestamp, [{type: 'tool_result', tool_use_id: payload.call_id, content: codexToolOutput(payload.output)}])
    }
    default:
      // reasoning, web search and anything else that is not conversation
      return undefined
  }
}

/**
 * Trim a JSONL transcript: a Claude Code transcript, or a Codex rollout turned
 * into the same conversation shape. A file in any other format is returned
 * unchanged.
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
  const isClaude = entries.some(entry => isObject(entry) && CLAUDE_LINE_TYPES.has(String(entry.type)))
  const isCodex = !isClaude && entries.some(entry => isObject(entry) && CODEX_LINE_TYPES.has(String(entry.type)) && isObject(entry.payload))
  if (!isClaude && !isCodex) return raw
  const kept = entries.map(isCodex ? codexEntry : trimTranscriptEntry).filter((entry): entry is Json => entry !== undefined)
  return kept.map(entry => `${JSON.stringify(entry)}\n`).join('')
}
