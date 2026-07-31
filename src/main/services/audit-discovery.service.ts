/**
 * Audit Discovery Service — enumerates auditable files per track.
 *
 * Before running the actual audit, discovers all relevant files for a
 * given audit track using pattern matching and heuristics. This provides:
 *   - The denominator for coverage percent (filesInspected / totalFiles)
 *   - Priority ordering (critical files first)
 *   - File batches for multi-round audit orchestration
 *
 * Pure file-system enumeration — no LLM calls. Uses Node.js built-in
 * readdirSync + extname + pattern matching (no glob dependency).
 */

import { readdirSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'
import log from 'electron-log'
import type { AuditTrackId } from '../../shared/types'

const discoveryLog = log.scope('audit-discovery')

export interface AuditDiscoveryResult {
  totalFiles: number
  filePaths: string[] // All relevant files (workspace-relative)
  priorityFiles: string[] // Critical files to inspect first
}

/** Directories to always skip. */
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

/** Max files to return per track (avoid overwhelming the auditor). */
const MAX_FILES_PER_TRACK = 100

/** Max directory depth to recurse. */
const MAX_DEPTH = 10

/**
 * Discover all auditable files for a given track in the workspace.
 * Returns workspace-relative paths sorted with priority files first.
 */
export function discoverAuditableFiles(
  workspacePath: string,
  trackId: AuditTrackId
): AuditDiscoveryResult {
  const config = TRACK_FILE_CONFIG[trackId]
  if (!config) {
    return { totalFiles: 0, filePaths: [], priorityFiles: [] }
  }

  const allFiles: string[] = []

  try {
    walkDirectory(workspacePath, workspacePath, 0, (relPath) => {
      if (matchesTrack(relPath, config)) {
        allFiles.push(relPath)
      }
    })
  } catch (err) {
    discoveryLog.warn(`[audit-discovery] Error scanning workspace: ${err}`)
  }

  // Identify priority files
  const priorityFiles: string[] = []
  if (config.priorityPatterns) {
    for (const f of allFiles) {
      if (config.priorityPatterns.some((p) => f.toLowerCase().includes(p.toLowerCase()))) {
        priorityFiles.push(f)
      }
    }
  }

  // Sort: priority files first, then alphabetical
  const prioritySet = new Set(priorityFiles)
  const sorted = [...priorityFiles, ...allFiles.filter((f) => !prioritySet.has(f)).sort()]

  // Cap total files
  const capped = sorted.slice(0, MAX_FILES_PER_TRACK)

  discoveryLog.info(
    `[audit-discovery] Track=${trackId}: ${allFiles.length} total files, ${priorityFiles.length} priority, returning ${capped.length}`
  )

  return {
    totalFiles: allFiles.length,
    filePaths: capped,
    priorityFiles
  }
}

// ── Recursive directory walker ───────────────────────────────────────────

function walkDirectory(
  rootPath: string,
  currentPath: string,
  depth: number,
  callback: (relPath: string) => void
): void {
  if (depth > MAX_DEPTH) return

  let entries: string[]
  try {
    entries = readdirSync(currentPath) as unknown as string[]
  } catch {
    return // Permission denied or similar
  }

  for (const entryName of entries) {
    const name = String(entryName)
    const fullPath = join(currentPath, name)

    // Check if directory
    let isDir = false
    try {
      isDir = statSync(fullPath).isDirectory()
    } catch {
      continue // inaccessible entry
    }

    if (isDir) {
      if (SKIP_DIRS.has(name.toLowerCase()) || name.startsWith('.')) continue
      walkDirectory(rootPath, fullPath, depth + 1, callback)
    } else {
      const relPath = relative(rootPath, fullPath)
      callback(relPath)
    }
  }
}

// ── Pattern matching ─────────────────────────────────────────────────────

interface TrackFileConfig {
  /** File extensions to include (e.g. ['.ts', '.tsx']) */
  extensions: string[]
  /** Path substrings that must match (OR logic). Empty = match all with matching extension. */
  pathIncludes?: string[]
  /** Path substrings to exclude (any match = skip). */
  pathExcludes?: string[]
  /** Basename patterns for priority ordering. */
  priorityPatterns?: string[]
}

function matchesTrack(relPath: string, config: TrackFileConfig): boolean {
  const ext = extname(relPath).toLowerCase()

  // Must match at least one extension
  if (!config.extensions.includes(ext)) return false

  // Check exclusions
  if (config.pathExcludes) {
    const lower = relPath.toLowerCase()
    if (config.pathExcludes.some((ex) => lower.includes(ex.toLowerCase()))) return false
  }

  // Check path includes (if specified, at least one must match)
  if (config.pathIncludes && config.pathIncludes.length > 0) {
    const lower = relPath.toLowerCase()
    if (!config.pathIncludes.some((inc) => lower.includes(inc.toLowerCase()))) return false
  }

  return true
}

// ── Per-track file configuration ─────────────────────────────────────────

const TRACK_FILE_CONFIG: Record<AuditTrackId, TrackFileConfig> = {
  database: {
    extensions: ['.sql', '.ts', '.js', '.prisma'],
    pathIncludes: [
      'migration',
      'repository',
      'repositories',
      'model',
      'models',
      'entity',
      'entities',
      'schema',
      'prisma',
      'drizzle',
      'db/',
      'database'
    ],
    priorityPatterns: ['schema', 'migration', 'index.ts']
  },

  code: {
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
    pathExcludes: ['.test.', '.spec.', '__tests__', '/test/', '/tests/', '.d.ts', '.config.'],
    priorityPatterns: ['index.ts', 'index.tsx', 'main.ts', 'app.ts', 'server.ts']
  },

  testing: {
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json', '.mjs', '.cjs'],
    pathIncludes: [
      '.test.',
      '.spec.',
      '__tests__',
      '/test/',
      '/tests/',
      'jest.config',
      'vitest.config',
      'playwright.config',
      'cypress.config'
    ],
    priorityPatterns: ['config', 'setup', 'helper', 'fixture']
  },

  architecture: {
    extensions: ['.ts', '.js', '.json', '.mjs', '.cjs'],
    pathIncludes: [
      'package.json',
      'tsconfig',
      'index.ts',
      'index.js',
      '/routes/',
      '/ipc/',
      '/services/',
      'types.ts',
      'constants.ts',
      '.config.'
    ],
    priorityPatterns: ['package.json', 'tsconfig', 'index.ts', 'types.ts', 'constants.ts']
  },

  security: {
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.env', '.yml', '.yaml'],
    pathIncludes: [
      'auth',
      'security',
      'csp',
      'preload',
      'sanitize',
      'validate',
      '.env',
      'middleware',
      'Dockerfile',
      'docker-compose'
    ],
    priorityPatterns: ['auth', 'security', 'csp', 'preload', '.env', 'middleware']
  },

  documentation: {
    extensions: ['.md', '.mdx', '.yml', '.yaml'],
    pathExcludes: ['node_modules', 'CHANGELOG'],
    priorityPatterns: ['README', 'CLAUDE.md', 'docs/', 'CONTRIBUTING']
  },

  'ui-ux': {
    extensions: ['.tsx', '.jsx', '.css', '.scss'],
    pathIncludes: ['component', 'page', 'layout', 'style', 'theme'],
    pathExcludes: ['.test.', '.spec.', '__tests__'],
    priorityPatterns: ['App.tsx', 'Layout', 'index.tsx', 'theme', 'global']
  }
}
