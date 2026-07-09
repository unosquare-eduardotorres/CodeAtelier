/**
 * MemoryDocWatcherService — watches configured file globs for changes,
 * routes through extraction → write pipeline.
 *
 * Gates:
 *   1. 60s debounce per file
 *   2. Content-hash comparison (skip if unchanged)
 *   3. 1h cooldown per file (even if hash changed)
 *
 * Globs are user-editable via capture settings. Defaults:
 *   docs/** /*.md, README.md, CLAUDE.md
 */

import { watch, existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import { dbLogger } from '../logger'
import { memoryExtractionService } from './memory-extraction.service'
import { memoryFactRepository } from '../db/repositories/memory-fact.repository'

const log = dbLogger

const DEFAULT_WATCHER_GLOBS = ['docs/**/*.md', 'README.md', 'CLAUDE.md']
const DEBOUNCE_MS = 60_000 // 60 seconds
const COOLDOWN_MS = 60 * 60 * 1000 // 1 hour

class MemoryDocWatcherService {
  private watchers: Array<ReturnType<typeof watch>> = []
  private debounceTimers = new Map<string, NodeJS.Timeout>()
  private lastProcessed = new Map<string, number>() // filePath → timestamp
  private activeWorkspaceId: string | null = null
  private activeWorkspacePath: string | null = null

  /** The workspace currently being watched (null if idle). */
  get activeWorkspace(): string | null {
    return this.activeWorkspaceId
  }

  /**
   * Start watching docs in a workspace directory.
   * Call stop() before starting a new workspace.
   */
  start(workspaceId: string, workspacePath: string, globs?: string[]): void {
    this.stop()
    this.activeWorkspaceId = workspaceId
    this.activeWorkspacePath = workspacePath

    const patterns = globs ?? DEFAULT_WATCHER_GLOBS

    // Collect all directories that contain files matching our patterns
    const dirsToWatch = new Set<string>()
    for (const pattern of patterns) {
      try {
        const files = this.resolvePattern(workspacePath, pattern)
        for (const relFile of files) {
          const dir = join(workspacePath, relFile).replace(/\/[^/]+$/, '')
          dirsToWatch.add(dir)
        }
        // Top-level patterns (README.md, CLAUDE.md) → watch root
        if (!pattern.includes('/')) dirsToWatch.add(workspacePath)
      } catch (err) {
        log.debug(`[DocWatcher] Failed to resolve pattern ${pattern}:`, err)
      }
    }

    for (const dir of dirsToWatch) {
      if (!existsSync(dir)) continue
      try {
        const watcher = watch(dir, { recursive: false }, (_event, filename) => {
          if (!filename) return
          const fullPath = join(dir, filename)
          const relPath = relative(workspacePath, fullPath)
          if (this.matchesGlob(relPath, patterns)) {
            this.scheduleExtraction(relPath, fullPath)
          }
        })
        this.watchers.push(watcher)
      } catch (err) {
        log.debug(`[DocWatcher] Failed to watch ${dir}:`, err)
      }
    }

    if (this.watchers.length > 0) {
      log.info(`[DocWatcher] Watching ${this.watchers.length} directories for ${patterns.join(', ')}`)
    }
  }

  /** Stop all watchers and clear state. */
  stop(): void {
    for (const w of this.watchers) {
      try { w.close() } catch { /* ignore */ }
    }
    this.watchers = []
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer)
    }
    this.debounceTimers.clear()
    this.activeWorkspaceId = null
    this.activeWorkspacePath = null
  }

  /**
   * Resolve a simple glob pattern to matching file paths relative to cwd.
   * Supports: direct names (README.md), dir/** /*.ext patterns, *.ext.
   * Uses readdirSync to avoid the external `glob` dependency.
   */
  private resolvePattern(cwd: string, pattern: string): string[] {
    const IGNORE = new Set(['node_modules', '.git'])

    // Direct file name (no wildcards)
    if (!pattern.includes('*')) {
      const full = join(cwd, pattern)
      return existsSync(full) ? [pattern] : []
    }

    // docs/**/*.md → prefix = 'docs/', ext = '.md'
    if (pattern.includes('**')) {
      const prefix = pattern.split('**')[0] // 'docs/' or ''
      const suffixPart = pattern.split('**').pop() ?? ''
      const ext = suffixPart.replace(/^\/\*/, '') // '/*.md' → '.md'
      const baseDir = join(cwd, prefix)
      if (!existsSync(baseDir)) return []
      return this.walkDir(baseDir, IGNORE)
        .filter((f) => f.endsWith(ext))
        .map((f) => relative(cwd, f))
    }

    // *.md → top-level files with extension
    if (pattern.startsWith('*.')) {
      const ext = pattern.slice(1)
      try {
        return readdirSync(cwd, { withFileTypes: true })
          .filter((d) => d.isFile() && d.name.endsWith(ext) && !IGNORE.has(d.name))
          .map((d) => d.name)
      } catch { return [] }
    }

    return []
  }

  /** Recursively walk a directory, skipping ignored dirs. */
  private walkDir(dir: string, ignore: Set<string>): string[] {
    const results: string[] = []
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (ignore.has(entry.name)) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          results.push(...this.walkDir(full, ignore))
        } else if (entry.isFile()) {
          results.push(full)
        }
      }
    } catch { /* permission error, etc. */ }
    return results
  }

  /** Simple glob matching — supports *, **, and direct name matches. */
  private matchesGlob(relPath: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
      // Direct name match
      if (pattern === relPath) return true

      // Simple pattern: docs/**/*.md → match any .md in docs/
      if (pattern.includes('**')) {
        const prefix = pattern.split('**')[0]
        const suffixPart = pattern.split('**').pop() ?? ''
        const ext = suffixPart.replace(/^\/\*/, '') // '/*.md' → '.md'
        if (relPath.startsWith(prefix) && relPath.endsWith(ext)) return true
      }

      // Extension wildcard: *.md → match any .md at the right level
      if (pattern.startsWith('*.')) {
        const ext = pattern.slice(1)
        if (relPath.endsWith(ext) && !relPath.includes('/')) return true
      }
    }
    return false
  }

  /** Schedule an extraction with debounce and cooldown gates. */
  private scheduleExtraction(relPath: string, fullPath: string): void {
    // Clear any existing debounce for this file
    const existing = this.debounceTimers.get(relPath)
    if (existing) clearTimeout(existing)

    // Set debounce timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(relPath)
      this.processFileChange(relPath, fullPath).catch((err) =>
        log.warn(`[DocWatcher] Failed to process ${relPath}:`, err)
      )
    }, DEBOUNCE_MS)

    this.debounceTimers.set(relPath, timer)
  }

  /** Process a file change: check cooldown, hash gate, then extract. */
  private async processFileChange(relPath: string, fullPath: string): Promise<void> {
    if (!this.activeWorkspaceId || !this.activeWorkspacePath) return

    // 1. Cooldown check
    const lastTime = this.lastProcessed.get(relPath) ?? 0
    if (Date.now() - lastTime < COOLDOWN_MS) {
      log.debug(`[DocWatcher] Cooldown active for ${relPath}, skipping`)
      return
    }

    // 2. Check file exists and is readable
    if (!existsSync(fullPath)) return
    try {
      const stat = statSync(fullPath)
      if (!stat.isFile() || stat.size === 0) return
    } catch {
      return
    }

    // 3. Content-hash gate
    const content = readFileSync(fullPath, 'utf-8')
    const hash = createHash('sha256').update(content).digest('hex')

    const existing = memoryFactRepository.getDocState(this.activeWorkspaceId, relPath)
    if (existing && existing.contentHash === hash) {
      log.debug(`[DocWatcher] Content unchanged for ${relPath}, skipping`)
      return
    }

    // 4. Extract facts
    log.info(`[DocWatcher] Processing changed doc: ${relPath}`)
    this.lastProcessed.set(relPath, Date.now())

    const created = await memoryExtractionService.extractFromDocument(
      this.activeWorkspaceId,
      this.activeWorkspacePath,
      fullPath
    )

    // 5. Update doc state
    memoryFactRepository.upsertDocState(this.activeWorkspaceId, relPath, hash)

    if (created > 0) {
      log.info(`[DocWatcher] Extracted ${created} facts from ${relPath}`)
    }
  }
}

export const memoryDocWatcherService = new MemoryDocWatcherService()
