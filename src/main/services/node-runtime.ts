/**
 * Node runtime resolution for bundled MCP servers.
 *
 * Bundled MCP servers used to spawn the literal command `node`, which only
 * works when Node.js is on PATH. End-user machines frequently have no Node at
 * all (incident 2026-08: all 8 bundled servers failed to connect on every
 * spawn — 137 occurrences in one log — because the machine had no Node
 * installation, silently stripping the agent of every tool we ship).
 *
 * The app itself ships Electron, and Electron IS Node: launching the app
 * binary with `ELECTRON_RUN_AS_NODE=1` behaves as a plain Node runtime
 * (verified on the affected Windows machine: v24.18.0). `process.execPath` is
 * the Electron binary in dev and the packaged app binary in production, so the
 * same call covers both.
 *
 * The `env` entries MCP configs carry are MERGED over the parent environment
 * by the spawning client (Claude CLI / MCP SDK), so adding
 * `ELECTRON_RUN_AS_NODE` never strips PATH or other vars from the child.
 */

/** Env var that makes an Electron binary behave as plain Node.js. */
export const ELECTRON_RUN_AS_NODE_ENV: Readonly<Record<string, string>> = {
  ELECTRON_RUN_AS_NODE: '1'
}

/**
 * The command that runs Node on this machine, guaranteed to exist: this very
 * process is running on it.
 */
export function nodeCommand(): string {
  return process.execPath
}

/**
 * Merge the Electron-as-Node flag into a server env record.
 * Returns a fresh object; a nil input still yields the flag alone.
 */
export function withNodeRuntimeEnv(
  env: Record<string, string> | undefined
): Record<string, string> {
  return { ...env, ...ELECTRON_RUN_AS_NODE_ENV }
}
