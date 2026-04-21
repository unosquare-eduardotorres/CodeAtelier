import type { SDKExecuteOptions } from './sdk-executor'

/**
 * Build-mode sandbox config.
 *
 * Build mode is an explicit user opt-in that grants the agent full system
 * access (file writes, process spawning, network, Docker, etc.).
 * The OS-level sandbox (macOS sandbox-exec / Linux bubblewrap) is disabled
 * entirely — trying to whitelist individual commands is a losing game
 * (dev servers, Docker, make, Python scripts, etc. all need full access).
 */
export function createBuildModeSandbox(): SDKExecuteOptions['sandbox'] {
  return {
    enabled: false
  }
}
