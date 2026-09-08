/**
 * File discovery for design runs.
 *
 * Separate from `audit-discovery.service.ts` because the selection rule differs
 * in kind: Workspace Health discovers by *track* (a fixed per-auditor pattern
 * config), while a design run discovers by *user-chosen scope* — the whole
 * project, or an explicit list of files and directories from the wizard. The
 * audit walker is also not exported, so there is nothing to reuse.
 *
 * Everything returned is workspace-relative and POSIX-separated, matching the
 * paths `normalizeScopePath` produces and the paths detector findings are
 * relativized to. One path vocabulary across the whole design pipeline is what
 * lets dedupe keys and UI links compare string-exact.
 */
import { readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { DesignScope } from '../../shared/types'
import { isDesignRelevantPath } from '../../shared/design-commands'
import { skillLogger } from '../logger'

const log = {
  info: (msg: string): void => skillLogger?.info?.(msg),
  warn: (msg: string): void => skillLogger?.warn?.(msg)
}

/** Directories never worth scanning. Mirrors `audit-discovery.service.ts`. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  'vendor',
  '__pycache__',
  'target',
  '.cache',
  '.output',
  '.svelte-kit',
  '.turbo'
])

/**
 * Cap on files handed to the agent. Matches the audit cap: beyond this the
 * multi-round loop is the limiting factor, not discovery.
 */
export const MAX_DESIGN_FILES = 100

/** Max recursion depth, guarding pathological trees and symlink loops. */
const MAX_DEPTH = 10

export interface DesignDiscoveryResult {
  /** Total design-relevant files found, before the cap. */
  totalFiles: number
  /** Workspace-relative POSIX paths, capped at `MAX_DESIGN_FILES`. */
  filePaths: string[]
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/')
}

/**
 * True when `candidate` is inside `root`.
 *
 * Defence in depth: `parseDesignRunConfig` already proves scope paths cannot
 * escape, but this module is callable from anywhere and a traversal here would
 * mean reading files outside the workspace.
 */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !/^([a-zA-Z]:)?[\\/]/.test(rel))
}

function walk(
  rootPath: string,
  currentPath: string,
  depth: number,
  onFile: (relPath: string) => void
): void {
  if (depth > MAX_DEPTH) return

  let entries: string[]
  try {
    entries = readdirSync(currentPath) as unknown as string[]
  } catch {
    return // unreadable directory — skip rather than fail the run
  }

  for (const entryName of entries) {
    const name = String(entryName)
    const fullPath = join(currentPath, name)

    let isDir = false
    try {
      isDir = statSync(fullPath).isDirectory()
    } catch {
      continue // inaccessible entry or broken symlink
    }

    if (isDir) {
      if (SKIP_DIRS.has(name.toLowerCase()) || name.startsWith('.')) continue
      walk(rootPath, fullPath, depth + 1, onFile)
    } else {
      onFile(toPosix(relative(rootPath, fullPath)))
    }
  }
}

/**
 * Discover the design-relevant files a run should look at.
 *
 * `scope.mode === 'project'` walks the whole workspace. `scope.mode === 'paths'`
 * treats each entry as either a directory to walk or a single file. A file named
 * explicitly by the user is included even when the walk would have skipped its
 * directory — an explicit choice outranks the skip list — but it must still have
 * a design-relevant extension, or the agent is handed a backend file to critique.
 */
export function discoverDesignFiles(
  workspacePath: string,
  scope: DesignScope
): DesignDiscoveryResult {
  const found = new Set<string>()

  const collect = (relPath: string): void => {
    if (isDesignRelevantPath(relPath)) found.add(relPath)
  }

  try {
    if (scope.mode === 'project' || scope.paths.length === 0) {
      walk(workspacePath, workspacePath, 0, collect)
    } else {
      for (const scopePath of scope.paths) {
        const absolute = resolve(workspacePath, scopePath)
        if (!isInside(workspacePath, absolute)) {
          log.warn(`[design-discovery] scope path escapes the workspace, skipping: ${scopePath}`)
          continue
        }

        let isDir: boolean
        try {
          isDir = statSync(absolute).isDirectory()
        } catch {
          log.warn(`[design-discovery] scope path not found, skipping: ${scopePath}`)
          continue
        }

        if (isDir) {
          walk(workspacePath, absolute, 0, collect)
        } else {
          collect(toPosix(relative(workspacePath, absolute)))
        }
      }
    }
  } catch (err) {
    log.warn(`[design-discovery] error scanning workspace: ${err}`)
  }

  // Sorted so a run is reproducible and round batches are stable across runs.
  const all = [...found].sort()

  log.info(
    `[design-discovery] scope=${scope.mode}: ${all.length} design-relevant file(s), ` +
      `returning ${Math.min(all.length, MAX_DESIGN_FILES)}`
  )

  return { totalFiles: all.length, filePaths: all.slice(0, MAX_DESIGN_FILES) }
}
