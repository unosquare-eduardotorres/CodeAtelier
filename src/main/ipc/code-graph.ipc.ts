import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import log from 'electron-log/main'
import { IPC_CHANNELS } from '../../shared/constants'
import { codeGraphService } from '../services/code-graph.service'
import { validateSender } from './validate-sender'
import { workspaceRepository } from '../db/repositories'
import type { CodeGraphIndexingState } from '../../shared/types'
import { libraryDocService } from '../services/library-doc.service'

export function registerCodeGraphIpc(mainWindow: BrowserWindow): void {
  // Forward progress events to renderer
  codeGraphService.on('progress', (state: CodeGraphIndexingState) => {
    mainWindow.webContents.send(IPC_CHANNELS.CODE_GRAPH_PROGRESS, state)
  })

  ipcMain.handle(
    IPC_CHANNELS.CODE_GRAPH_INDEX_START,
    async (event, args: { workspaceId: string }) => {
      validateSender(event)

      const workspace = workspaceRepository.findById(args.workspaceId)
      if (!workspace) throw new Error('Workspace not found')

      const state = codeGraphService.getIndexingState(args.workspaceId)
      if (state.status !== 'idle' && state.status !== 'complete' && state.status !== 'error') {
        throw new Error('Code graph indexing is already in progress')
      }

      // Fire-and-forget — progress events stream to renderer
      codeGraphService
        .indexWorkspace(args.workspaceId, workspace.repoPath)
        .then(() => {
          // Index library documentation in the background after code graph completes
          try {
            const result = libraryDocService.indexWorkspaceDependencies(
              args.workspaceId,
              workspace.repoPath
            )
            log.info(
              `[library-docs] Indexed ${result.indexed}, skipped ${result.skipped}` +
                (result.errors.length > 0 ? `, errors: ${result.errors.length}` : '')
            )
          } catch (e) {
            log.warn(
              `[library-docs] Indexing failed: ${e instanceof Error ? e.message : String(e)}`
            )
          }
        })
        .catch((err) => log.error('[CodeGraph] Indexing pipeline failed:', err))
    }
  )

  ipcMain.handle(IPC_CHANNELS.CODE_GRAPH_GET_STATUS, (event, args: { workspaceId: string }) => {
    validateSender(event)
    return codeGraphService.getIndexingState(args.workspaceId)
  })

  ipcMain.handle(IPC_CHANNELS.CODE_GRAPH_HAS_INDEX, (event, args: { workspaceId: string }) => {
    validateSender(event)
    return codeGraphService.hasPersistedIndex(args.workspaceId)
  })
}
