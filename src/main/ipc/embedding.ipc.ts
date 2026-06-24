import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { omlxEmbeddingProvider } from '../services/omlx-embedding.service'
import { omlxManager } from '../services/omlx-manager.service'
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
    async (event, args?: { baseUrl?: string; apiKey?: string }): Promise<EmbeddingModelStatus> => {
      validateSender(event)
      const status = await omlxManager.checkStatus(args?.baseUrl, args?.apiKey)
      const embeddingModel = status.allModels?.find(
        (m) => m.loaded && m.modelType === 'embedding'
      )

      // When admin API is unavailable, synthesize allModels from /v1/models
      const allModels = status.allModels ?? []

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
