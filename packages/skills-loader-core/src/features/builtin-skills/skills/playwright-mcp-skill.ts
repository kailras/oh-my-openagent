import type { BuiltinSkill } from "../types"

/**
 * Extra CLI arguments appended to the default Playwright MCP invocation (`BASE_MCP_ARGS`).
 *
 * By default the Playwright MCP server assumes it can launch the `chrome` channel
 * from a system-wide Chrome installation. In sandboxed environments (containers,
 * dev containers, CI runners, remote coding sandboxes) that binary is often
 * absent, and Playwright's bundled Chromium at `PLAYWRIGHT_BROWSERS_PATH` must be
 * used instead. `mcp_args` lets users pass `--executable-path`, `--headless`,
 * `--no-sandbox`, or any other MCP flag without forking the skill definition.
 *
 * See https://github.com/microsoft/playwright-mcp for supported flags.
 */
export interface PlaywrightSkillOptions {
  readonly mcp_args?: readonly string[]
}

/**
 * nd custom: an exact version instead of `@latest` (a fresh download on every start is a supply-chain risk and changes
 * behaviour unannounced), headless (the engine runs as a background service; a headed browser would open windows on
 * the user's screen) and isolated (profile in memory: nothing written to disk, and parallel subagents no longer fight
 * over one persistent profile — the Playwright MCP README's advice for concurrent clients).
 * 0.0.83 was published 2026-09-28; bump it like any other pin (nd-work-command docs/SETUP.md §8).
 */
const BASE_MCP_ARGS = ["@playwright/mcp@0.0.83", "--headless", "--isolated"] as const

/**
 * Factory returning the `playwright` built-in skill. When `options.mcp_args` is
 * provided the values are appended after `BASE_MCP_ARGS`, so the
 * default invocation stays byte-identical to the legacy const-export when
 * called with no options.
 */
export function createPlaywrightSkill(options: PlaywrightSkillOptions = {}): BuiltinSkill {
  const extraArgs = options.mcp_args ?? []
  return {
    name: "playwright",
    description:
      "MUST USE for any browser-related tasks. Browser automation via Playwright MCP - verification, browsing, information gathering, web scraping, testing, screenshots, and all browser interactions.",
    template: `# Playwright Browser Automation

This skill provides browser automation capabilities via the Playwright MCP server.`,
    mcpConfig: {
      playwright: {
        command: "npx",
        args: [...BASE_MCP_ARGS, ...extraArgs],
      },
    },
  }
}

/**
 * Backward-compatible singleton export. New callers should prefer
 * `createPlaywrightSkill()` so environment-specific MCP args can flow through
 * from user config without re-declaring the skill.
 */
export const playwrightSkill: BuiltinSkill = createPlaywrightSkill()
