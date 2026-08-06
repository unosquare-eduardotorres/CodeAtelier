/**
 * Exclusion preflight — "we found code here, confirm?"
 *
 * Runs before indexing starts and answers one question per candidate
 * directory: is this vendored/generated output, or is it your own code?
 *
 * Why it exists: hardcoding generic directory names (`lib`, `libs`, `Library`,
 * `plugins`) would silently hide first-party source, which is far worse than
 * indexing some noise. So Tier-2 names are surfaced with evidence and require
 * explicit confirmation, while unambiguous tool output (Pods, Binaries, ...)
 * is excluded outright and listed for transparency only.
 *
 * Budget: breadth-first, max depth 6, hard 3-second wall clock — mirroring
 * BlueprintPreflightService. A preflight failure is a warning, never a
 * blocker: indexing must always be able to start.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import log from 'electron-log/main'
import {
  REPOMAP_EXCLUDED_DIRS,
  isExcludedDirName,
  isTier2CandidateDirName,
  toPosixRel
} from './code-graph-exclusions'
import { appendIgnoreRules } from './workspace-ignore'
import type { ExclusionCandidate, ExclusionPreflightResult } from '../../shared/types'

/** Hard wall-clock budget for the whole preflight. */
export const PREFLIGHT_BUDGET_MS = 3_000
/** Directories deeper than this are not inspected. */
export const PREFLIGHT_MAX_DEPTH = 6
/** Cap on files visited while measuring a single candidate directory. */
const MAX_FILES_PER_CANDIDATE = 5_000
/** Cap on directories measured — a .NET solution has hundreds of bin/obj pairs. */
const MAX_CANDIDATES = 60

const BINARY_EXTENSIONS = new Set([
  '.dll',
  '.so',
  '.dylib',
  '.a',
  '.jar',
  '.pdb',
  '.lib',
  '.exe',
  '.o',
  '.obj',
  '.bin',
  '.framework'
])

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.cs',
  '.java',
  '.kt',
  '.swift',
  '.m',
  '.mm',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.php',
  '.scala',
  '.dart',
  '.vue',
  '.svelte'
])

/** Files whose presence at a directory root says "third-party package". */
const VENDOR_MARKER_FILES = new Set([
  'license',
  'license.md',
  'license.txt',
  'licence',
  'copying',
  'notice',
  'package.swift',
  'bower.json',
  'cmakelists.txt'
])
const VENDOR_MARKER_EXTENSIONS = new Set(['.podspec', '.nuspec', '.gemspec'])

/** A directory is "recently edited" (first-party hint) within this window. */
const RECENT_EDIT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

interface DirStats {
  fileCount: number
  totalBytes: number
  extCounts: Map<string, number>
  sourceFileCount: number
  binaryFileCount: number
  newestMtimeMs: number
  vendorMarkers: string[]
}

/**
 * Measure a candidate directory: file mix, size, vendor markers.
 * Bounded by MAX_FILES_PER_CANDIDATE and the shared deadline so a 200K-file
 * Pods tree can't blow the budget.
 */
function collectDirStats(absDir: string, deadline: number): DirStats {
  const stats: DirStats = {
    fileCount: 0,
    totalBytes: 0,
    extCounts: new Map(),
    sourceFileCount: 0,
    binaryFileCount: 0,
    newestMtimeMs: 0,
    vendorMarkers: []
  }

  const walk = (dir: string, isRoot: boolean): void => {
    if (stats.fileCount >= MAX_FILES_PER_CANDIDATE || Date.now() > deadline) return

    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (stats.fileCount >= MAX_FILES_PER_CANDIDATE || Date.now() > deadline) return
      const full = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue
        walk(full, false)
        continue
      }
      if (!entry.isFile()) continue

      const ext = path.extname(entry.name).toLowerCase()
      stats.fileCount++
      stats.extCounts.set(ext || '(none)', (stats.extCounts.get(ext || '(none)') ?? 0) + 1)
      if (SOURCE_EXTENSIONS.has(ext)) stats.sourceFileCount++
      if (BINARY_EXTENSIONS.has(ext)) stats.binaryFileCount++

      try {
        const st = statSync(full)
        stats.totalBytes += st.size
        if (st.mtimeMs > stats.newestMtimeMs) stats.newestMtimeMs = st.mtimeMs
      } catch {
        /* unreadable file — ignore */
      }

      if (isRoot) {
        const lower = entry.name.toLowerCase()
        if (VENDOR_MARKER_FILES.has(lower) || VENDOR_MARKER_EXTENSIONS.has(ext)) {
          stats.vendorMarkers.push(entry.name)
        }
      }
    }
  }

  walk(absDir, true)
  return stats
}

