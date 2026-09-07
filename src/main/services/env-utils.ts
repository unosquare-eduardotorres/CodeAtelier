import { delimiter } from 'node:path'

/**
 * Builds a process environment with PATH augmented for claude CLI discovery.
 * Removes CLAUDECODE env var to avoid nested session errors.
 *
 * Uses `path.delimiter` for cross-platform compatibility (`:` on Unix, `;` on Windows).
 */
export function buildEnvWithPath(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT

  // Always prepend bin paths in priority order (highest last → lands first in PATH).
  // Duplicates in PATH are harmless; the `includes` guard was removed because it
  // caused a bug: when /usr/local/bin was already present but AFTER ~/.local/bin,
  // the guard skipped re-prepending it, so a stale ~/.local/bin/claude (v2.1.22)
  // was found before /usr/local/bin/claude (v2.1.101).
  const homeDir = process.env.HOME || process.env.USERPROFILE || ''
  if (homeDir && env.PATH) {
    env.PATH = `${homeDir}/.local/bin${delimiter}${env.PATH}`
  }

  if (env.PATH) {
    env.PATH = `/opt/homebrew/bin${delimiter}${env.PATH}`
    env.PATH = `/usr/local/bin${delimiter}${env.PATH}`
  }

  // E2E seam: the Playwright fixture puts a scripted `claude` shim on PATH, but
  // the prepends above would pull a real install in /usr/local/bin ahead of it —
  // so shim-gated tests silently ran against the real CLI. Double-gated on
  // NODE_ENV=test AND the fixture's own variable, so production is untouched.
  // Set by e2e/helpers/electron-fixture.ts (absolute path).
  if (process.env.NODE_ENV === 'test' && process.env.CLAUDE_SHIM_DIR && env.PATH) {
    env.PATH = `${process.env.CLAUDE_SHIM_DIR}${delimiter}${env.PATH}`
  }

  return env
}

/** Keys deleted from a gate environment — see `buildGateEnv`. */
const GATE_ENV_DELETED_EXACT = [
  'NODE_ENV',
  'NODE_OPTIONS',
  'VITEST',
  'VITEST_POOL_ID',
  'VITEST_WORKER_ID'
] as const

/** npm leaks its OWN lifecycle/config state under these prefixes. */
const GATE_ENV_DELETED_PREFIXES = [/^npm_/]

/**
 * Environment for gate/probe commands run against a TARGET repo.
 *
 * Two failure modes this exists to stop:
 *   1. Inherited build-mode vars. NODE_ENV=production in the launching shell
 *      makes `npm ci` omit devDependencies, so the target repo's test runner
 *      is simply absent — which surfaces as a bogus red suite, not as a
 *      missing-command. Observed: three suites reported "No such built-in
 *      module: node:" until NODE_ENV was cleared.
 *   2. npm_* leakage. Launching via `npm run dev` exports npm_config_* and
 *      npm_lifecycle_* describing THIS repo; a child `npm` in another repo
 *      reads them as its own config.
 *
 * NODE_ENV is DELETED, not set to 'test': the target repo's own scripts are
 * the right place to choose, and unset is the neutral default npm assumes.
 *
 * Builds on `buildEnvWithPath`, so the PATH prepends and the CLAUDECODE scrub
 * apply here too. That PATH hygiene is a real secondary win: a packaged app
 * launched from Finder gets a minimal PATH without /opt/homebrew/bin, which
 * otherwise makes npm-based gates report `command_missing`.
 */
export function buildGateEnv(): NodeJS.ProcessEnv {
  const env = buildEnvWithPath()
  for (const key of GATE_ENV_DELETED_EXACT) delete env[key]
  for (const key of Object.keys(env)) {
    if (GATE_ENV_DELETED_PREFIXES.some((re) => re.test(key))) delete env[key]
  }
  // Mirrors the normalisation precedent in quality-gate-runner.service.ts —
  // deterministic output, no TTY auto-detection in gate evidence.
  env.CI = 'true'
  env.FORCE_COLOR = '0'
  return env
}
