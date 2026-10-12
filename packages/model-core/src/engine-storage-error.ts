/**
 * nd custom: OpenCode 1.18's own SQLite write failing mid-run (seen 2026-10-08 on two long subagent runs:
 * "UnknownError: Failed to execute statement"). Nothing is wrong with the model or the request, so the step is worth
 * sending again. Matched only on errors the engine reports as such (an `UnknownError`, or an error without a name) —
 * never on assistant text, where a reply about SQLite may well say "database is locked".
 *
 * The same message also covers lasting storage faults (a full disk, a read-only file); the callers' retry limits
 * (`max_fallback_attempts`, the fallback chain's length) bound how often it is tried.
 */
const ENGINE_STORAGE_ERROR_PATTERNS = [/failed\s+to\s+execute\s+statement/i, /database\s+is\s+locked/i, /sqlite_busy/i] as const

export function isEngineStorageError(error: { name?: string; message?: string }): boolean {
  const name = error.name?.toLowerCase()
  if (name !== undefined && name !== "unknownerror") return false
  const message = error.message ?? ""
  return ENGINE_STORAGE_ERROR_PATTERNS.some((pattern) => pattern.test(message))
}
