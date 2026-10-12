import { describe, expect, it, test } from "bun:test"

import { getModelCapabilities, type ModelCapabilitiesSnapshot } from "./model-capabilities"
import { detectHeuristicModelFamily } from "./model-capability-heuristics"

describe("getModelCapabilities heuristic fallback", () => {
  const bundledSnapshot: ModelCapabilitiesSnapshot = {
    generatedAt: "2026-03-25T00:00:00.000Z",
    sourceUrl: "https://models.dev/api.json",
    models: {},
  }

  test("detects OpenCode Go Qwen Max models through the heuristic fallback", () => {
    // given
    const modelID = "qwen3.7-max"

    // when
    const result = getModelCapabilities({
      providerID: "opencode-go",
      modelID,
      bundledSnapshot,
    })

    // then
    expect(result).toMatchObject({
      canonicalModelID: modelID,
      family: "qwen",
    })
    expect(result.diagnostics).toMatchObject({
      resolutionMode: "heuristic-backed",
      snapshot: { source: "none" },
      family: { source: "heuristic" },
    })
  })
})

describe("nd custom: Claude 5 effort ladder", () => {
  it("#given Claude 5 models #when detecting the family #then xhigh and max are allowed", () => {
    for (const id of ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1", "claude-opus-5-5-fast", "claude-sonnet-5"]) {
      expect(detectHeuristicModelFamily(id)?.variants).toEqual(["low", "medium", "high", "xhigh", "max"])
    }
  })

  it("#given older Claude models #when detecting the family #then their ladders stay", () => {
    expect(detectHeuristicModelFamily("claude-opus-4-8")?.family).toBe("claude-opus")
    expect(detectHeuristicModelFamily("claude-sonnet-4-6")?.family).toBe("claude-non-opus")
    expect(detectHeuristicModelFamily("claude-haiku-5-5")?.family).toBe("claude-non-opus")
  })
})
