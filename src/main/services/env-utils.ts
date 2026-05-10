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

  // Add common bin paths — later additions get higher priority (prepended to PATH).
  // Order: ~/.local/bin (lowest) → /opt/homebrew/bin → /usr/local/bin (highest)
  // This ensures /usr/local/bin (npm global) takes priority over ~/.local/bin
  // (auto-downloaded binary that may be stale).
  const homeDir = process.env.HOME || process.env.USERPROFILE || ''
  if (homeDir) {
    const localBin = `${homeDir}/.local/bin`
    if (env.PATH && !env.PATH.includes(localBin)) {
      env.PATH = `${localBin}${delimiter}${env.PATH}`
    }
  }

  if (env.PATH && !env.PATH.includes('/opt/homebrew/bin')) {
    env.PATH = `/opt/homebrew/bin${delimiter}${env.PATH}`
  }
  if (env.PATH && !env.PATH.includes('/usr/local/bin')) {
    env.PATH = `/usr/local/bin${delimiter}${env.PATH}`
  }

  return env
}
