import process from "node:process"

const DEFAULT_ANTHROPIC_ACTUAL_LIMIT = 200_000
const ANTHROPIC_GA_1M_LIMIT = 1_000_000

export type ContextLimitModelCacheState = {
  anthropicContext1MEnabled: boolean
  modelContextLimitsCache?: Map<string, number>
}

function isAnthropicProvider(providerID: string, modelID: string): boolean {
  const normalized = providerID.toLowerCase()
  return normalized === "anthropic"
    || normalized === "google-vertex-anthropic"
    || normalized === "aws-bedrock-anthropic"
    || (normalized === "google" && modelID.toLowerCase().startsWith("claude-"))
}

function getAnthropicActualLimit(modelCacheState?: ContextLimitModelCacheState): number {
  return (modelCacheState?.anthropicContext1MEnabled ?? false) ||
    process.env.ANTHROPIC_1M_CONTEXT === "true" ||
    process.env.VERTEX_ANTHROPIC_1M_CONTEXT === "true"
    ? ANTHROPIC_GA_1M_LIMIT
    : DEFAULT_ANTHROPIC_ACTUAL_LIMIT
}

function hasGA1MContext(modelID: string): boolean {
  return /^claude-(opus|sonnet)-4(?:-|\.)(?:6|7|8)(?:-high)?$/.test(modelID) ||
    /^claude-(?:fable|mythos|sonnet)-5$/.test(modelID) ||
    /^(?:anthropic\/|(?:(?:us|eu|global|jp|au)\.)?anthropic\.)?claude-opus-5(?:-fast|(?:-|\.)5)?(?:-\d{8})?(?:@default)?$/.test(modelID) ||
    // nd custom: the whole Claude 5 line is 1M on OpenCode 1.18.34's model list (opus/sonnet/fable 5, 5.1, 5.5 and
    // -fast, checked 2026-10-13 on /config/providers); upstream still counted sonnet-5-5 and fable-5-1 as 200K, so tool
    // output from those agents was cut at about 100K.
    // Released minors only (5.1, 5.5), as upstream does for Opus.
    /^(?:anthropic\/)?claude-(?:opus|sonnet|fable|mythos)-5(?:(?:-|\.)[15])?(?:-fast)?(?:-\d{8})?$/.test(modelID)
}

export function resolveActualContextLimit(
  providerID: string,
  modelID: string,
  modelCacheState?: ContextLimitModelCacheState,
): number | null {
  if (isAnthropicProvider(providerID, modelID)) {
    const explicit1M = getAnthropicActualLimit(modelCacheState)
    if (explicit1M === ANTHROPIC_GA_1M_LIMIT) return explicit1M

    const cachedLimit = modelCacheState?.modelContextLimitsCache?.get(`${providerID}/${modelID}`)
    if (cachedLimit && hasGA1MContext(modelID)) return cachedLimit

    if (hasGA1MContext(modelID)) return ANTHROPIC_GA_1M_LIMIT

    return DEFAULT_ANTHROPIC_ACTUAL_LIMIT
  }

  return modelCacheState?.modelContextLimitsCache?.get(`${providerID}/${modelID}`) ?? null
}
