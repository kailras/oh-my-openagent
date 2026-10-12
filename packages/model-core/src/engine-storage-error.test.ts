import { describe, expect, test } from "bun:test"

import { isEngineStorageError } from "./engine-storage-error"
import { shouldRetryError } from "./model-error-classifier"
import { extractRuntimeFallbackAutoRetrySignal } from "./runtime-fallback-auto-retry-signal"
import { isRuntimeFallbackRetryableError } from "./runtime-fallback-error-classifier"

describe("nd custom: engine storage errors", () => {
  test("#given the engine's SQLite write failing mid-run #when a subagent task's error is classified #then it is retried", () => {
    //#given the shapes the engine reported on 2026-10-08, as background tasks and sync delegation pass them
    const cases = [
      { name: "UnknownError", message: "Failed to execute statement" },
      { name: "UnknownError", message: "SQLiteError: database is locked" },
      { message: "SQLITE_BUSY: database is busy" },
    ]

    //#when / #then — shouldRetryError is what background tasks, sync delegation and model fallback use
    expect(cases.map((error) => shouldRetryError(error))).toEqual([true, true, true])
    expect(cases.map((error) => isRuntimeFallbackRetryableError(error, [429, 503, 529]))).toEqual([true, true, true])
  })

  test("#given another named error mentioning SQLite #when classified #then it is not taken for the engine's storage", () => {
    expect(isEngineStorageError({ name: "ValidationError", message: "database is locked" })).toBe(false)
    expect(shouldRetryError({ name: "ValidationError", message: "Failed to execute statement" })).toBe(false)
  })

  test("#given an assistant answer that talks about a locked database #when scanned for retry signals #then it is not one", () => {
    //#given a normal reply while debugging SQLite (runtime-fallback reads assistant text for auto-retry signals)
    const reply = { message: "The test failed because the database is locked; I added a busy_timeout." }

    //#then
    expect(extractRuntimeFallbackAutoRetrySignal(reply)).toBeUndefined()
  })
})
