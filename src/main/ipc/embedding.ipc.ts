import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { llamafileEmbeddingProvider } from '../services/llamafile-embedding.service'
import { llamafileDownloadService } from '../services/llamafile-download.service'
import { validateSender } from './validate-sender'
import { safeWindowSend } from './safe-send'
import type { EmbeddingModelStatus } from '../../shared/types'

export function registerEmbeddingIpc(mainWindow: BrowserWindow): void {
  // Forward download progress (binary + model phases) to the renderer.
  llamafileEmbeddingProvider.on('modelDownloadProgress', (progress) => {
    safeWindowSend(mainWindow, IPC_CHANNELS.EMBEDDING_MODEL_PROGRESS, progress)
  })
  llamafileEmbeddingProvider.on('modelReady', () => {
    safeWindowSend(mainWindow, IPC_CHANNELS.EMBEDDING_MODEL_READY)
  })
  llamafileEmbeddingProvider.on('modelError', (error: string) => {
    safeWindowSend(mainWindow, IPC_CHANNELS.EMBEDDING_MODEL_ERROR, error)
  })

  ipcMain.handle(
    IPC_CHANNELS.EMBEDDING_CHECK_STATUS,
    async (event): Promise<EmbeddingModelStatus> => {
      validateSender(event)
      const engineInstalled = llamafileDownloadService.isEngineInstalled()
      const modelInstalled = llamafileDownloadService.isModelInstalled()
      return {
        ready: llamafileEmbeddingProvider.isReady,
        cached: engineInstalled && modelInstalled,
        backend: 'llamafile',
        engineInstalled,
        modelInstalled
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.EMBEDDING_INITIALIZE, async (event) => {
    validateSender(event)
    await llamafileEmbeddingProvider.initialize()
  })
}
