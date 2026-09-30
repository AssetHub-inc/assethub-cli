// Parse a Claude Code transcript (JSONL) into the flat sequence the session
// graph is built from.

export type TranscriptItem =
  | {kind: 'prompt'; text: string; timestamp?: string}
  | {kind: 'assistant'; text: string; timestamp?: string}
  | {kind: 'tool'; toolUseId: string; toolName: string; input: unknown; timestamp?: string}

export type ParsedTranscript = {
  items: TranscriptItem[]
  /** tool_use id -> absolute image paths seen in its tool_result. */
  resultImages: Map<string, string[]>
}

const IMAGE_PATH_RE = /(?<![\w.~-])(?:\/[^\s"'\\<>|:*?`()[\]{}]+)+\.(?:png|jpe?g|webp)\b/gi

export const extractImagePaths = (text: string): string[] => {
  const found = text.match(IMAGE_PATH_RE) ?? []
  return [...new Set(found)]
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value)

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block =>
      isObject(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : '',
    )
    .filter(Boolean)
    .join('\n')
}

export const parseTranscript = (raw: string): ParsedTranscript => {
  const items: TranscriptItem[] = []
  const resultImages = new Map<string, string[]>()
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObject(entry) || !isObject(entry.message)) continue
    const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : undefined
    const content = entry.message.content
    if (entry.type === 'user') {
      if (entry.isMeta === true) continue
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            isObject(block) &&
            block.type === 'tool_result' &&
            typeof block.tool_use_id === 'string'
          ) {
            const paths = extractImagePaths(JSON.stringify(block.content ?? ''))
            if (paths.length) resultImages.set(block.tool_use_id, paths)
          }
        }
      }
      const text = textOf(content).trim()
      if (text) items.push({kind: 'prompt', text, timestamp})
    } else if (entry.type === 'assistant') {
      const text = textOf(content).trim()
      if (text) items.push({kind: 'assistant', text, timestamp})
      if (Array.isArray(content)) {
        for (const block of content) {
          if (isObject(block) && block.type === 'tool_use' && typeof block.id === 'string') {
            items.push({
              kind: 'tool',
              toolUseId: block.id,
              toolName: typeof block.name === 'string' ? block.name : 'unknown',
              input: block.input ?? {},
              timestamp,
            })
          }
        }
      }
    }
  }
  return {items, resultImages}
}
