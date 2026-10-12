import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { getOmoOpenCodeCacheDir } from "../../shared/data-path"
import { log } from "../../shared/logger"

/**
 * nd custom (for the nd-work-command dashboard): keeps the latest subscription rate-limit state that providers report
 * in their response headers — Anthropic's `anthropic-ratelimit-unified-*` (5-hour and weekly utilization, reset times)
 * and the ChatGPT Codex backend's `x-codex-*` — in one small JSON file per provider, so the dashboard's account card
 * can show how much of each window is used without ever reading a credential.
 *
 * Only response headers with those prefixes are copied. Request headers (which carry the OAuth token), request and
 * response bodies are never read, and the caller gets the very same response object back.
 */

export type UsageProvider = "anthropic" | "openai"

export type UsageSnapshot = {
  readonly version: 1
  readonly provider: UsageProvider
  readonly observedAt: number
  readonly httpStatus: number
  /** The matching response headers as sent, lower-cased names. */
  readonly headers: Record<string, string>
}

type Rule = { readonly provider: UsageProvider; readonly host: string; readonly path: RegExp; readonly prefix: string }

const RULES: readonly Rule[] = [
  { provider: "anthropic", host: "api.anthropic.com", path: /^\/v1\/messages\/?$/, prefix: "anthropic-ratelimit-unified-" },
  { provider: "openai", host: "chatgpt.com", path: /^\/backend-api\/codex\/responses\/?$/, prefix: "x-codex-" },
]

/** At most one write per provider in this window; the latest snapshot inside it is written when it ends. */
export const WRITE_INTERVAL_MS = 2_000

const INSTALLED = Symbol.for("oh-my-openagent.nd.usage-observer")

type FetchFn = typeof globalThis.fetch

export type UsageObserverOptions = {
  /** Folder the `<provider>.json` files go to; default `<OMO cache>/usage`. */
  readonly directory?: string
  readonly now?: () => number
  readonly write?: (file: string, content: string) => void
}

function requestUrl(input: unknown): URL | undefined {
  try {
    if (typeof input === "string") return new URL(input)
    if (input instanceof URL) return input
    if (input instanceof Request) return new URL(input.url)
  } catch {
    return undefined
  }
  return undefined
}

/** The rate-limit headers of a provider response worth recording, or undefined for any other request. */
export function usageSnapshot(input: unknown, response: Response, now: number): UsageSnapshot | undefined {
  const url = requestUrl(input)
  if (!url) return undefined
  const rule = RULES.find((r) => url.hostname === r.host && r.path.test(url.pathname))
  if (!rule) return undefined
  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    const key = name.toLowerCase()
    if (key.startsWith(rule.prefix)) headers[key] = value
  })
  if (Object.keys(headers).length === 0) return undefined
  return { version: 1, provider: rule.provider, observedAt: now, httpStatus: response.status, headers }
}

function defaultDirectory(): string {
  const override = process.env.OMO_ND_USAGE_DIR?.trim()
  return override ? override : join(getOmoOpenCodeCacheDir(), "usage")
}

/**
 * Replaces the file in one step, through a temporary file of its own: two engine processes sharing the cache (the
 * service and a TUI) never write the same temporary file. Owner-only, as the readings say how much the user works.
 */
function defaultWrite(file: string, content: string): void {
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`
  try {
    writeFileSync(temp, content, { encoding: "utf-8", mode: 0o600 })
    renameSync(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

/** Writes snapshots to `<directory>/<provider>.json`, throttled per provider. */
export function createSnapshotWriter(options: UsageObserverOptions = {}) {
  const now = options.now ?? Date.now
  const write = options.write ?? defaultWrite
  const lastWrite = new Map<UsageProvider, number>()
  const pending = new Map<UsageProvider, UsageSnapshot>()
  const timers = new Map<UsageProvider, ReturnType<typeof setTimeout>>()

  const flush = (provider: UsageProvider) => {
    const snapshot = pending.get(provider)
    pending.delete(provider)
    timers.delete(provider)
    if (!snapshot) return
    // A failed attempt counts too: a folder that cannot be written must not be retried (and logged) on every response.
    lastWrite.set(provider, now())
    try {
      const directory = options.directory ?? defaultDirectory()
      mkdirSync(directory, { recursive: true })
      write(join(directory, `${provider}.json`), `${JSON.stringify(snapshot)}\n`)
    } catch (error) {
      log("[nd-usage-observer] write failed", { provider, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return {
    record(snapshot: UsageSnapshot): void {
      pending.set(snapshot.provider, snapshot)
      if (timers.has(snapshot.provider)) return
      const wait = (lastWrite.get(snapshot.provider) ?? -Infinity) + WRITE_INTERVAL_MS - now()
      if (wait <= 0) {
        flush(snapshot.provider)
        return
      }
      const timer = setTimeout(() => flush(snapshot.provider), wait)
      // A pending snapshot must never keep the engine process alive on its own.
      timer.unref?.()
      timers.set(snapshot.provider, timer)
    },
    /** Writes what is still waiting (tests, shutdown). */
    flushAll(): void {
      for (const [provider, timer] of [...timers]) {
        clearTimeout(timer)
        flush(provider)
      }
    },
  }
}

function copyFetchProperties(target: FetchFn, source: FetchFn): void {
  for (const key of Object.getOwnPropertyNames(source)) {
    if (key === "length" || key === "name" || key === "prototype" || key === "arguments" || key === "caller") continue
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (descriptor) Object.defineProperty(target, key, descriptor)
  }
}

/**
 * Wraps `globalThis.fetch` once per process. Provider auth plugins call the global `fetch` for their API requests, so
 * every Claude and ChatGPT request the engine makes passes through here. Failures to record never reach the caller.
 * Off with `OMO_ND_USAGE_OBSERVER=0`.
 */
export function installUsageObserver(options: UsageObserverOptions = {}): boolean {
  const flag = process.env.OMO_ND_USAGE_OBSERVER?.trim().toLowerCase()
  if (flag === "0" || flag === "false" || flag === "off") return false
  const scope = globalThis as typeof globalThis & { [INSTALLED]?: true }
  if (scope[INSTALLED]) return false
  const original: FetchFn = globalThis.fetch
  if (typeof original !== "function") return false
  const now = options.now ?? Date.now
  const writer = createSnapshotWriter(options)
  const observed = async function observedFetch(input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) {
    const response = await original(input, init)
    try {
      const snapshot = usageSnapshot(input, response, now())
      if (snapshot) writer.record(snapshot)
    } catch (error) {
      log("[nd-usage-observer] observe failed", { error: error instanceof Error ? error.message : String(error) })
    }
    return response
  } as FetchFn
  copyFetchProperties(observed, original)
  globalThis.fetch = observed
  scope[INSTALLED] = true
  log("[nd-usage-observer] installed", { directory: options.directory ?? defaultDirectory() })
  return true
}

/** @internal test-only: forget the installed marker so a test can install again on a fresh fetch. */
export function __resetUsageObserverForTesting(): void {
  delete (globalThis as typeof globalThis & { [INSTALLED]?: true })[INSTALLED]
}
