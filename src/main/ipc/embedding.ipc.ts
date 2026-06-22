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
    async (event): Promise<EmbeddingModelStatus> => {
      validateSender(event)
      const status = await omlxManager.checkStatus()
      const embeddingModel = status.allModels?.find(
        (m) => m.loaded && m.modelType === 'embedding'
      )
      return {
        ready: omlxEmbeddingProvider.isReady,
        backend: 'omlx',
        omlxRunning: status.running,
        omlxEmbeddingModelId: embeddingModel?.id ?? null,
        omlxEmbeddingModelLoaded: !!embeddingModel?.loaded
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.EMBEDDING_INITIALIZE, async (event) => {
    validateSender(event)
    await omlxEmbeddingProvider.initialize()
  })
}
