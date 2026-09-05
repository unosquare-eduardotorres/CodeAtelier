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

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, delimiter as pathDelimiter, win32, posix } from 'node:path'

// Module-level cache - resolved once at startup
let cachedOpencodePath: string | null = null
let cachedOpencodeDir: string | null = null

/** Diagnostics from the last resolution attempt — powers the failure message. */
let lastProbe: { lookupTool: string; npmPrefix: string | null; candidates: string[] } = {
  lookupTool: '',
  npmPrefix: null,
  candidates: []
}

/**
 * Environment shape the pure helpers read. Deliberately a plain record so tests
 * can pass a synthetic Windows environment from a macOS host.
 */
export type PathEnv = Record<string, string | undefined>

export interface CandidateOptions {
  platform: string
  env: PathEnv
  /** Output of `npm config get prefix`, if it could be obtained. */
  npmPrefix?: string | null
}

/**
 * Home directory for the given platform. Windows sets USERPROFILE, not HOME —
 * assuming HOME there yields a *relative* path, which silently corrupts every
 * derived candidate and PATH entry.
 */
export function homeDirFor(platform: string, env: PathEnv): string {
  if (platform === 'win32') {
    return env.USERPROFILE || env.HOME || ''
  }
  return env.HOME || ''
}

/**
 * Directories where globally-installed CLIs typically live, per platform.
 * Pure: no filesystem access, no process.env read.
 */
export function wellKnownCliDirs(platform: string, env: PathEnv): string[] {
  const home = homeDirFor(platform, env)

  if (platform === 'win32') {
    const dirs = [
      env.APPDATA ? win32.join(env.APPDATA, 'npm') : '',
      env.LOCALAPPDATA ? win32.join(env.LOCALAPPDATA, 'npm') : '',
      home ? win32.join(home, 'AppData', 'Roaming', 'npm') : '',
      'C:\\Program Files\\nodejs',
      'C:\\Program Files (x86)\\nodejs'
    ]
    return dedupePaths(dirs.filter(Boolean), true)
  }

  if (platform === 'darwin') {
    return dedupePaths(
      [
        '/opt/homebrew/bin', // Apple Silicon Homebrew
        '/usr/local/bin', // Intel Mac Homebrew
        home ? posix.join(home, '.npm-global', 'bin') : ''
      ].filter(Boolean),
      false
    )
  }

  return dedupePaths(
    [
      '/snap/bin',
      '/usr/local/bin',
      home ? posix.join(home, '.local', 'bin') : '',
      home ? posix.join(home, '.npm-global', 'bin') : ''
    ].filter(Boolean),
    false
  )
}

/**
 * Ordered list of absolute paths that could be the opencode binary.
 *
 * Windows npm places its shims in the *prefix root* (`opencode.cmd`,
 * `opencode.ps1`, `opencode`) — there is no `bin/` subdirectory, and the
 * extensionless file is a shell script Node cannot spawn. POSIX npm uses
 * `<prefix>/bin/opencode`.
 *
 * Pure: builds strings only. Callers filter with existsSync.
 */
export function opencodeCandidates({ platform, env, npmPrefix }: CandidateOptions): string[] {
  const isWin = platform === 'win32'
  const dirs: string[] = []

  const prefix = npmPrefix?.trim()
  if (prefix) {
    // Windows shims sit in the prefix root; POSIX puts them under bin/.
    dirs.push(isWin ? prefix : posix.join(prefix, 'bin'))
  }
  dirs.push(...wellKnownCliDirs(platform, env))

  // .cmd first: it is the only shim Node can spawn reliably (with a shell).
  const names = isWin
    ? ['opencode.cmd', 'opencode.exe', 'opencode.bat', 'opencode.ps1', 'opencode']
    : ['opencode']

  const joinFn = isWin ? win32.join : posix.join
  const candidates: string[] = []
  for (const dir of dedupePaths(dirs, isWin)) {
    for (const name of names) {
      candidates.push(joinFn(dir, name))
    }
  }

  return dedupePaths(candidates, isWin)
}

/**
 * Pick the spawnable entry from `where`/`which` output. `where` on Windows
 * routinely returns several lines, the extensionless shell script often first —
 * spawning that fails, so prefer an executable extension when one is offered.
 */
