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
