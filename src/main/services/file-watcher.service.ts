import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { EventEmitter } from 'node:events'
import log from 'electron-log/main'
import { ATELIERIGNORE_FILENAME, invalidateIgnoreCache } from './workspace-ignore'

const DEBOUNCE_MS = 3000

/** Directories to ignore — never trigger re-indexing */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.output',
  '__pycache__',
  '.cache',
  '.turbo',
  'coverage',
  '.svn',
  '.hg',
  'vendor',
  '.repomap.tags.cache'
])

interface WatcherState {
  watcher: FSWatcher
  workspacePath: string
  pendingChanges: Set<string>
  debounceTimer: ReturnType<typeof setTimeout> | null
  codeGraphEnabled: boolean
  semanticSearchEnabled: boolean
}

export interface FilesChangedEvent {
  workspaceId: string
  workspacePath: string
  changedFiles: string[]
  codeGraphEnabled: boolean
  semanticSearchEnabled: boolean
}

class FileWatcherService extends EventEmitter {
  private watchers = new Map<string, WatcherState>()

  /**
   * Start watching a workspace directory.
   * If already watching, updates the feature flags without restarting.
   */
  start(
    workspaceId: string,
    workspacePath: string,
    options: {
      codeGraphEnabled: boolean
      semanticSearchEnabled: boolean
    }
  ): void {
    const existing = this.watchers.get(workspaceId)
    if (existing) {
      existing.codeGraphEnabled = options.codeGraphEnabled
      existing.semanticSearchEnabled = options.semanticSearchEnabled
      if (!options.codeGraphEnabled && !options.semanticSearchEnabled) {
        this.stop(workspaceId)
      }
      return
    }

    if (!options.codeGraphEnabled && !options.semanticSearchEnabled) return

    try {
      const watcher = watch(workspacePath, { recursive: true }, (_eventType, filename) => {
        if (!filename) return
        // Editing .atelierignore changes what is indexable — drop the cached
        // rules immediately so the next re-index honors the new exclusions
        // without requiring an app restart.
        const normalized = filename.replace(/\\/g, '/')
        if (
          normalized === ATELIERIGNORE_FILENAME ||
          normalized.endsWith(`/${ATELIERIGNORE_FILENAME}`)
        ) {
          invalidateIgnoreCache(workspacePath)
          log.info('[FileWatcher] .atelierignore changed — exclusion cache invalidated')
          return
        }
        this.handleFileEvent(workspaceId, filename)
      })

      watcher.on('error', (err) => {
        log.warn(`[FileWatcher] Error for workspace ${workspaceId}:`, err)
      })

      this.watchers.set(workspaceId, {
        watcher,
        workspacePath,
        pendingChanges: new Set(),
        debounceTimer: null,
        ...options
      })
      log.info(`[FileWatcher] Watching: ${workspacePath}`)
    } catch (err) {
      log.error(`[FileWatcher] Failed to start:`, err)
    }
  }

  /**
   * Stop watching a workspace.
   */
  stop(workspaceId: string): void {
    const state = this.watchers.get(workspaceId)
    if (!state) return
    state.watcher.close()
    if (state.debounceTimer) clearTimeout(state.debounceTimer)
    this.watchers.delete(workspaceId)
    log.info(`[FileWatcher] Stopped watching workspace ${workspaceId}`)
  }

  private handleFileEvent(workspaceId: string, filename: string): void {
    // Skip ignored directories
    // Split on both forward and backslash separators for Windows compatibility.
    // On Windows, fs.watch returns paths with native backslash separators,
    // so split('/') would produce one unsplit segment and never match IGNORED_DIRS.
    const parts = filename.split(/[/\\]/)
    if (parts.some((p) => IGNORED_DIRS.has(p.toLowerCase()))) return

    const state = this.watchers.get(workspaceId)
    if (!state) return

    state.pendingChanges.add(filename)

    // Reset debounce timer
    if (state.debounceTimer) clearTimeout(state.debounceTimer)
    state.debounceTimer = setTimeout(() => this.flush(workspaceId), DEBOUNCE_MS)
  }

  private flush(workspaceId: string): void {
    const state = this.watchers.get(workspaceId)
    if (!state || state.pendingChanges.size === 0) return

    const changedFiles = [...state.pendingChanges]
    state.pendingChanges.clear()
    state.debounceTimer = null

    this.emit('files-changed', {
      workspaceId,
      workspacePath: state.workspacePath,
      changedFiles,
      codeGraphEnabled: state.codeGraphEnabled,
      semanticSearchEnabled: state.semanticSearchEnabled
    } satisfies FilesChangedEvent)
  }

  /** Stop all watchers — called on app quit */
  stopAll(): void {
    for (const id of [...this.watchers.keys()]) this.stop(id)
  }

  /**
   * Snapshot currently-active watchers (workspaceId + settings).
   * Used by power management to capture state before stopAll(),
   * so watchers can be recreated after wake.
   */
  getActiveWatchers(): {
    workspaceId: string
    workspacePath: string
    codeGraphEnabled: boolean
    semanticSearchEnabled: boolean
  }[] {
    return [...this.watchers.entries()].map(([id, state]) => ({
      workspaceId: id,
      workspacePath: state.workspacePath,
      codeGraphEnabled: state.codeGraphEnabled,
      semanticSearchEnabled: state.semanticSearchEnabled
    }))
  }
}

export const fileWatcherService = new FileWatcherService()
