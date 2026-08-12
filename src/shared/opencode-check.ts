/**
 * OpenCode CLI availability check utilities.
 *
 * This module provides helper functions to check if the OpenCode CLI
 * is installed and available in the system PATH.
 */

import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

export interface OpenCodeCliCheckResult {
  /** Whether the OpenCode CLI is installed and available */
  available: boolean
  /** CLI version if available */
  version?: string
  /** Error message if not available */
  error?: string
}

/**
 * Check if the OpenCode CLI is installed and available.
 * @returns Promise resolving to check result
 */
export async function checkOpenCodeCli(): Promise<OpenCodeCliCheckResult> {
  try {
    const { stdout } = await execAsync('opencode --version', { timeout: 5000 })
    const version = stdout.trim()
    return { available: true, version }
  } catch (error) {
    const err = error as Error & { code?: string }

    if (err.code === 'ENOENT' || err.message.includes('not found')) {
      return {
        available: false,
        error:
          'OpenCode CLI not found. Install it by running:\n' +
          '  npm install -g @opencode-ai/cli\n' +
          'Or download from: https://opencode.ai/getting-started'
      }
    }

    return {
      available: false,
      error: `Failed to check OpenCode CLI: ${err.message}`
    }
  }
}