/**
 * Batch `git check-ignore` for all candidates in one spawn.
 * Exit code 1 means "nothing ignored" — that is success, not failure.
 */
function gitIgnoredPaths(workspacePath: string, relPaths: string[]): Set<string> {
  if (relPaths.length === 0) return new Set()
  try {
    const out = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd: workspacePath,
      input: relPaths.join('\n'),
      encoding: 'utf-8',
      timeout: 2_000
    })
    return new Set(
      out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    )
  } catch (error) {
    // execFileSync throws on non-zero exit; exit 1 = no paths ignored.
    const stdout = (error as { stdout?: string | Buffer }).stdout
    if (typeof stdout === 'string' || Buffer.isBuffer(stdout)) {
      return new Set(
        stdout
          .toString()
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
      )
    }
    return new Set()
  }
}

/** True when git tracks at least one file under relPath. */
function gitTracksDir(workspacePath: string, relPath: string): boolean {
  try {
    const out = execFileSync('git', ['ls-files', '--', relPath], {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout: 2_000,
      maxBuffer: 4 * 1024 * 1024
    })
    return out.trim().length > 0
  } catch {
    return false
  }
}

function topExtensions(extCounts: Map<string, number>): Array<{ ext: string; count: number }> {
  return [...extCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([ext, count]) => ({ ext, count }))
}

interface ClassifyInput {
  dirName: string
  stats: DirStats
  gitIgnored: boolean
  gitTracked: boolean
  tier1: boolean
}

/**
 * Pure classification — exported for unit testing without touching disk or git.
 *
 * Rule order matters: git's own verdict outranks name heuristics, because a
 * directory in .gitignore is by definition generated or vendored.
 */
export function classifyCandidate(input: ClassifyInput): {
  verdict: ExclusionCandidate['verdict']
  reason: string
  defaultChecked: boolean
  firstPartyHints: string[]
} {
  const { dirName, stats, gitIgnored, gitTracked, tier1 } = input
  const firstPartyHints: string[] = []
  if (gitTracked) firstPartyHints.push('committed to git')
  if (stats.sourceFileCount > 0) firstPartyHints.push(`${stats.sourceFileCount} source files`)
  if (stats.newestMtimeMs > 0 && Date.now() - stats.newestMtimeMs < RECENT_EDIT_WINDOW_MS) {
    firstPartyHints.push('edited in the last 30 days')
  }

  if (gitIgnored) {
    return {
      verdict: 'auto-exclude',
      reason: 'ignored by git — generated or vendored output',
      defaultChecked: true,
      firstPartyHints
    }
  }

  if (tier1) {
    return {
      verdict: 'auto-exclude',
      reason: `${dirName} is tool-managed output, never hand-written`,
      defaultChecked: true,
      firstPartyHints
    }
  }

  if (stats.fileCount > 0 && stats.binaryFileCount / stats.fileCount > 0.8) {
    return {
      verdict: 'auto-exclude',
      reason: 'binaries only, no indexable source',
      defaultChecked: true,
      firstPartyHints
    }
  }

  if (isTier2CandidateDirName(dirName)) {
    if (stats.vendorMarkers.length > 0) {
      return {
        verdict: 'needs-confirmation',
        reason: `vendored third-party library (${stats.vendorMarkers.join(', ')})`,
        defaultChecked: true,
        firstPartyHints
      }
    }
    if (gitTracked && stats.sourceFileCount > 0) {
      return {
        verdict: 'needs-confirmation',
        reason: 'committed to git and looks like your own code',
        defaultChecked: false,
        firstPartyHints
      }
    }
    return {
      verdict: 'needs-confirmation',
      reason: 'generic directory name — could be vendored or first-party',
      defaultChecked: false,
      firstPartyHints
    }
  }

  return {
    verdict: 'keep',
    reason: 'looks like first-party source',
    defaultChecked: false,
    firstPartyHints
  }
}

