/**
 * active-paths — what the current turn is actually working on.
 *
 * Memory retrieval used to see nothing but the user's message, so a fact
 * scoped to `src/billing` was unreachable from "fix this bug" even with
 * `Invoice.java` open. This module supplies the missing signal from two
 * sources that need no new plumbing:
 *
 *   1. files the agent has touched this session (tool activity)
 *   2. files with uncommitted changes (`git status --porcelain`)
 *
 * Both are cheap, but `git status` is a subprocess, so its result is cached
 * per workspace for a few seconds — long enough to cover a burst of turns,
 * short enough that switching files is picked up immediately.
 */

import { execFileSync } from 'node:child_process'
import { isAbsolute, relative } from 'node:path'
import { normalizePath } from './scope-matcher'

/** How long a `git status` result stays usable. */
const GIT_CACHE_TTL_MS = 5_000

/**
 * Cap on the returned set. Beyond this the signal is noise — a branch with 200
 * modified files says nothing about what this particular turn is about.
 */
const MAX_ACTIVE_PATHS = 40

/** `git status` on a huge repository must never stall a turn. */
const GIT_TIMEOUT_MS = 2_000

interface CacheEntry {
  paths: string[]
  at: number
}

const gitCache = new Map<string, CacheEntry>()

/** Convert an absolute or relative path to a workspace-relative one. */
export function toWorkspaceRelative(workspacePath: string, path: string): string | null {
  const trimmed = path.trim()
  if (!trimmed) return null

  if (!isAbsolute(trimmed)) return normalizePath(trimmed)

  if (!workspacePath) return null
  const rel = relative(workspacePath, trimmed)
  // Outside the workspace — a fact's scope cannot meaningfully cover it.
  if (!rel || rel.startsWith('..')) return null
  return normalizePath(rel)
}

/**
 * Workspace-relative paths with uncommitted changes.
 *
 * Untracked files count: a file you have just created is very much what you
 * are working on.
 */
export function gitChangedPaths(workspacePath: string): string[] {
  if (!workspacePath) return []

  const cached = gitCache.get(workspacePath)
  if (cached && Date.now() - cached.at < GIT_CACHE_TTL_MS) return cached.paths

  let paths: string[] = []
  try {
    const output = execFileSync('git', ['status', '--porcelain'], {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    })
    paths = parsePorcelain(output)
  } catch {
    // Not a git repo, git missing, or a timeout. All three are ordinary states
    // for a workspace, not errors: the caller simply gets the tool-activity
    // half of the signal. Deliberately not logged — this runs every few
    // seconds, and a non-git workspace would fill the log with it.
    paths = []
  }

  gitCache.set(workspacePath, { paths, at: Date.now() })
  return paths
}

/** Parse `git status --porcelain` output into workspace-relative paths. */
export function parsePorcelain(output: string): string[] {
  const paths: string[] = []

  for (const line of output.split('\n')) {
    if (line.length < 4) continue

    // Format: 'XY <path>' or 'XY <orig> -> <new>' for renames and copies.
    let entry = line.slice(3).trim()
    const arrow = entry.indexOf(' -> ')
    if (arrow !== -1) entry = entry.slice(arrow + 4)

    // Paths containing unusual characters are quoted and C-escaped by git.
    if (entry.startsWith('"') && entry.endsWith('"') && entry.length > 1) {
      entry = entry.slice(1, -1).replace(/\\(.)/g, '$1')
    }

    const normalized = normalizePath(entry)
    if (normalized) paths.push(normalized)
  }

  return [...new Set(paths)]
}

/**
 * The active path set for a turn: files the agent has touched, then files with
 * uncommitted changes, capped.
 *
 * Tool activity comes first deliberately — it is the sharper signal, and the
 * cap should drop working-tree noise before it drops the file the agent just
 * read.
 */
export function resolveActivePaths(
  workspacePath: string | null | undefined,
  exploredFiles: string[] = []
): string[] {
  if (!workspacePath) return []

  const out: string[] = []
  const seen = new Set<string>()

  const push = (raw: string): void => {
    if (out.length >= MAX_ACTIVE_PATHS) return
    const rel = toWorkspaceRelative(workspacePath, raw)
    if (!rel || seen.has(rel)) return
    seen.add(rel)
    out.push(rel)
  }

  for (const file of exploredFiles) push(file)
  for (const file of gitChangedPaths(workspacePath)) push(file)

  return out
}

/** Test-only: drop the `git status` cache. */
export function clearActivePathsCache(): void {
  gitCache.clear()
}