export function pickExecutableFromLookup(stdout: string, platform: string): string | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length === 0) return null
  if (platform !== 'win32') return lines[0]

  const preferred = ['.cmd', '.exe', '.bat']
  for (const ext of preferred) {
    const match = lines.find((line) => line.toLowerCase().endsWith(ext))
    if (match) return match
  }
  return lines[0]
}

/** Normalise a path for comparison: drop trailing separators, lowercase on Windows. */
function normalizeForCompare(value: string, caseInsensitive: boolean): string {
  const trimmed = value.trim().replace(/[\\/]+$/, '')
  return caseInsensitive ? trimmed.toLowerCase() : trimmed
}

function dedupePaths(values: string[], caseInsensitive: boolean): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (!value) continue
    const key = normalizeForCompare(value, caseInsensitive)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

/**
 * Prepend `dir` to a PATH string using the platform's delimiter.
 *
 * Idempotent, and case-insensitive when the delimiter is ';' (Windows).
 * Hardcoding ':' here fuses the new entry with the first existing entry on
 * Windows, producing an invalid path and *breaking* the PATH it touches.
 *
 * Pure: returns the new value, does not mutate process.env.
 */
export function prependToPath(
  existing: string,
  dir: string,
  delimiter: string = pathDelimiter
): string {
  if (!dir) return existing

  const caseInsensitive = delimiter === ';'
  const entries = existing.split(delimiter).filter((entry) => entry.length > 0)
  const target = normalizeForCompare(dir, caseInsensitive)

  if (entries.some((entry) => normalizeForCompare(entry, caseInsensitive) === target)) {
    return existing
  }

  return entries.length > 0 ? `${dir}${delimiter}${entries.join(delimiter)}` : dir
}

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
 * Resolve opencode path.
 *
 * Order: system lookup (`where` on Windows, `which` elsewhere) → npm prefix →
 * well-known install directories. The last step matters most on Windows, where
 * a packaged Electron app launched from a shortcut inherits a PATH that
 * contains neither node nor npm, so the first two steps cannot succeed.
 *
 * Success is cached. Failure is NOT cached — pass `{ force: true }` to re-probe
 * after PATH augmentation.
 */
export function resolveOpencodePath(options?: { force?: boolean }): string | null {
  if (cachedOpencodePath && !options?.force) {
    return cachedOpencodePath
  }

  const platform = process.platform
  const isWin = platform === 'win32'
  // `where` is the Windows equivalent; `which` does not exist there (except
  // under Git Bash, which is why the CLI appears reachable from that shell).
  const lookupTool = isWin ? 'where' : 'which'
  lastProbe = { lookupTool, npmPrefix: null, candidates: [] }

  const cache = (path: string): string => {
    cachedOpencodePath = path
    cachedOpencodeDir = dirname(path)
    return path
  }

  // Method 1: system lookup (fastest, relies on the inherited PATH)
  try {
    const lookupResult = spawnSync(lookupTool, ['opencode'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
      // `where` is a real executable, but shell resolution is more reliable
      // when System32 is missing from a trimmed PATH.
      shell: isWin
    })

    const found = pickExecutableFromLookup(lookupResult.stdout ?? '', platform)
    if (found && existsSync(found)) {
      return cache(found)
    }
  } catch {
    // Continue to fallback
  }

  // Method 2: ask npm where global packages live.
  // `npm` is `npm.cmd` on Windows and cannot be spawned without a shell.
  let npmPrefix: string | null = null
  try {
    const npmPrefixResult = spawnSync('npm', ['config', 'get', 'prefix'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
      shell: isWin
    })

    npmPrefix = npmPrefixResult.stdout?.trim() || null
  } catch {
    // npm command failed (commonly: npm is not on the inherited PATH)
  }

  // Method 3: probe concrete candidate paths, npm prefix first, then the
  // well-known install locations that do not require npm to be reachable.
  const candidates = opencodeCandidates({ platform, env: process.env, npmPrefix })
  lastProbe = { lookupTool, npmPrefix, candidates }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return cache(candidate)
    }
  }

  return null
}

