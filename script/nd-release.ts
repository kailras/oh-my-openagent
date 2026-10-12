#!/usr/bin/env bun
/**
 * nd custom: builds this fork as the OpenCode plugin package and installs it as an immutable release that
 * `~/.config/opencode/opencode.json` (and `tui.json`) pin with a `file://` plugin entry.
 *
 *   bun run script/nd-release.ts [--allow-dirty] [--no-build] [--out <dir>]
 *
 * 1. Refuses uncommitted changes, so a release is exactly one commit (`--allow-dirty` for a local trial only).
 * 2. Builds the `opencode-plugin` profile (script/build-nodes.ts): no Codex Light plugin, Senpi or native binary.
 * 3. Stages the published layout under the npm name `oh-my-openagent`, without the platform-binary packages and the
 *    Codex plugin files, and packs it.
 * 4. Installs the tarball with `npm install --ignore-scripts` into `<out>/<version>/` (default
 *    `~/.local/share/oh-my-openagent-nd`). Scripts stay off: upstream's postinstall clears OpenCode's plugin cache.
 * 5. Imports both entry points as a smoke test, writes `nd-release.json` and prints the plugin entry.
 *
 * A release directory is never overwritten — bump the `-nd.N` version in package.json for every change.
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const option = (name: string) => {
	const index = args.indexOf(name)
	return index >= 0 ? args[index + 1] : undefined
}

/** `files` entries of the upstream package that only the Codex Light plugin uses. */
const CODEX_ONLY = [/^!?packages\/omo-codex(\/|$)/, /^packages\/prompts-core\/prompts\/ultrawork\/codex\.md$/]
/** Always shipped by npm, listed here so the stage copies them. */
const ALWAYS = ["README.md", "LICENSE.md", "THIRD-PARTY-NOTICES.md"]

function run(command: string, commandArgs: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; quiet?: boolean } = {}): string {
	const result = spawnSync(command, commandArgs, {
		cwd: options.cwd ?? repoRoot,
		env: options.env ?? process.env,
		encoding: "utf8",
		stdio: options.quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "inherit"],
		maxBuffer: 64 * 1024 * 1024,
	})
	if (result.status !== 0) {
		throw new Error(`${command} ${commandArgs.join(" ")} failed (exit ${result.status})${result.stderr ? `\n${result.stderr}` : ""}`)
	}
	return result.stdout.trim()
}

function fail(message: string): never {
	console.error(`nd-release: ${message}`)
	process.exit(1)
}

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as Record<string, unknown> & {
	version: string
	files: string[]
}
const version = pkg.version
if (!/-nd\.\d+$/.test(version)) fail(`package.json version ${version} is not an nd release (expected <base>-nd.<n>)`)

const dirty = run("git", ["status", "--porcelain"], { quiet: true })
if (dirty && !flag("--allow-dirty")) fail(`uncommitted changes — commit first (or --allow-dirty for a local trial):\n${dirty}`)
const commit = run("git", ["rev-parse", "HEAD"], { quiet: true })
const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { quiet: true })
const baseTag = run("git", ["describe", "--tags", "--abbrev=0", "--match", "v*"], { quiet: true })

const outRoot = resolve(option("--out") ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "oh-my-openagent-nd"))
const releaseDir = join(outRoot, version)
if (existsSync(releaseDir)) fail(`${releaseDir} already exists — releases are immutable; bump the -nd.N version`)

if (!flag("--no-build")) {
	console.log(`nd-release: building ${version} (${commit.slice(0, 9)}) with the opencode-plugin profile`)
	run("bun", ["run", "script/build.ts"], { env: { ...process.env, OMO_BUILD_PROFILE: "opencode-plugin" } })
}
for (const required of ["dist/index.js", "dist/tui.js", "dist/cli/index.js", "dist/skills", "packages/lsp-tools-mcp/dist"]) {
	if (!existsSync(join(repoRoot, required))) fail(`build output missing: ${required}`)
}

// ── stage the published layout ─────────────────────────────────────────────
const work = join(repoRoot, ".nd-release")
const stage = join(work, "stage")
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
const files = pkg.files.filter((entry) => !CODEX_ONLY.some((pattern) => pattern.test(entry)))
for (const entry of [...ALWAYS, ...files]) {
	if (entry.startsWith("!")) continue
	const source = join(repoRoot, entry)
	if (!existsSync(source)) continue
	const target = join(stage, entry)
	mkdirSync(dirname(target), { recursive: true })
	cpSync(source, target, { recursive: true, filter: (path) => !path.split(/[\\/]/).includes("node_modules") })
}
const published: Record<string, unknown> = { ...pkg, name: "oh-my-openagent", files }
for (const key of ["optionalDependencies", "devDependencies", "workspaces", "scripts", "trustedDependencies", "overrides", "packageManager"]) {
	delete published[key]
}
published.nd = { commit, branch, base: baseTag, builtAt: new Date().toISOString() }
writeFileSync(join(stage, "package.json"), `${JSON.stringify(published, null, 2)}\n`)

const tarballName = run("npm", ["pack", "--silent", "--pack-destination", work], { cwd: stage, quiet: true }).split("\n").pop()!
const tarball = join(work, tarballName)
const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex")

// ── install as an immutable release ────────────────────────────────────────
mkdirSync(releaseDir, { recursive: true })
try {
	const localTarball = join(releaseDir, tarballName)
	cpSync(tarball, localTarball)
	writeFileSync(
		join(releaseDir, "package.json"),
		`${JSON.stringify({ name: "oh-my-openagent-nd-release", private: true, dependencies: { "oh-my-openagent": `file:./${tarballName}` } }, null, 2)}\n`,
	)
	run("npm", ["install", "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund"], { cwd: releaseDir })
	const pluginDir = join(releaseDir, "node_modules", "oh-my-openagent")
	const smoke = run(
		"bun",
		[
			"-e",
			`const s = await import(${JSON.stringify(pathToFileURL(join(pluginDir, "dist", "index.js")).href)});
			 const t = await import(${JSON.stringify(pathToFileURL(join(pluginDir, "dist", "tui.js")).href)});
			 if (typeof s.default?.server !== "function") throw new Error("server entry has no server()");
			 if (typeof t.default?.tui !== "function") throw new Error("tui entry has no tui()");
			 console.log("ok")`,
		],
		{ cwd: releaseDir, quiet: true, env: { ...process.env, OMO_ND_USAGE_OBSERVER: "0" } },
	)
	if (!smoke.endsWith("ok")) throw new Error(`smoke import failed: ${smoke}`)
	const entry = pathToFileURL(pluginDir).href
	const manifest = { version, commit, branch, base: baseTag, builtAt: (published.nd as { builtAt: string }).builtAt, tarball: tarballName, sha256, pluginEntry: entry }
	writeFileSync(join(releaseDir, "nd-release.json"), `${JSON.stringify(manifest, null, 2)}\n`)
	console.log(`nd-release: installed ${version} → ${releaseDir}`)
	console.log(`nd-release: plugin entry for opencode.json and tui.json:\n  "${entry}"`)
} catch (error) {
	rmSync(releaseDir, { recursive: true, force: true })
	fail(error instanceof Error ? error.message : String(error))
}
