/**
 * OpenCode CLI Path Utilities
 * 
 * NOTE: This is MAIN PROCESS ONLY. While located in shared/,
 * the functions that use child_process (spawn, execSync) cannot
 * be used from the renderer process.
 * 
 * Use this for:
 * - PATH augmentation early in index.ts
 * - Locating binaries for child_process.spawn
 * 
 * Do NOT import in renderer or preload scripts.
 */

import { execSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

// Module-level cache - resolved once at startup
let cachedOpencodePath: string | null = null
let cachedOpencodeDir: string | null = null

export interface OpenCodeCliCheckResult {
  /** Whether the OpenCode CLI is installed and available */
  available: boolean
  /** Absolute path to the CLI binary (if found) */
  path?: string
  /** CLI version output (if retrieved) */
  version?: string
  /** Human-readable error message (if not available) */
  error?: string
  /** How the path was located (direct, exists, which, etc) */
  source?: string
}

/**
 * Resolve opencode path using npm config detection.
 * This is more robust than hardcoded paths because it uses npm's actual
 * configuration to determine where global packages are installed.
 * 
 * Cached after first resolution - try once, keep result.
 */
export function resolveOpencodePath(): string | null {
  if (cachedOpencodePath) {
    return cachedOpencodePath
  }

  // Method 1: Try 'which opencode' first (fastest, relies on system PATH)
  try {
    const whichResult = spawnSync('which', ['opencode'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    })

    if (whichResult.stdout?.trim()) {
      const path = whichResult.stdout.trim()
      cachedOpencodePath = path
      cachedOpencodeDir = dirname(path)
      return path
    }
  } catch {
    // Continue to fallback
  }

  // Method 2: Use npm config to get prefix (most robust)
  try {
    const npmPrefixResult = spawnSync('npm', ['config', 'get', 'prefix'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    })

    if (npmPrefixResult.stdout?.trim()) {
      const npmPrefix = npmPrefixResult.stdout.trim()
      const candidate = join(npmPrefix, 'bin', 'opencode')

      if (existsSync(candidate)) {
        cachedOpencodePath = candidate
        cachedOpencodeDir = dirname(candidate)
        return candidate
      }
    }
  } catch {
    // npm command failed
  }

  return null
}

/**
 * Get the cached opencode path (null if not yet resolved)
 */
export function getOpencodePath(): string | null {
  return cachedOpencodePath
}

/**
 * Get the cached opencode directory (null if not yet resolved)
 */
export function getOpencodeDir(): string | null {
  return cachedOpencodeDir
}

/**
 * Ensure opencode directory is in PATH
 * Returns true if path was added, false if already present
 */
export function ensureOpencodePathInEnv(): boolean {
  if (!cachedOpencodeDir) {
    resolveOpencodePath()
  }

  if (cachedOpencodeDir) {
    const currentPath = process.env.PATH || ''
    if (!currentPath.includes(cachedOpencodeDir)) {
      process.env.PATH = `${cachedOpencodeDir}:${currentPath}`
      return true
    }
  }
  return false
}

/**
 * Augment process.env.PATH with Homebrew and npm global bin directories.
 * Must be called early in Electron main process to ensure child_process.spawn()
 * can locate binaries like 'opencode'.
 */
export function augmentOpenCodeCliPath(): void {
  const HOME = process.env.HOME || ''

  const CLI_PATHS = {
    darwin: [
      '/opt/homebrew/bin',                    // Apple Silicon Homebrew
      '/usr/local/bin',                       // Intel Mac Homebrew
      join(HOME, '.npm-global', 'bin'),       // npm global on macOS
    ],
    win32: [
      join(HOME, 'AppData', 'Roaming', 'npm'),  // Windows npm global
    ],
    linux: [
      '/snap/bin',                             // Snap packages
      '/usr/local/bin',                        // System-wide
      join(HOME, '.local', 'bin'),             // ~/.local (pip, cargo, etc.)
      join(HOME, '.npm-global', 'bin'),        // npm global on Linux
    ],
  }

  const paths = CLI_PATHS[process.platform as keyof typeof CLI_PATHS] || []

  for (const binPath of paths) {
    // Avoid duplicate entries in PATH
    if (binPath && !process.env.PATH?.includes(binPath)) {
      process.env.PATH = `${binPath}${process.env.PATH ? ':' + process.env.PATH : ''}`
    }
  }
}

/**
 * Locate the OpenCode CLI binary by using npm config detection.
 * @returns Result indicating availability, path, and/or error message
 */
export async function locateOpenCodeCli(): Promise<OpenCodeCliCheckResult> {
  // Use the new resolution method that uses npm config
  const opencodePath = resolveOpencodePath()

  if (opencodePath) {
    // Try to get version (confirms it's executable)
    try {
      const version = execSync('opencode --version', {
        timeout: 5000,
        encoding: 'utf-8',
        windowsHide: true,
      }).trim()
      return {
        available: true,
        path: opencodePath,
        version,
        source: cachedOpencodeDir ? 'resolved' : 'direct',
      }
    } catch {
      // File exists but may not be executable
      return {
        available: true,
        path: opencodePath,
        source: 'exists',
        error: 'exists but not executable',
      }
    }
  }

  return {
    available: false,
    error:
      'OpenCode CLI not found. Install it by running:\n' +
      '  npm install -g @opencode-ai/cli\n' +
      'Or download from: https://opencode.ai/getting-started',
  }
}

/**
 * Synchronous check for CLI availability (quick, no version fetch).
 * Useful for early bootstrap where async isn't available.
 */
export function checkOpenCodeCliSync(): { available: boolean; path?: string; error?: string } {
  // Use the new resolution method that uses npm config
  const opencodePath = resolveOpencodePath()

  if (opencodePath) {
    // Quick test - verify executable
    const result = spawnSync(opencodePath, ['--version'], {
      timeout: 3000,
      stdio: 'pipe',
      windowsHide: true,
    })
    if (!result.error) {
      // Also ensure path is in PATH
      ensureOpencodePathInEnv()
      return { available: true, path: opencodePath }
    }
  }

  return {
    available: false,
    error: 'OpenCode CLI not found in PATH',
  }
}