/**
 * Human-readable account of the last failed resolution.
 *
 * "Install it" is the wrong advice when the CLI is installed and merely
 * unreachable — report what was probed and the PATH actually in effect.
 */
export function describeOpencodeLookupFailure(): string {
  const shown = lastProbe.candidates.slice(0, 8)
  const omitted = lastProbe.candidates.length - shown.length

  return (
    `OpenCode CLI could not be located.\n\n` +
    `Platform: ${process.platform}\n` +
    `Lookup tool: ${lastProbe.lookupTool || 'not run'} (no match)\n` +
    `npm prefix: ${lastProbe.npmPrefix ?? 'unavailable (npm not reachable from this process)'}\n` +
    `Probed paths:\n` +
    (shown.length > 0 ? shown.map((p) => `  ${p}`).join('\n') : '  (none)') +
    (omitted > 0 ? `\n  …and ${omitted} more` : '') +
    `\n\nPATH in effect:\n  ${process.env.PATH?.slice(0, 800) || '(not set)'}\n\n` +
    `If OpenCode is already installed, its directory is missing from the PATH ` +
    `this app inherited — add it and restart.\n` +
    `Install (or reinstall) it with:\n` +
    `  npm install -g @opencode-ai/cli`
  )
}

/**
 * Run `<binary> --version`.
 *
 * On Windows the resolved path is usually a `.cmd` shim, which Node >= 18.20
 * refuses to spawn without a shell; and with a shell, quoting the path is the
 * caller's responsibility (`C:\Program Files\...` would otherwise split).
 */
export function probeOpencodeVersion(
  binPath: string,
  timeout = 5000
): { ok: boolean; version?: string; error?: string } {
  const isWin = process.platform === 'win32'

  const result = spawnSync(isWin ? `"${binPath}"` : binPath, ['--version'], {
    encoding: 'utf-8',
    timeout,
    stdio: 'pipe',
    windowsHide: true,
    shell: isWin
  })

  if (result.error) {
    return { ok: false, error: result.error.message }
  }

  const version = result.stdout?.trim() || ''
  if (!version) {
    return { ok: false, error: result.stderr?.toString().trim() || 'empty version output' }
  }

  return { ok: true, version }
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
    const nextPath = prependToPath(currentPath, cachedOpencodeDir)
    if (nextPath !== currentPath) {
      process.env.PATH = nextPath
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
  // Strictly additive and idempotent — this runs before every spawn in the app,
  // including the Claude CLI, so it must never remove or rewrite an entry.
  for (const binPath of wellKnownCliDirs(process.platform, process.env)) {
    process.env.PATH = prependToPath(process.env.PATH || '', binPath)
  }
}

/**
 * Locate the OpenCode CLI binary by using npm config detection.
 * @returns Result indicating availability, path, and/or error message
 */
export async function locateOpenCodeCli(): Promise<OpenCodeCliCheckResult> {
  const opencodePath = resolveOpencodePath()

  if (opencodePath) {
    // Probe the resolved path, not the bare name: the bare name depends on the
    // very PATH that may be the reason resolution was needed in the first place.
    const probe = probeOpencodeVersion(opencodePath)

    if (probe.ok) {
      return {
        available: true,
        path: opencodePath,
        version: probe.version,
        source: cachedOpencodeDir ? 'resolved' : 'direct'
      }
    }

    // File exists but may not be executable
    return {
      available: true,
      path: opencodePath,
      source: 'exists',
      error: `exists but not executable: ${probe.error ?? 'unknown error'}`
    }
  }

  return {
    available: false,
    error: describeOpencodeLookupFailure()
  }
}

/**
 * Synchronous check for CLI availability (quick, no version fetch).
 * Useful for early bootstrap where async isn't available.
 */
export function checkOpenCodeCliSync(): { available: boolean; path?: string; error?: string } {
  const opencodePath = resolveOpencodePath()

  if (opencodePath) {
    // Quick test - verify executable (shell-aware: .cmd shims need one)
    const probe = probeOpencodeVersion(opencodePath, 3000)
    if (probe.ok) {
      // Also ensure path is in PATH
      ensureOpencodePathInEnv()
      return { available: true, path: opencodePath }
    }
  }

  return {
    available: false,
    error: describeOpencodeLookupFailure()
  }
}
