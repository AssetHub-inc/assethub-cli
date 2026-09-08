/**
 * Every failure the run-upload path reports.
 *
 * `message` is what the operator reads on stderr, so it always answers both
 * questions: what happened, and what to do next. `code` stays stable for tests
 * and for anyone scripting around the command.
 *
 * Nothing here ever carries the API key. Request URLs are safe to print (the
 * key rides in the Authorization header, never in a query string) but response
 * bodies and header dumps are not echoed wholesale — only the server's own
 * `error.code` / `error.message` / `error.details.blobKeys`.
 */
export class RunUploadError extends Error {
  readonly code: string
  readonly status?: number
  readonly details?: Record<string, unknown>

  constructor(
    code: string,
    message: string,
    options: {status?: number; details?: Record<string, unknown>; cause?: unknown} = {},
  ) {
    super(message, options.cause === undefined ? undefined : {cause: options.cause})
    this.name = 'RunUploadError'
    this.code = code
    this.status = options.status
    this.details = options.details
  }
}
