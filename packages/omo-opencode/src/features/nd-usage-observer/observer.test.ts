import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { __resetUsageObserverForTesting, createSnapshotWriter, installUsageObserver, usageSnapshot, WRITE_INTERVAL_MS } from "./observer"

const originalFetch = globalThis.fetch
const originalFlag = process.env.OMO_ND_USAGE_OBSERVER
let directory = ""

const ANTHROPIC_HEADERS = {
  "anthropic-ratelimit-unified-status": "allowed",
  "anthropic-ratelimit-unified-5h-utilization": "0.39",
  "anthropic-ratelimit-unified-5h-reset": "1791829200",
  "anthropic-ratelimit-unified-7d-utilization": "0.07",
  "anthropic-ratelimit-unified-7d-reset": "1792209600",
  "request-id": "req_123",
  "content-type": "text/event-stream",
}

function fakeFetch(headers: Record<string, string>, status = 200) {
  const calls: { input: unknown; init: unknown }[] = []
  const response = new Response("data: {}\n\n", { status, headers })
  const fn = (async (input: unknown, init?: unknown) => {
    calls.push({ input, init })
    return response
  }) as unknown as typeof fetch
  return { fn, calls, response }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "nd-usage-"))
  delete process.env.OMO_ND_USAGE_OBSERVER
  __resetUsageObserverForTesting()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  __resetUsageObserverForTesting()
  if (originalFlag === undefined) delete process.env.OMO_ND_USAGE_OBSERVER
  else process.env.OMO_ND_USAGE_OBSERVER = originalFlag
  rmSync(directory, { recursive: true, force: true })
})

describe("usageSnapshot", () => {
  it("#given a Claude messages response #when reading it #then keeps only the unified rate-limit headers", () => {
    // given
    const response = new Response("", { status: 200, headers: ANTHROPIC_HEADERS })

    // when
    const snapshot = usageSnapshot("https://api.anthropic.com/v1/messages?beta=true", response, 1000)

    // then
    expect(snapshot).toEqual({
      version: 1,
      provider: "anthropic",
      observedAt: 1000,
      httpStatus: 200,
      headers: {
        "anthropic-ratelimit-unified-status": "allowed",
        "anthropic-ratelimit-unified-5h-utilization": "0.39",
        "anthropic-ratelimit-unified-5h-reset": "1791829200",
        "anthropic-ratelimit-unified-7d-utilization": "0.07",
        "anthropic-ratelimit-unified-7d-reset": "1792209600",
      },
    })
  })

  it("#given a ChatGPT Codex response as a URL object #when reading it #then keeps the x-codex headers", () => {
    // given
    const response = new Response("", {
      status: 429,
      headers: { "x-codex-primary-used-percent": "100", "x-codex-primary-window-minutes": "300", server: "cloudflare" },
    })

    // when
    const snapshot = usageSnapshot(new URL("https://chatgpt.com/backend-api/codex/responses"), response, 5)

    // then
    expect(snapshot?.provider).toBe("openai")
    expect(snapshot?.httpStatus).toBe(429)
    expect(snapshot?.headers).toEqual({ "x-codex-primary-used-percent": "100", "x-codex-primary-window-minutes": "300" })
  })

  it("#given other hosts, paths or no matching headers #when reading #then records nothing", () => {
    const withHeaders = new Response("", { headers: ANTHROPIC_HEADERS })
    expect(usageSnapshot("https://example.com/v1/messages", withHeaders, 1)).toBeUndefined()
    expect(usageSnapshot("https://api.anthropic.com/v1/messages/count_tokens", withHeaders, 1)).toBeUndefined()
    expect(usageSnapshot("not a url", withHeaders, 1)).toBeUndefined()
    expect(usageSnapshot("https://api.anthropic.com/v1/messages", new Response(""), 1)).toBeUndefined()
  })
})

describe("installUsageObserver", () => {
  it("#given an observed Claude request #when it completes #then returns the same response and writes the snapshot file", async () => {
    // given
    const fake = fakeFetch(ANTHROPIC_HEADERS)
    globalThis.fetch = fake.fn
    expect(installUsageObserver({ directory, now: () => 42 })).toBe(true)

    // when
    const init = { method: "POST", headers: { authorization: "Bearer secret-token" }, body: "{}" }
    const response = await globalThis.fetch("https://api.anthropic.com/v1/messages?beta=true", init)

    // then
    expect(response).toBe(fake.response)
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.init).toBe(init)
    const written = readFileSync(join(directory, "anthropic.json"), "utf8")
    expect(written).not.toContain("secret-token")
    expect(JSON.parse(written)).toMatchObject({ provider: "anthropic", observedAt: 42, headers: { "anthropic-ratelimit-unified-5h-utilization": "0.39" } })
  })

  it("#given the observer is installed #when installing again #then the fetch is wrapped only once", () => {
    // given
    globalThis.fetch = fakeFetch(ANTHROPIC_HEADERS).fn
    installUsageObserver({ directory })
    const wrapped = globalThis.fetch

    // when
    const again = installUsageObserver({ directory })

    // then
    expect(again).toBe(false)
    expect(globalThis.fetch).toBe(wrapped)
  })

  it("#given OMO_ND_USAGE_OBSERVER=0 #when installing #then leaves fetch alone", () => {
    // given
    process.env.OMO_ND_USAGE_OBSERVER = "0"
    const fake = fakeFetch(ANTHROPIC_HEADERS)
    globalThis.fetch = fake.fn

    // when
    const installed = installUsageObserver({ directory })

    // then
    expect(installed).toBe(false)
    expect(globalThis.fetch).toBe(fake.fn)
  })

  it("#given the request fails #when observed #then the error reaches the caller and nothing is written", async () => {
    // given
    globalThis.fetch = (async () => {
      throw new TypeError("network down")
    }) as unknown as typeof fetch
    installUsageObserver({ directory })

    // when
    const attempt = globalThis.fetch("https://api.anthropic.com/v1/messages")

    // then
    await expect(attempt).rejects.toThrow("network down")
    expect(existsSync(join(directory, "anthropic.json"))).toBe(false)
  })

  it("#given a copied fetch property such as Bun's preconnect #when wrapping #then it stays available", () => {
    // given
    const fake = fakeFetch(ANTHROPIC_HEADERS)
    Object.defineProperty(fake.fn, "preconnect", { value: () => "warm", enumerable: false, configurable: true })
    globalThis.fetch = fake.fn

    // when
    installUsageObserver({ directory })

    // then
    expect((globalThis.fetch as unknown as { preconnect: () => string }).preconnect()).toBe("warm")
  })
})

describe("createSnapshotWriter", () => {
  it("#given snapshots inside the write interval #when recording #then writes the first now and the latest when the interval ends", () => {
    // given
    let clock = 10_000
    const writes: { file: string; content: string }[] = []
    const writer = createSnapshotWriter({ directory, now: () => clock, write: (file, content) => writes.push({ file, content }) })
    const snapshot = (observedAt: number) => ({ version: 1 as const, provider: "anthropic" as const, observedAt, httpStatus: 200, headers: { "anthropic-ratelimit-unified-status": "allowed" } })

    // when
    writer.record(snapshot(1))
    clock += WRITE_INTERVAL_MS / 2
    writer.record(snapshot(2))
    writer.record(snapshot(3))
    writer.flushAll()

    // then
    expect(writes.map((w) => JSON.parse(w.content).observedAt)).toEqual([1, 3])
    expect(writes[0]?.file).toBe(join(directory, "anthropic.json"))
  })
})