/**
 * Scan a workspace for directories that should (or might) be excluded.
 *
 * Never throws: on any failure it returns an empty candidate list so the
 * caller can start indexing regardless.
 */
export function runExclusionPreflight(workspacePath: string): ExclusionPreflightResult {
  const started = Date.now()
  const deadline = started + PREFLIGHT_BUDGET_MS
  const candidates: ExclusionCandidate[] = []
  let truncated = false

  try {
    const isGitRepo = existsSync(path.join(workspacePath, '.git'))

    // Breadth-first so shallow, high-value directories are found first when
    // the budget runs out mid-scan.
    const queue: Array<{ abs: string; depth: number }> = [{ abs: workspacePath, depth: 0 }]
    const found: Array<{ abs: string; relPath: string; dirName: string; tier1: boolean }> = []

    while (queue.length > 0) {
      if (Date.now() > deadline) {
        truncated = true
        break
      }
      const { abs, depth } = queue.shift()!

      let entries: import('node:fs').Dirent[]
      try {
        entries = readdirSync(abs, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const full = path.join(abs, entry.name)
        const relPath = toPosixRel(full, workspacePath)

        // Already pruned by repomap's own list — not worth reporting.
        if (REPOMAP_EXCLUDED_DIRS.has(entry.name)) continue

        const tier1 = isExcludedDirName(entry.name)
        if (tier1 || isTier2CandidateDirName(entry.name)) {
          found.push({ abs: full, relPath, dirName: entry.name, tier1 })
          // Do not descend: the whole subtree is the candidate.
          continue
        }

        if (depth + 1 < PREFLIGHT_MAX_DEPTH) queue.push({ abs: full, depth: depth + 1 })
        else truncated = true
      }
    }

    if (found.length > MAX_CANDIDATES) {
      found.length = MAX_CANDIDATES
      truncated = true
    }

    const ignoredSet = isGitRepo
      ? gitIgnoredPaths(
          workspacePath,
          found.map((f) => f.relPath)
        )
      : new Set<string>()

    for (const entry of found) {
      if (Date.now() > deadline) {
        truncated = true
        break
      }
      const stats = collectDirStats(entry.abs, deadline)
      if (stats.fileCount === 0) continue

      const gitIgnored = ignoredSet.has(entry.relPath)
      // Only Tier-2 candidates need the extra spawn — Tier-1 is decided already.
      const gitTracked =
        isGitRepo && !entry.tier1 && !gitIgnored
          ? gitTracksDir(workspacePath, entry.relPath)
          : false

      const { verdict, reason, defaultChecked, firstPartyHints } = classifyCandidate({
        dirName: entry.dirName,
        stats,
        gitIgnored,
        gitTracked,
        tier1: entry.tier1
      })
      if (verdict === 'keep') continue

      candidates.push({
        relPath: entry.relPath,
        dirName: entry.dirName,
        fileCount: stats.fileCount,
        totalBytes: stats.totalBytes,
        extensions: topExtensions(stats.extCounts),
        gitIgnored,
        gitTracked,
        vendorMarkers: stats.vendorMarkers,
        firstPartyHints,
        verdict,
        reason,
        defaultChecked,
        suggestedRule: `/${entry.relPath}/`
      })
    }
  } catch (error) {
    log.warn(`[ExclusionPreflight] Scan failed (non-fatal): ${(error as Error).message}`)
  }

  const durationMs = Date.now() - started
  log.info(
    `[ExclusionPreflight] ${candidates.length} candidate(s) in ${durationMs}ms` +
      (truncated ? ' (budget/depth reached)' : '')
  )
  return { candidates, truncated, durationMs }
}

/**
 * Persist confirmed exclusions to `.atelierignore` so BOTH indexers and every
 * clone of the repo inherit the decision.
 */
export function applyExclusions(workspacePath: string, patterns: string[]): { written: string[] } {
  if (patterns.length === 0) return { written: [] }
  const today = new Date().toISOString().slice(0, 10)
  const written = appendIgnoreRules(
    workspacePath,
    patterns,
    `Added by exclusion preflight ${today}`
  )
  return { written }
}
