import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { IPC_CHANNELS, OMLX_DEFAULT_PORT } from '../../shared/constants'
import { omlxEmbeddingProvider } from '../services/omlx-embedding.service'
import { omlxManager } from '../services/omlx-manager.service'
import { workspaceRepository } from '../db/repositories'
import { validateSender } from './validate-sender'
import type { EmbeddingModelStatus } from '../../shared/types'

export function registerEmbeddingIpc(mainWindow: BrowserWindow): void {
  // Forward oMLX embedding events to the renderer
  omlxEmbeddingProvider.on('modelReady', () => {
    mainWindow.webContents.send(IPC_CHANNELS.EMBEDDING_MODEL_READY)
  })
  omlxEmbeddingProvider.on('modelError', (error: string) => {
    mainWindow.webContents.send(IPC_CHANNELS.EMBEDDING_MODEL_ERROR, error)
  })

  ipcMain.handle(
    IPC_CHANNELS.EMBEDDING_CHECK_STATUS,
    async (event, args?: { baseUrl?: string; apiKey?: string; workspaceId?: string }): Promise<EmbeddingModelStatus> => {
      validateSender(event)

      // Resolve config: explicit args → workspace settings → defaults
      let resolvedBaseUrl = args?.baseUrl
      let resolvedApiKey = args?.apiKey
      if (!resolvedBaseUrl && args?.workspaceId) {
        try {
          const settings = workspaceRepository.getSettings(args.workspaceId)
          const host = (settings?.localHost as string) ?? '127.0.0.1'
          const port = (settings?.localPort as number) ?? OMLX_DEFAULT_PORT
          resolvedBaseUrl = `http://${host}:${port}`
          if (!resolvedApiKey && settings?.localApiKey) {
            resolvedApiKey = settings.localApiKey as string
          }
        } catch {
          // Fall through to defaults
        }
      }

      const status = await omlxManager.checkStatus(resolvedBaseUrl, resolvedApiKey)
      const embeddingModel = status.allModels?.find(
        (m) => m.loaded && m.modelType === 'embedding'
      )

      // When admin API is unavailable, synthesize allModels from /v1/models
      const allModels = status.allModels ?? []

      // Auto-initialize embedding provider when a loaded embedding model is found
      // but the provider hasn't been initialized yet
      if (embeddingModel?.loaded && !omlxEmbeddingProvider.isReady) {
        omlxEmbeddingProvider
          .initialize(resolvedBaseUrl, resolvedApiKey)
          .catch(() => { /* non-fatal — UI will show the model status regardless */ })
      }

      return {
        ready: omlxEmbeddingProvider.isReady,
        backend: 'omlx',
        omlxRunning: status.running,
        omlxInstalled: status.installed,
        omlxEmbeddingModelId: embeddingModel?.id ?? null,
        omlxEmbeddingModelLoaded: !!embeddingModel?.loaded,
        omlxAllModels: allModels.length > 0 ? allModels : undefined,
        omlxAdminApiAvailable: !!status.allModels
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.EMBEDDING_INITIALIZE, async (event, args?: { baseUrl?: string; apiKey?: string }) => {
    validateSender(event)
    await omlxEmbeddingProvider.initialize(args?.baseUrl, args?.apiKey)
  })
}
