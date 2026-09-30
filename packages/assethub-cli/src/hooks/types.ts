export type HookClient = 'claude' | 'codex'

export type HookInput = {
  session_id?: string
  transcript_path?: string
  cwd?: string
  hook_event_name?: string
}

export type SessionStatus = 'saved' | 'pending-upload' | 'uploaded'

export type SessionImage = {original: string; file: string; size: number; mime: string}

export type SessionMeta = {
  sessionId: string
  cwd: string
  client: 'claude'
  lastEvent: string
  savedAt: string
  canvasId?: string
  status: SessionStatus
  images: SessionImage[]
  /** Highest rev successfully uploaded; the next upload uses uploadedRev + 1. */
  uploadedRev?: number
  /**
   * Highest rev ever sent, success or not. A snapshot whose response was lost
   * may have been published, so the next upload goes past this one too.
   */
  attemptedRev?: number
  graphId?: string
  reason?: string
  lastUploadAttemptAt?: string
  /** Where Claude Code keeps the live transcript; copied and redacted on SessionEnd or upload. */
  transcriptPath?: string
  /** The live transcript moved on since the local copy was made. */
  dirty?: boolean
  /** Never reached SessionEnd; picked up by a later SessionStart. */
  abandoned?: boolean
  /** How far the graph is compacted after uploads failed for size or time (0 = none). */
  compactLevel?: number
  /** Failed uploads in a row; spaces out the automatic retries. */
  failedAttempts?: number
  /** Size of the live transcript the local copy was made from (before masking). */
  sourceBytes?: number
  /** `conversation-v1` once the local copy is trimmed; absent for copies an older CLI saved. */
  transcriptFormat?: string
}

export type UploadOutcome = {
  ok: boolean
  graphId?: string
  reason?: string
  /** Skipped without a request because an earlier failure is still being waited out. */
  throttled?: true
}
