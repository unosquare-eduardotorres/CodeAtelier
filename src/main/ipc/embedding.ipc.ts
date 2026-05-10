import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { embeddingProvider } from '../services/embedding-provider.service'
import { validateSender } from './validate-sender'

export function registerEmbeddingIpc(mainWindow: BrowserWindow): void {
  // Forward model download progress to renderer
  embeddingProvider.on('modelDownloadProgress', (progress) => {
    mainWindow.webContents.send(IPC_CHANNELS.EMBEDDING_MODEL_PROGRESS, progress)
  })
  embeddingProvider.on('modelReady', () => {
    mainWindow.webContents.send(IPC_CHANNELS.EMBEDDING_MODEL_READY)
  })
  embeddingProvider.on('modelError', (error: string) => {
    mainWindow.webContents.send(IPC_CHANNELS.EMBEDDING_MODEL_ERROR, error)
  })

  ipcMain.handle(IPC_CHANNELS.EMBEDDING_CHECK_STATUS, async (event) => {
    validateSender(event)
    return {
      ready: embeddingProvider.isReady,
      cached: await embeddingProvider.isModelCached()
    }
  })

  ipcMain.handle(IPC_CHANNELS.EMBEDDING_INITIALIZE, async (event) => {
    validateSender(event)
    await embeddingProvider.initialize()
  })
}
