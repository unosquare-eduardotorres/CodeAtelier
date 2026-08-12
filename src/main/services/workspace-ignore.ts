/**
 * Workspace-scoped index exclusions loaded from `.atelierignore`.
 *
 * Why a file and not a setting: exclusions are a property of the REPOSITORY,
 * not of one developer's machine. A committed .atelierignore means the team
 * fixes index bloat once and every clone inherits it — which is precisely the
 * failure mode we hit when one Windows checkout indexed a vendored NUnit tree
 * to 279,882 tags while other machines were fine.
 *
 * Syntax: gitignore-style, evaluated with the shared matchesSkipPattern glob
 * matcher (NOT the `ignore` npm package — that package requires POSIX
 * separators and silently no-ops on Windows backslash paths, which is one of
 * the root causes this module exists to work around).
 *
 * Rules are ADDITIVE to the hardcoded defaults in code-graph-exclusions.ts.
 */

import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import log from 'electron-log/main'
import { matchesSkipPattern } from './code-graph-exclusions'

export const ATELIERIGNORE_FILENAME = '.atelierignore'

/** Template written into the docs / shown in the UI for new workspaces. */
export const ATELIERIGNORE_TEMPLATE = `# Code Atelier index exclusions.
# Gitignore-style syntax. Additive to Code Atelier's built-in defaults
# (node_modules, bin, obj, packages, BuildSystem, Tools, ThirdParty,
#  Pods, Carthage, DerivedData, Binaries, Intermediate, ...).
#
# Exclude vendored dependency trees — duplicate copies of a library multiply
# every symbol's edge count and are the #1 cause of index bloat.
# BuildSystem/Tools/
# packages/

# Exclude generated documentation — thousands of files, ~0 indexable symbols.
# **/*.generated.html
# docs/api/
`

interface CachedRules {
  patterns: string[]
  mtimeMs: number
}

const cache = new Map<string, CachedRules>()

/**
 * Parse gitignore-style text into glob patterns understood by
 * matchesSkipPattern. Comments and blank lines are dropped.
 *
 * Normalization rules:
 *   `foo/`       → `**\/foo/**`   (directory anywhere)
 *   `/foo`       → `foo`, `foo/**` (anchored at workspace root)
 *   `*.html`     → `**\/*.html`   (bare pattern matches at any depth)
 *   `a/b.ts`     → `a/b.ts`       (already path-shaped, left alone)
 *
 * Negation (`!`) is intentionally unsupported: exclusions here only ever
 * shrink the index, so a rule that re-includes files would be a footgun that
 * silently reintroduces bloat.
 */
export function parseIgnoreRules(content: string): string[] {
  const patterns: string[] = []

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('!')) {
      log.warn(`[WorkspaceIgnore] Negation is not supported, ignoring rule: ${line}`)
      continue
    }

    const isDirRule = line.endsWith('/')
    const isAnchored = line.startsWith('/')
    const body = line.replace(/^\//, '').replace(/\/$/, '')
    if (!body) continue

    if (isDirRule) {
      patterns.push(isAnchored ? `${body}/**` : `**/${body}/**`)
      continue
    }

    if (isAnchored) {
      patterns.push(body, `${body}/**`)
      continue
    }

    // Unanchored: match at any depth, and treat it as a directory too so
    // `packages` behaves like `packages/` the way gitignore does.
    patterns.push(body.includes('/') ? body : `**/${body}`)
    patterns.push(`**/${body}/**`)
  }

  return patterns
}

/**
 * Load (and cache) the .atelierignore rules for a workspace.
 * Cache is keyed by workspace path and validated against the file mtime, so
 * an edit is picked up without an app restart even if the watcher misses it.
 */
