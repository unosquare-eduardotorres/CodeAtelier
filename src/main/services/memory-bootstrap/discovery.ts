/**
 * Filesystem discovery for the bootstrap planner.
 *
 * Pure, side-effect-free reads: no LLM calls, no database writes. This is what
 * makes the PLAN phase cheap enough to run up front, which in turn is what
 * makes the item total knowable before any extraction starts.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, basename } from 'node:path'
import {
  IGNORE_DIRS,
  DOC_PATTERNS,
  DOC_DIRS,
  MANIFEST_FILES,
  MAX_SCATTERED_DOCS,
  MAX_SCATTERED_DOC_DEPTH
} from './constants'

/** Discover documentation files in the workspace. */
export function discoverDocs(workspacePath: string): string[] {
  const found: string[] = []

  // Root-level doc files
  for (const pattern of DOC_PATTERNS) {
    const fullPath = join(workspacePath, pattern)
    if (existsSync(fullPath)) {
      found.push(fullPath)
    }
  }

  // Root-level *.md (excluding already found)
  try {
    const rootEntries = readdirSync(workspacePath)
    for (const entry of rootEntries) {
      if (entry.endsWith('.md') && !found.some((f) => basename(f) === entry)) {
        const fullPath = join(workspacePath, entry)
        try {
          if (statSync(fullPath).isFile()) found.push(fullPath)
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }

  // Doc directories
  for (const dir of DOC_DIRS) {
    const dirPath = join(workspacePath, dir)
    walkForMd(dirPath, found, 0)
  }

  // ADR directories
  try {
    findAdrDirs(workspacePath, found, 0)
  } catch { /* skip */ }

  // Scattered docs: find .md files outside standard doc dirs
  discoverScatteredDocs(workspacePath, found, MAX_SCATTERED_DOCS)

  return [...new Set(found)] // deduplicate
}

export function walkForMd(
  dirPath: string,
  files: string[],
  depth: number,
  maxFiles: number = MAX_SCATTERED_DOCS
): void {
  if (depth > 5 || files.length >= maxFiles) return
  if (!existsSync(dirPath)) return

  try {
    const entries = readdirSync(dirPath)
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.toLowerCase())) continue
      const fullPath = join(dirPath, entry)
      try {
        const stat = statSync(fullPath)
        if (stat.isDirectory()) {
          walkForMd(fullPath, files, depth + 1, maxFiles)
        } else if (stat.isFile() && /\.(md|txt|rst|adoc)$/i.test(entry)) {
          files.push(fullPath)
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
}

export function findAdrDirs(dirPath: string, files: string[], depth: number): void {
  if (depth > 3) return

  try {
    const entries = readdirSync(dirPath)
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.toLowerCase())) continue
      const fullPath = join(dirPath, entry)
      try {
        const stat = statSync(fullPath)
        if (stat.isDirectory()) {
          if (/adr/i.test(entry)) {
            walkForMd(fullPath, files, 0)
          } else if (depth < 2) {
            findAdrDirs(fullPath, files, depth + 1)
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
}

/** Find .md files outside standard doc dirs (e.g. feature/README.md) */
export function discoverScatteredDocs(
  rootPath: string,
  files: string[],
  maxFiles: number
): void {
  if (files.length >= maxFiles) return

  const seen = new Set(files) // O(1) lookups instead of O(n) includes()

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_SCATTERED_DOC_DEPTH || files.length >= maxFiles) return
    try {
      const entries = readdirSync(dir)
      for (const entry of entries) {
        if (IGNORE_DIRS.has(entry.toLowerCase())) continue
        const fullPath = join(dir, entry)
        try {
          const stat = statSync(fullPath)
          if (stat.isDirectory()) {
            walk(fullPath, depth + 1)
          } else if (
            stat.isFile() &&
            /\.(md|mdx)$/i.test(entry) &&
            stat.size > 500 && // skip tiny stubs
            !seen.has(fullPath)
          ) {
            files.push(fullPath)
            seen.add(fullPath)
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  walk(rootPath, 0)
}

/** Read a file with a size cap, returning null if missing or too large. */
export function readCapped(filePath: string, maxBytes: number = 15000): string | null {
  try {
    if (!existsSync(filePath)) return null
    const stat = statSync(filePath)
    if (!stat.isFile() || stat.size > maxBytes * 3) return null
    const content = readFileSync(filePath, 'utf-8')
    return content.substring(0, maxBytes)
  } catch {
    return null
  }
}

/** Collect and concatenate manifest file contents for stack analysis. */
export function collectManifests(workspacePath: string): string {
  const parts: string[] = []

  for (const pattern of MANIFEST_FILES) {
    if (pattern.includes('*')) {
      // Glob-like: expand manually for workflow files
      const dir = join(workspacePath, pattern.replace(/\/\*.*/, ''))
      const ext = pattern.split('*.').pop() ?? ''
      try {
        if (existsSync(dir)) {
          for (const entry of readdirSync(dir)) {
            if (entry.endsWith(`.${ext}`)) {
              const content = readCapped(join(dir, entry))
              if (content) parts.push(`## ${pattern.replace('*', entry)}\n${content}`)
            }
          }
        }
      } catch { /* skip */ }
    } else {
      const fullPath = join(workspacePath, pattern)
      const content = readCapped(fullPath)
      if (content) parts.push(`## ${pattern}\n${content}`)
    }
  }

  // Also detect schema file
  const schemaPatterns = [
    'src/main/db/schema.sql', 'schema.sql', 'db/schema.sql',
    'prisma/schema.prisma', 'drizzle/schema.ts'
  ]
  for (const sp of schemaPatterns) {
    const content = readCapped(join(workspacePath, sp), 10000)
    if (content) {
      parts.push(`## ${sp}\n${content}`)
      break
    }
  }

  // Migration directory listing
  const migrationDirs = [
    'src/main/db/migrations', 'migrations', 'db/migrations',
    'prisma/migrations', 'drizzle/migrations'
  ]
  for (const md of migrationDirs) {
    const dirPath = join(workspacePath, md)
    try {
      if (existsSync(dirPath)) {
        const entries = readdirSync(dirPath).sort().slice(-20) // last 20 migrations
        parts.push(`## ${md} (last 20 entries)\n${entries.join('\n')}`)
        break
      }
    } catch { /* skip */ }
  }

  return parts.join('\n\n').substring(0, 50000)
}

/** Get files changed since a specific commit. */
export function getChangedFilesSinceCommit(
  workspacePath: string,
  sinceCommit: string
): Set<string> {
  try {
    const output = execSync(`git diff --name-only ${sinceCommit}..HEAD`, {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    }).trim()

    return new Set(output.split('\n').filter(Boolean))
  } catch {
    return new Set()
  }
}

/** Current HEAD sha, or null when this is not a git working tree. */
export function readHeadSha(workspacePath: string): string | null {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true
    }).trim()
  } catch {
    return null
  }
}

/** Rough project size metrics used to size the Deep Scan agent budget. */
export function estimateProjectComplexity(workspacePath: string): {
  fileCount: number
  docCount: number
  hasDeepDocs: boolean
  codebaseSize: 'small' | 'medium' | 'large'
} {
  let fileCount = 0
  let docCount = 0
  let hasDeepDocs = false

  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || fileCount > 5000) return
    try {
      for (const entry of readdirSync(dir)) {
        if (IGNORE_DIRS.has(entry.toLowerCase())) continue
        const full = join(dir, entry)
        try {
          const stat = statSync(full)
          if (stat.isDirectory()) {
            walk(full, depth + 1)
          } else if (stat.isFile()) {
            fileCount++
            if (/\.(md|mdx|txt|rst|adoc)$/i.test(entry)) {
              docCount++
              if (stat.size > 10_000) hasDeepDocs = true
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  walk(workspacePath, 0)

  const codebaseSize = fileCount > 2000 ? 'large' : fileCount > 500 ? 'medium' : 'small'
  return { fileCount, docCount, hasDeepDocs, codebaseSize }
}
