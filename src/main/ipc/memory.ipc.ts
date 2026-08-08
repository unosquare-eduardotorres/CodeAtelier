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
import { localEmbeddingProvider } from '../services/local-embedding.provider'
import { workspaceRepository } from '../db/repositories'
import { requireObject, requireString } from './validate-args'

/**
 * Memory capture flags are persisted in the workspace settings JSON blob but are
 * not part of the declared `WorkspaceSettings` shape, so reads go through this
 * view instead of `any` casts at each field.
 */
type MemorySettingsFields = Partial<{
  memorySessionCapture: boolean
  memoryCommitCapture: boolean
  memoryDocCapture: boolean
  memoryCaptureBlueprints: boolean
  memoryCapturePlans: boolean
  memoryCaptureGrill: boolean
  memoryCaptureDocumentsOnAttach: boolean
  memoryCaptureRationales: boolean
  memoryWatcherGlobs: string[]
  memoryInstructionSources: string[]
  memoryReflectionEnabled: boolean
  memoryProjectionEnabled: boolean
  memoryBootstrapConcurrency: number
}>
import { memoryDocWatcherService } from '../services/memory-doc-watcher.service'
import { buildMemoryGraph } from '../services/memory-graph'
import { memoryIngestionService } from '../services/memory-ingestion.service'
import { memoryBootstrapService } from '../services/memory-bootstrap.service'
import { memoryConsolidationService } from '../services/memory-consolidation.service'
import { memoryProjectionService } from '../services/memory-projection.service'
import { memoryReflectionService } from '../services/memory-reflection.service'
import { notificationService } from '../services/notification.service'
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

  ipcMain.handle(IPC_CHANNELS.MEMORY_FACTS_SEARCH, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.MEMORY_FACTS_SEARCH
    const obj = requireObject(rawArgs, ch)
    const workspaceId = requireString(obj, 'workspaceId', ch)
    const query = requireString(obj, 'query', ch)
    const category = obj.category as MemoryFactCategory | undefined
    const results = await memoryRetrievalService.retrieve(workspaceId, query.trim(), 20, category)
    const facts = results.map((r) => r.fact)
    const evidence = memoryFactRepository.getEvidenceCounts(facts.map((f) => f.id))
    return results.map((r) => ({
      ...r.fact,
      evidenceCount: evidence.get(r.fact.id) ?? 0,
      _score: r.score,
      _matchType: r.matchType
    }))
  })

  ipcMain.handle(IPC_CHANNELS.MEMORY_FACTS_GET, (event, args: { id: string }) => {
    validateSender(event)
    return memoryFactRepository.findById(args.id)
  })

  // ── Reflection review queue ──
  // Synthesised parent facts are written archived, so nothing reaches a prompt
  // until it is approved here.

  ipcMain.handle(IPC_CHANNELS.MEMORY_REFLECTION_LIST, (event, args: { workspaceId: string }) => {
    validateSender(event)
    if (!args.workspaceId) throw new Error('workspaceId is required')
    return memoryReflectionService.listPending(args.workspaceId)
  })

  ipcMain.handle(IPC_CHANNELS.MEMORY_REFLECTION_APPROVE, (event, args: { id: string }) => {
    validateSender(event)
    if (!args.id) throw new Error('Fact id is required')
    return memoryReflectionService.approve(args.id)
  })

  ipcMain.handle(IPC_CHANNELS.MEMORY_REFLECTION_REJECT, (event, args: { id: string }) => {
    validateSender(event)
    if (!args.id) throw new Error('Fact id is required')
    memoryReflectionService.reject(args.id)
  })

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_REFLECTION_RUN,
    async (event, args: { workspaceId: string; workspacePath: string }) => {
      validateSender(event)
      if (!args.workspaceId || !args.workspacePath) {
        throw new Error('workspaceId and workspacePath are required')
      }
      return memoryReflectionService.runReflection(args.workspaceId, args.workspacePath)
    }
  )

  // Export the fact database to reviewable markdown under .agentstudio/memory/.
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_PROJECT_EXPORT,
    (event, args: { workspaceId: string; workspacePath: string }) => {
      validateSender(event)
      if (!args.workspaceId || !args.workspacePath) {
        throw new Error('workspaceId and workspacePath are required')
      }
      return memoryProjectionService.project(args.workspaceId, args.workspacePath)
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

  ipcMain.handle(IPC_CHANNELS.MEMORY_FACTS_ARCHIVE, (event, args: { id: string }) => {
    validateSender(event)
    memoryFactRepository.archiveFact(args.id)
  })

  ipcMain.handle(IPC_CHANNELS.MEMORY_FACTS_CONFIRM, (event, args: { id: string }) => {
    validateSender(event)
    return memoryEngineService.confirmFactWithPromotion(args.id)
  })

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

  ipcMain.handle(IPC_CHANNELS.MEMORY_FACTS_DELETE, (event, args: { id: string }) => {
    validateSender(event)
    memoryFactRepository.deleteById(args.id)
  })

  // ── Save from message (hover action) ──

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_SAVE_MESSAGE,
    async (
      event,
      args: { workspaceId: string; messageContent: string; workspacePath?: string }
    ) => {
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

  // ── Save from plan execution completion ──

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_SAVE_PLAN_EXECUTION,
    async (
      event,
      args: {
        workspaceId: string
        workspacePath: string
        conversationId: string
        planTitle: string
        planGoal?: string
        status: 'completed' | 'partial' | 'failed'
        phases: Array<{
          phaseTitle: string
          status: string
          touchedFiles: string[]
          tasks: Array<{ title: string; status: string }>
        }>
        durationMs: number
      }
    ) => {
      validateSender(event)

      // Gate on capturePlans setting
      const settings = workspaceRepository.getSettings(args.workspaceId) as Record<string, unknown>
      if (settings.memoryCapturePlans === false) return { enqueued: false }

      const { memoryExtractionService } = await import('../services/memory-extraction.service')
      memoryExtractionService.enqueuePlanExecutionExtraction(args)
      return { enqueued: true }
    }
  )

  // ── Contradictions ──

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_CONTRADICTIONS_LIST,
    (event, args?: { status?: ContradictionStatus; limit?: number; offset?: number }) => {
      validateSender(event)
      const limit = args?.limit ?? 25
      const offset = args?.offset ?? 0
      const items = memoryFactRepository.findContradictionsPaged(args?.status, limit, offset)
      const total = memoryFactRepository.countContradictions(args?.status)
      const pendingCount = memoryFactRepository.countContradictions('pending')
      return { items, total, pendingCount }
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
      const settings = workspaceRepository.getSettings(args.workspaceId) as MemorySettingsFields
      const memSettings: MemoryCaptureSettings = {
        sessionCapture: settings.memorySessionCapture !== false,
        commitCapture: settings.memoryCommitCapture !== false,
        docCapture: settings.memoryDocCapture !== false,
        captureBlueprints: settings.memoryCaptureBlueprints !== false,
        capturePlans: settings.memoryCapturePlans !== false,
        captureGrill: settings.memoryCaptureGrill !== false,
        captureDocumentsOnAttach: settings.memoryCaptureDocumentsOnAttach !== false,
        // Opt-in, so this one defaults to false rather than true
        captureRationales: settings.memoryCaptureRationales === true,
        watcherGlobs: settings.memoryWatcherGlobs ?? ['docs/**/*.md', 'README.md', 'CLAUDE.md'],
        instructionSources: settings.memoryInstructionSources ?? [],
        // Opt-in: reflection is the only consolidation step that spends money.
        reflectionEnabled: settings.memoryReflectionEnabled === true,
        // Opt-in: this one writes files into the user's working tree.
        projectionEnabled: settings.memoryProjectionEnabled === true,
        bootstrapConcurrency: Number(settings.memoryBootstrapConcurrency) || 3
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
        ...(args.settings.sessionCapture !== undefined && {
          memorySessionCapture: args.settings.sessionCapture
        }),
        ...(args.settings.commitCapture !== undefined && {
          memoryCommitCapture: args.settings.commitCapture
        }),
        ...(args.settings.docCapture !== undefined && {
          memoryDocCapture: args.settings.docCapture
        }),
        ...(args.settings.captureBlueprints !== undefined && {
          memoryCaptureBlueprints: args.settings.captureBlueprints
        }),
        ...(args.settings.capturePlans !== undefined && {
          memoryCapturePlans: args.settings.capturePlans
        }),
        ...(args.settings.captureGrill !== undefined && {
          memoryCaptureGrill: args.settings.captureGrill
        }),
        ...(args.settings.captureDocumentsOnAttach !== undefined && {
          memoryCaptureDocumentsOnAttach: args.settings.captureDocumentsOnAttach
        }),
        ...(args.settings.captureRationales !== undefined && {
          memoryCaptureRationales: args.settings.captureRationales
        }),
        ...(args.settings.watcherGlobs !== undefined && {
          memoryWatcherGlobs: args.settings.watcherGlobs
        }),
        ...(args.settings.instructionSources !== undefined && {
          memoryInstructionSources: args.settings.instructionSources
        }),
        ...(args.settings.reflectionEnabled !== undefined && {
          memoryReflectionEnabled: args.settings.reflectionEnabled
        }),
        ...(args.settings.projectionEnabled !== undefined && {
          memoryProjectionEnabled: args.settings.projectionEnabled
        }),
        ...(args.settings.bootstrapConcurrency !== undefined && {
          memoryBootstrapConcurrency: Math.min(
            6,
            Math.max(1, Math.floor(args.settings.bootstrapConcurrency))
          )
        })
      }
      workspaceRepository.updateSettings(args.workspaceId, updated)

      // L3-FIX: Start/stop the doc watcher when docCapture changes for the
      // currently-watched workspace. Without this, toggling docCapture off in
      // settings only persists the flag — the watcher keeps running until the
      // next workspace switch.
      if (
        args.settings.docCapture !== undefined &&
        memoryDocWatcherService.activeWorkspace === args.workspaceId
      ) {
        if (args.settings.docCapture === false) {
          memoryDocWatcherService.stop()
        } else {
          const ws = workspaceRepository.findById(args.workspaceId)
          if (ws?.repoPath) {
            memoryDocWatcherService.start(
              args.workspaceId,
              ws.repoPath,
              (updated as MemorySettingsFields).memoryWatcherGlobs
            )
          }
        }
      }
    }
  )

  // ── Embedding Status ──

  ipcMain.handle(IPC_CHANNELS.MEMORY_EMBEDDING_STATUS, (event, args?: { workspaceId?: string }) => {
    validateSender(event)
    const counts = args?.workspaceId
      ? memoryFactRepository.countByWorkspace(args.workspaceId)
      : { active: 0, superseded: 0, archived: 0, pendingEmbedding: 0 }
    return {
      isReady: localEmbeddingProvider.isReady,
      pendingCount: counts.pendingEmbedding,
      totalCount: counts.active + counts.superseded + counts.archived,
      activeCount: counts.active,
      modelName: localEmbeddingProvider.isReady ? localEmbeddingProvider.activeModelName : null
    }
  })

  ipcMain.handle(IPC_CHANNELS.MEMORY_EMBEDDING_BACKFILL, async (event) => {
    validateSender(event)

    // Attempt full provider ready (auto-start oMLX, auto-load model) if offline
    if (!localEmbeddingProvider.isReady) {
      const ready = await localEmbeddingProvider.ensureEmbeddingReady()
      if (!ready) {
        const errorMsg =
          'Embedding model could not be initialized. ' +
          'Please ensure oMLX is running with an embedding model downloaded and loaded.'
        // Send done+error so the renderer clears the spinner and shows the real message
        safeWindowSend(mainWindow, IPC_CHANNELS.MEMORY_EMBEDDING_PROGRESS, {
          processed: 0,
          total: 0,
          done: true,
          error: errorMsg
        })
        return { backfilled: 0, error: errorMsg }
      }
    }

    const count = await memoryEngineService.backfillAllPendingEmbeddings((processed, total) => {
      safeWindowSend(mainWindow, IPC_CHANNELS.MEMORY_EMBEDDING_PROGRESS, {
        processed,
        total,
        done: false
      })
    })

    // Send final done signal
    safeWindowSend(mainWindow, IPC_CHANNELS.MEMORY_EMBEDDING_PROGRESS, {
      processed: count,
      total: count,
      done: true
    })

    return { backfilled: count }
  })

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
    async (event, args: { workspacePath: string; workspaceId: string }) => {
      validateSender(event)
      if (!args.workspacePath) throw new Error('Workspace path is required')
      if (!args.workspaceId) throw new Error('Workspace ID is required')
      let existing: string | null = null
      try {
        existing = readFileSync(join(args.workspacePath, 'CLAUDE.md'), 'utf-8')
      } catch {
        /* none */
      }
      const result = await memoryExtractionService.regenerateClaudeMdAgentic(
        args.workspacePath,
        args.workspaceId,
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

  // ── Dedup Scan ──

  ipcMain.handle(IPC_CHANNELS.MEMORY_DEDUP_SCAN, (event, args: { workspaceId: string }) => {
    validateSender(event)
    return memoryEngineService.scanForDuplicates(args.workspaceId)
  })

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_DEDUP_AUTORESOLVE,
    (event, args: { workspaceId: string; minCosine?: number }) => {
      validateSender(event)
      const resolvedCount = memoryFactRepository.bulkAutoResolveDuplicates(args.minCosine ?? 0.95)
      return { resolvedCount }
    }
  )

  // ── Read CLAUDE.md ──

  ipcMain.handle(IPC_CHANNELS.MEMORY_READ_CLAUDE_MD, (event, args: { workspacePath: string }) => {
    validateSender(event)
    const filePath = join(args.workspacePath, 'CLAUDE.md')
    let content: string | null = null
    try {
      content = readFileSync(filePath, 'utf-8')
    } catch {
      /* file doesn't exist */
    }
    return { content, path: filePath }
  })

  // ── Consolidation ──

  ipcMain.handle(IPC_CHANNELS.MEMORY_CONSOLIDATE, async (event, args: { workspaceId: string }) => {
    validateSender(event)
    return memoryConsolidationService.runFullConsolidation(args.workspaceId)
  })

  // ── Knowledge Graph ──

  ipcMain.handle(IPC_CHANNELS.MEMORY_GRAPH_GET, (event, args: { workspaceId: string }) => {
    validateSender(event)
    return buildMemoryGraph(args.workspaceId)
  })

  // ── Document Ingestion ──

  // Select files via native dialog
  ipcMain.handle(IPC_CHANNELS.MEMORY_INGEST_SELECT_FILES, async (event) => {
    validateSender(event)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select documents to ingest into memory',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Documents', extensions: ['md', 'txt', 'pdf', 'docx', 'rst', 'adoc'] },
        {
          name: 'Code',
          extensions: ['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'cs', 'rb']
        },
        { name: 'Config', extensions: ['json', 'yaml', 'yml', 'toml', 'xml', 'sql'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    return result.canceled ? null : result.filePaths
  })

  // Select folder via native dialog
  ipcMain.handle(IPC_CHANNELS.MEMORY_INGEST_SELECT_FOLDER, async (event) => {
    validateSender(event)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select a folder to ingest into memory',
      properties: ['openDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  // Discover files in a folder (returns counts for confirmation)
  ipcMain.handle(IPC_CHANNELS.MEMORY_INGEST_DISCOVER, (event, args: { folderPath: string }) => {
    validateSender(event)
    return memoryIngestionService.discoverFiles(args.folderPath)
  })

  // Start document ingestion (files or folder)
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_INGEST_DOCUMENTS,
    async (event, args: { files: string[]; workspaceId: string; workspacePath: string }) => {
      validateSender(event)
      const { files, workspaceId, workspacePath } = args
      return memoryIngestionService.ingestFiles(files, workspaceId, workspacePath, (progress) =>
        safeWindowSend(mainWindow, IPC_CHANNELS.MEMORY_INGEST_PROGRESS, progress)
      )
    }
  )

  // Cancel ingestion job
  ipcMain.handle(IPC_CHANNELS.MEMORY_INGEST_CANCEL, (event, args: { jobId: string }) => {
    validateSender(event)
    return memoryIngestionService.cancel(args.jobId)
  })

  // ── Bootstrap Service ──

  const forwardBootstrapProgress = (
    progress: import('../../shared/types').BootstrapProgress
  ): void => {
    safeWindowSend(mainWindow, IPC_CHANNELS.MEMORY_BOOTSTRAP_PROGRESS, progress)

    // Ingestion runs for many minutes in the background; tell the user when it
    // lands. notificationService already suppresses this when focused.
    if (progress.jobStatus === 'done' || progress.jobStatus === 'error') {
      try {
        notificationService.dispatch({
          workspaceId: progress.workspaceId,
          workspaceName: workspaceRepository.findById(progress.workspaceId)?.name ?? 'Workspace',
          service: 'memory',
          status: progress.jobStatus === 'done' ? 'completed' : 'failed',
          summary:
            progress.jobStatus === 'done'
              ? `Feed Brain complete — ${progress.factsCreated} memories from ${progress.itemsDone} items`
              : `Feed Brain failed — ${progress.message}`,
          targetPage: 'memory'
        })
      } catch {
        /* non-fatal */
      }
    }
  }

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_BOOTSTRAP_START,
    async (
      event,
      args: {
        workspaceId: string
        workspacePath: string
        mode?: import('../../shared/types').BootstrapMode
        force?: boolean
        scope?: import('../../shared/types').BootstrapScope
      }
    ) => {
      validateSender(event)
      return memoryBootstrapService.startBootstrap(
        args.workspaceId,
        args.workspacePath,
        args.mode ?? 'full',
        forwardBootstrapProgress,
        args.force === true,
        args.scope
      )
    }
  )

  ipcMain.handle(IPC_CHANNELS.MEMORY_BOOTSTRAP_CANCEL, (event, args: { jobId: string }) => {
    validateSender(event)
    return memoryBootstrapService.cancel(args.jobId)
  })

  ipcMain.handle(IPC_CHANNELS.MEMORY_BOOTSTRAP_PAUSE, (event, args: { workspaceId: string }) => {
    validateSender(event)
    return memoryBootstrapService.pause(args.workspaceId)
  })

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_BOOTSTRAP_RESUME,
    async (event, args: { runId: string; workspacePath: string }) => {
      validateSender(event)
      return memoryBootstrapService.resumeRun(
        args.runId,
        args.workspacePath,
        forwardBootstrapProgress
      )
    }
  )

  ipcMain.handle(IPC_CHANNELS.MEMORY_BOOTSTRAP_SNAPSHOT, (event, args: { workspaceId: string }) => {
    validateSender(event)
    return memoryBootstrapService.getSnapshot(args.workspaceId)
  })

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_BOOTSTRAP_LIST_RUNS,
    (event, args: { workspaceId: string; limit?: number }) => {
      validateSender(event)
      return memoryBootstrapService.listRuns(args.workspaceId, args.limit)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_BOOTSTRAP_LIST_ITEMS,
    (
      event,
      args: {
        runId: string
        status?: import('../../shared/types').BootstrapItemStatus
        phase?: import('../../shared/types').BootstrapPhaseLabel
        limit?: number
        offset?: number
      }
    ) => {
      validateSender(event)
      return memoryBootstrapService.listItems(args.runId, {
        status: args.status,
        phase: args.phase,
        limit: args.limit,
        offset: args.offset
      })
    }
  )
}