export function loadIgnoreRules(workspacePath: string): string[] {
  const filePath = path.join(workspacePath, ATELIERIGNORE_FILENAME)

  try {
    if (!existsSync(filePath)) {
      cache.delete(workspacePath)
      return []
    }

    const mtimeMs = statSync(filePath).mtimeMs
    const cached = cache.get(workspacePath)
    if (cached && cached.mtimeMs === mtimeMs) return cached.patterns

    const patterns = parseIgnoreRules(readFileSync(filePath, 'utf-8'))
    cache.set(workspacePath, { patterns, mtimeMs })
    log.info(
      `[WorkspaceIgnore] Loaded ${patterns.length} pattern(s) from ${ATELIERIGNORE_FILENAME}`
    )
    return patterns
  } catch (error) {
    // A malformed or unreadable ignore file must never block indexing.
    log.warn(`[WorkspaceIgnore] Failed to read ${filePath}: ${(error as Error).message}`)
    return []
  }
}

/**
 * Merged exclusion rules: `.gitignore` + `.atelierignore`.
 *
 * We parse .gitignore ourselves rather than relying on repomap-mcp's walker,
 * which feeds native (backslash) Windows paths into the `ignore` package —
 * that package requires POSIX separators, so .gitignore was silently inert on
 * Windows and every ignored directory got walked and indexed.
 */
export function loadAllIgnorePatterns(workspacePath: string): string[] {
  const patterns = [...loadIgnoreRules(workspacePath)]

  const gitignorePath = path.join(workspacePath, '.gitignore')
  try {
    if (existsSync(gitignorePath)) {
      const mtimeMs = statSync(gitignorePath).mtimeMs
      const key = `${workspacePath}::gitignore`
      const cached = cache.get(key)
      if (cached && cached.mtimeMs === mtimeMs) {
        patterns.push(...cached.patterns)
      } else {
        const parsed = parseIgnoreRules(readFileSync(gitignorePath, 'utf-8'))
        cache.set(key, { patterns: parsed, mtimeMs })
        patterns.push(...parsed)
      }
    }
  } catch (error) {
    log.warn(`[WorkspaceIgnore] Failed to read .gitignore: ${(error as Error).message}`)
  }

  return patterns
}

/**
 * True when a workspace-relative POSIX path is excluded by .atelierignore.
 * Callers should ALSO apply isExcludedPath() for the built-in defaults.
 */
export function isIgnoredByWorkspace(workspacePath: string, relPath: string): boolean {
  const patterns = loadIgnoreRules(workspacePath)
  if (patterns.length === 0) return false
  return matchesSkipPattern(relPath, patterns)
}

/** True when a single directory name/relative dir is pruned by workspace rules. */
export function isDirIgnoredByWorkspace(workspacePath: string, relDirPath: string): boolean {
  const patterns = loadIgnoreRules(workspacePath)
  if (patterns.length === 0) return false
  // Match the directory itself and a representative child, so `**/foo/**`
  // style rules prune the tree rather than only matching files inside it.
  return matchesSkipPattern(relDirPath, patterns) || matchesSkipPattern(`${relDirPath}/.`, patterns)
}

/**
 * Append exclusion rules to the workspace's `.atelierignore`, creating the file
 * from the template if it does not exist yet. Rules already present (verbatim)
 * are skipped so repeated preflight runs don't duplicate lines.
 *
 * Returns the rules that were actually written.
 */
export function appendIgnoreRules(
  workspacePath: string,
  rules: string[],
  headerComment: string
): string[] {
  const filePath = path.join(workspacePath, ATELIERIGNORE_FILENAME)

  const existingText = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null
  const existingLines = new Set(
    (existingText ?? '').split(/\r?\n/).map((l) => l.trim().replace(/^\//, ''))
  )

  const toWrite = rules
    .map((r) => r.trim())
    .filter((r) => r && !r.startsWith('#'))
    .filter((r) => !existingLines.has(r.replace(/^\//, '')))
  if (toWrite.length === 0) return []

  const body = `${existingText === null ? ATELIERIGNORE_TEMPLATE : ''}\n# ${headerComment}\n${toWrite.join('\n')}\n`
  appendFileSync(filePath, body, 'utf-8')
  invalidateIgnoreCache(workspacePath)
  log.info(`[WorkspaceIgnore] Appended ${toWrite.length} rule(s) to ${ATELIERIGNORE_FILENAME}`)
  return toWrite
}

/** Drop cached rules for a workspace (called by the file watcher). */
export function invalidateIgnoreCache(workspacePath?: string): void {
  if (workspacePath) cache.delete(workspacePath)
  else cache.clear()
}
