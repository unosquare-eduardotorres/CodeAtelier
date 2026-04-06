import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { statSync } from 'node:fs'
import log from 'electron-log/main'
import { IPC_CHANNELS } from '../../shared/constants'
import { vectorSearchService } from '../services/vector-search.service'
import { validateSender } from './validate-sender'
import { workspaceRepository, codeChunkRepository } from '../db/repositories'
import { convertTagsToChunks } from '../services/tag-to-chunk-adapter'
import type { IndexingState } from '../../shared/types'

export function registerIndexingIpc(mainWindow: BrowserWindow): void {
  // Forward indexing progress events to the renderer
  vectorSearchService.on('progress', (state: IndexingState) => {
    mainWindow.webContents.send(IPC_CHANNELS.INDEXING_PROGRESS, state)
  })

  ipcMain.handle(IPC_CHANNELS.INDEXING_START, async (event, args: { workspaceId: string }) => {
    validateSender(event)

    const state = vectorSearchService.getIndexingState(args.workspaceId)
    if (state.status !== 'idle' && state.status !== 'complete' && state.status !== 'error') {
      throw new Error('Indexing is already in progress')
    }

    // Get workspace path
    const workspace = workspaceRepository.findById(args.workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const settings = JSON.parse(workspace.settingsJson || '{}')

    // Get repomap tags via tree-sitter (dynamic import for lazy loading)
    const { getTags, initParser } =
      (await import('repomap-mcp/dist/tags.js')) as typeof import('repomap-mcp/dist/tags.js')
    const { findSrcFiles } =
      (await import('repomap-mcp/dist/file-discovery.js')) as typeof import('repomap-mcp/dist/file-discovery.js')

    await initParser()

    log.info(`[Indexing] Scanning workspace: ${workspace.repoPath}`)
    const files = findSrcFiles(workspace.repoPath)
    log.info(`[Indexing] Found ${files.length} source files`)

    // Load existing file mtimes from persisted chunks for incremental skip
    const existingMtimes = codeChunkRepository.getFileMtimes(args.workspaceId)

    const allTags: Array<{
      relFname: string
      fname: string
      line: number
      name: string
      kind: 'def' | 'ref'
    }> = []

    let skippedFiles = 0
    const currentFiles = new Set<string>()

    for (const file of files) {
      const relPath = file.replace(workspace.repoPath + '/', '')
      currentFiles.add(relPath)

      try {
        const stat = statSync(file)
        const existingMtime = existingMtimes.get(relPath)

        // Skip files that haven't changed since last index
        if (existingMtime && stat.mtimeMs === existingMtime) {
          skippedFiles++
          continue
        }

        const tags = await getTags(file, relPath, null, false)
        allTags.push(...tags)
      } catch (err) {
        log.warn(`[Indexing] Failed to get tags for ${relPath}:`, err)
      }
    }

    // Delete stale chunks for files that no longer exist
    for (const [existingFile] of existingMtimes) {
      if (!currentFiles.has(existingFile)) {
        codeChunkRepository.deleteByFile(args.workspaceId, existingFile)
      }
    }

    log.info(
      `[Indexing] Extracted ${allTags.length} tags from ${files.length} files (${skippedFiles} unchanged, skipped)`
    )

    // Convert to RawChunks
    const { chunks, fileContents } = convertTagsToChunks(allTags, workspace.repoPath)

    log.info(`[Indexing] Starting indexing pipeline with ${chunks.length} chunks`)

    // Start indexing (async — fires progress events via EventEmitter)
    const indexingOptions = {
      generateDescriptions: !!settings.semanticSearchDescriptions,
      descriptionModel: (settings.descriptionModel as string) || 'claude-haiku-4-5-20251001',
      ollamaModel: (settings.ollamaModel as string) || 'qwen3-embedding:4b'
    }
    vectorSearchService
      .indexProject(args.workspaceId, workspace.repoPath, chunks, fileContents, indexingOptions)
      .catch((err) => {
        log.error('[Indexing] Pipeline failed:', err)
      })
  })

  ipcMain.handle(IPC_CHANNELS.INDEXING_PAUSE, (event, args: { workspaceId: string }) => {
    validateSender(event)
    vectorSearchService.pauseIndexing(args.workspaceId)
  })

  ipcMain.handle(IPC_CHANNELS.INDEXING_RESUME, (event, args: { workspaceId: string }) => {
    validateSender(event)
    vectorSearchService.resumeIndexing(args.workspaceId)
  })

  ipcMain.handle(IPC_CHANNELS.INDEXING_CANCEL, (event, args: { workspaceId: string }) => {
    validateSender(event)
    vectorSearchService.cancelIndexing(args.workspaceId)
  })

  ipcMain.handle(IPC_CHANNELS.INDEXING_GET_STATUS, (event, args: { workspaceId: string }) => {
    validateSender(event)
    return vectorSearchService.getIndexingState(args.workspaceId)
  })

  ipcMain.handle(
    IPC_CHANNELS.INDEXING_LOAD_PERSISTED,
    async (event, args: { workspaceId: string }) => {
      validateSender(event)
      const hasPersisted = vectorSearchService.hasPersistedIndex(args.workspaceId)
      if (hasPersisted) {
        const { symbolCount } = await vectorSearchService.loadPersistedIndex(args.workspaceId)
        return { loaded: true, status: 'complete', symbolCount }
      }
      return { loaded: false, status: 'idle' }
    }
  )

}
