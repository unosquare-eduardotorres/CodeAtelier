import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { EventEmitter } from 'node:events'
import log from 'electron-log/main'

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

  /**
   * Update feature flags for an active watcher.
   * If both flags are OFF, stops the watcher entirely.
   */
  updateFlags(
    workspaceId: string,
    flags: {
      codeGraphEnabled?: boolean
      semanticSearchEnabled?: boolean
    }
  ): void {
    const state = this.watchers.get(workspaceId)
    if (!state) return
    if (flags.codeGraphEnabled !== undefined) state.codeGraphEnabled = flags.codeGraphEnabled
    if (flags.semanticSearchEnabled !== undefined)
      state.semanticSearchEnabled = flags.semanticSearchEnabled
    if (!state.codeGraphEnabled && !state.semanticSearchEnabled) this.stop(workspaceId)
  }

  private handleFileEvent(workspaceId: string, filename: string): void {
    // Skip ignored directories
    const parts = filename.split('/')
    if (parts.some((p) => IGNORED_DIRS.has(p))) return

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
}

export const fileWatcherService = new FileWatcherService()
