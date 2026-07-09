/**
 * Memory IPC handlers — knowledge-aware memory engine.
 *
 * All handlers validate sender first (security convention).
 * Replaces old CRUD-based memory IPC with fact-based engine API.
 */

import type { BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ipcMain, dialog } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import type {
  MemoryFactCategory,
  MemoryFactStatus,
  MemoryFactTier,
  ContradictionStatus,
  MemoryCaptureSettings
} from '../../shared/types'
import { memoryFactRepository } from '../db/repositories/memory-fact.repository'
import { memoryRetrievalService } from '../services/memory-retrieval.service'
import { memoryEngineService } from '../services/memory-engine.service'
import { memoryExtractionService } from '../services/memory-extraction.service'
import { omlxEmbeddingProvider } from '../services/omlx-embedding.service'
import { workspaceRepository } from '../db/repositories'
import { memoryDocWatcherService } from '../services/memory-doc-watcher.service'
import { validateSender } from './validate-sender'
import { safeWindowSend } from './safe-send'

export function registerMemoryIpc(mainWindow: BrowserWindow): void {
  // ── Facts CRUD ──

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_FACTS_LIST,
    (event, args: { workspaceId: string; status?: MemoryFactStatus }) => {
      validateSender(event)
      if (args.status) {
        return memoryFactRepository.findByWorkspace(args.workspaceId, args.status)
      }
      return memoryFactRepository.findAllByWorkspace(args.workspaceId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_FACTS_SEARCH,
    async (event, args: { workspaceId: string; query: string; category?: MemoryFactCategory }) => {
      validateSender(event)
      if (!args.query || args.query.trim().length === 0) {
        return memoryFactRepository.findByWorkspace(args.workspaceId)
      }
      const results = await memoryRetrievalService.retrieve(
        args.workspaceId,
        args.query.trim(),
        20,
        args.category
      )
      return results.map((r) => ({ ...r.fact, _score: r.score, _matchType: r.matchType }))
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_FACTS_GET,
    (event, args: { id: string }) => {
      validateSender(event)
      return memoryFactRepository.findById(args.id)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_FACTS_UPDATE,
    (
      event,
      args: {
        id: string
        title?: string
        content?: string
        tags?: string[]
        scopePaths?: string[]
        category?: MemoryFactCategory
      }
    ) => {
      validateSender(event)
      if (!args.id) throw new Error('Fact id is required')
      return memoryFactRepository.updateFact(args.id, args)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_FACTS_ARCHIVE,
    (event, args: { id: string }) => {
      validateSender(event)
      memoryFactRepository.archiveFact(args.id)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_FACTS_CONFIRM,
    (event, args: { id: string }) => {
      validateSender(event)
      return memoryFactRepository.confirmFact(args.id)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_FACTS_PROMOTE,
    (event, args: { id: string; tier: MemoryFactTier }) => {
      validateSender(event)
      return memoryFactRepository.updateFact(args.id, { tier: args.tier })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_FACTS_SCOPE_TOGGLE,
    (event, args: { id: string; global: boolean; workspaceId?: string }) => {
      validateSender(event)
      const fact = memoryFactRepository.findById(args.id)
      if (!fact) throw new Error(`Fact not found: ${args.id}`)
      // Toggle workspace scope: global (null) ↔ workspace-scoped
      const newWorkspaceId = args.global ? null : (args.workspaceId ?? fact.workspaceId ?? null)
      return memoryFactRepository.setWorkspaceScope(args.id, newWorkspaceId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_FACTS_DELETE,
    (event, args: { id: string }) => {
      validateSender(event)
      memoryFactRepository.deleteById(args.id)
    }
  )

  // ── Save from message (hover action) ──

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_SAVE_MESSAGE,
    async (event, args: { workspaceId: string; messageContent: string; workspacePath?: string }) => {
      validateSender(event)
      const { memoryExtractionService } = await import('../services/memory-extraction.service')
      const created = await memoryExtractionService.extractFromMessage(
        args.workspaceId,
        args.messageContent,
        args.workspacePath
      )
      return { created }
    }
  )

  // ── Contradictions ──

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_CONTRADICTIONS_LIST,
    (event, args?: { status?: ContradictionStatus }) => {
      validateSender(event)
      return memoryFactRepository.findContradictions(args?.status)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_CONTRADICTIONS_RESOLVE,
    (
      event,
      args: { id: string; resolution: string; keepFactId: string; archiveFactId?: string }
    ) => {
      validateSender(event)
      const resolved = memoryFactRepository.resolveContradiction(args.id, args.resolution)
      // Optionally archive the losing fact
      if (args.archiveFactId) {
        memoryFactRepository.archiveFact(args.archiveFactId)
      }
      return resolved
    }
  )

  // ── Capture Settings ──

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_CAPTURE_SETTINGS_GET,
    (event, args: { workspaceId: string }) => {
      validateSender(event)
      const settings = workspaceRepository.getSettings(args.workspaceId)
      const memSettings: MemoryCaptureSettings = {
        sessionCapture: (settings as any).memorySessionCapture !== false,
        commitCapture: (settings as any).memoryCommitCapture !== false,
        docCapture: (settings as any).memoryDocCapture !== false,
        watcherGlobs: (settings as any).memoryWatcherGlobs ?? ['docs/**/*.md', 'README.md', 'CLAUDE.md']
      }
      return memSettings
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_CAPTURE_SETTINGS_SET,
    (event, args: { workspaceId: string; settings: Partial<MemoryCaptureSettings> }) => {
      validateSender(event)
      const current = workspaceRepository.getSettings(args.workspaceId)
      const updated = {
        ...current,
        ...(args.settings.sessionCapture !== undefined && { memorySessionCapture: args.settings.sessionCapture }),
        ...(args.settings.commitCapture !== undefined && { memoryCommitCapture: args.settings.commitCapture }),
        ...(args.settings.docCapture !== undefined && { memoryDocCapture: args.settings.docCapture }),
        ...(args.settings.watcherGlobs !== undefined && { memoryWatcherGlobs: args.settings.watcherGlobs })
      }
      workspaceRepository.updateSettings(args.workspaceId, updated)

      // L3-FIX: Start/stop the doc watcher when docCapture changes for the
      // currently-watched workspace. Without this, toggling docCapture off in
      // settings only persists the flag — the watcher keeps running until the
      // next workspace switch.
      if (args.settings.docCapture !== undefined &&
          memoryDocWatcherService.activeWorkspace === args.workspaceId) {
        if (args.settings.docCapture === false) {
          memoryDocWatcherService.stop()
        } else {
          const ws = workspaceRepository.findById(args.workspaceId)
          if (ws?.path) {
            memoryDocWatcherService.start(args.workspaceId, ws.path, (updated as any).memoryWatcherGlobs)
          }
        }
      }
    }
  )

  // ── Embedding Status ──

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_EMBEDDING_STATUS,
    (event, args?: { workspaceId?: string }) => {
      validateSender(event)
      const counts = args?.workspaceId
        ? memoryFactRepository.countByWorkspace(args.workspaceId)
        : { active: 0, superseded: 0, archived: 0, pendingEmbedding: 0 }
      return {
        isReady: omlxEmbeddingProvider.isReady,
        pendingCount: counts.pendingEmbedding,
        totalCount: counts.active + counts.superseded + counts.archived,
        modelName: omlxEmbeddingProvider.isReady ? omlxEmbeddingProvider.activeModelName : null
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_EMBEDDING_BACKFILL,
    async (event) => {
      validateSender(event)
      const count = await memoryEngineService.backfillPendingEmbeddings()
      return { backfilled: count }
    }
  )

  // ── Feed + CLAUDE.md (retained from old system) ──

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_FEED_DOCUMENT,
    async (event, args: { workspacePath: string; filePath: string; workspaceId?: string }) => {
      validateSender(event)
      if (!args.filePath) throw new Error('File path is required')
      const wsId = args.workspaceId ?? workspaceRepository.findByPath(args.workspacePath)?.id
      if (!wsId) throw new Error('Workspace not found')
      const created = await memoryExtractionService.extractFromDocument(
        wsId,
        args.workspacePath,
        args.filePath,
        (progress) => safeWindowSend(mainWindow, IPC_CHANNELS.MEMORY_FEED_PROGRESS, progress)
      )
      return { success: true, source: 'document' as const, memoriesCreated: created }
    }
  )

  ipcMain.handle(IPC_CHANNELS.MEMORY_FEED_CANCEL, (event) => {
    validateSender(event)
    memoryExtractionService.shutdown()
  })

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_REGENERATE_CLAUDE_MD,
    async (event, args: { workspacePath: string }) => {
      validateSender(event)
      if (!args.workspacePath) throw new Error('Workspace path is required')
      let existing: string | null = null
      try {
        existing = readFileSync(join(args.workspacePath, 'CLAUDE.md'), 'utf-8')
      } catch { /* none */ }
      const result = await memoryExtractionService.regenerateClaudeMd(
        args.workspacePath,
        (progress) => safeWindowSend(mainWindow, IPC_CHANNELS.MEMORY_FEED_PROGRESS, progress)
      )
      return { ...result, existing }
    }
  )

  ipcMain.handle(IPC_CHANNELS.MEMORY_SELECT_DOCUMENT, async (event) => {
    validateSender(event)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select a document to extract facts from',
      properties: ['openFile'],
      filters: [
        { name: 'Documents', extensions: ['md', 'txt', 'json', 'yaml', 'yml', 'toml'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
}
