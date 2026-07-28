import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { IPC_CHANNELS, OMLX_DEFAULT_PORT, OLLAMA_DEFAULT_PORT } from '../../shared/constants'
import { localEmbeddingProvider } from '../services/local-embedding.provider'
import { omlxManager } from '../services/omlx-manager.service'
import { ollamaManager } from '../services/ollama-manager.service'
import { workspaceRepository } from '../db/repositories'
import { validateSender } from './validate-sender'
import type { EmbeddingModelStatus, LocalLLMBackend } from '../../shared/types'

export function registerEmbeddingIpc(mainWindow: BrowserWindow): void {
  // Forward oMLX embedding events to the renderer
  localEmbeddingProvider.on('modelReady', () => {
    mainWindow.webContents.send(IPC_CHANNELS.EMBEDDING_MODEL_READY)
  })
  localEmbeddingProvider.on('modelError', (error: string) => {
    mainWindow.webContents.send(IPC_CHANNELS.EMBEDDING_MODEL_ERROR, error)
  })

  ipcMain.handle(
    IPC_CHANNELS.EMBEDDING_CHECK_STATUS,
    async (event, args?: { baseUrl?: string; apiKey?: string; workspaceId?: string }): Promise<EmbeddingModelStatus> => {
      validateSender(event)

      // Align facade backend with workspace preferences before probing status
      if (args?.workspaceId) {
        localEmbeddingProvider.configureForWorkspace(args.workspaceId)
      }

      // Resolve config: explicit args → workspace settings → defaults
      let resolvedBaseUrl = args?.baseUrl
      let resolvedApiKey = args?.apiKey
      let activeBackend: LocalLLMBackend = 'omlx'
      let ollamaEmbModel: string | null = null

      if (args?.workspaceId) {
        try {
          const settings = workspaceRepository.getSettings(args.workspaceId)
          activeBackend = (settings?.localLlmBackend as LocalLLMBackend) ?? 'omlx'
          ollamaEmbModel = (settings?.ollamaEmbeddingModel as string) ?? null
          if (!resolvedBaseUrl) {
            const host = (settings?.localHost as string) ?? '127.0.0.1'
            const defaultPort = activeBackend === 'ollama' ? OLLAMA_DEFAULT_PORT : OMLX_DEFAULT_PORT
            const port = (settings?.localPort as number) ?? defaultPort
            resolvedBaseUrl = `http://${host}:${port}`
          }
          if (!resolvedApiKey && settings?.localApiKey) {
            resolvedApiKey = settings.localApiKey as string
          }
        } catch {
          // Fall through to defaults
        }
      }

      // ── Ollama branch ──
      if (activeBackend === 'ollama') {
        const ollamaUrl = resolvedBaseUrl ?? 'http://127.0.0.1:11434'
        const ollamaStatus = await ollamaManager.checkStatus(ollamaUrl)

        // Auto-initialize when Ollama + embedding model are available
        if (ollamaStatus.running && ollamaEmbModel && !localEmbeddingProvider.isReady) {
          localEmbeddingProvider
            .initialize(ollamaUrl)
            .catch(() => { /* non-fatal */ })
        }

        return {
          ready: localEmbeddingProvider.isReady,
          backend: 'ollama',
          // oMLX fields — zeroed out so renderer doesn't show stale oMLX data
          omlxRunning: false,
          omlxInstalled: false,
          omlxEmbeddingModelId: null,
          omlxEmbeddingModelLoaded: false,
          omlxAdminApiAvailable: false,
          // Ollama fields
          ollamaRunning: ollamaStatus.running,
          ollamaEmbeddingModel: ollamaEmbModel
        }
      }

      // ── oMLX branch (default) ──
      const status = await omlxManager.checkStatus(resolvedBaseUrl, resolvedApiKey)
      const embeddingModel = status.allModels?.find(
        (m) => m.loaded && m.modelType === 'embedding'
      )

      // When admin API is unavailable, synthesize allModels from /v1/models
      const allModels = status.allModels ?? []

      // Auto-initialize embedding provider when a loaded embedding model is found
      // but the provider hasn't been initialized yet
      if (embeddingModel?.loaded && !localEmbeddingProvider.isReady) {
        localEmbeddingProvider
          .initialize(resolvedBaseUrl, resolvedApiKey)
          .catch(() => { /* non-fatal — UI will show the model status regardless */ })
      }

      return {
        ready: localEmbeddingProvider.isReady,
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
    await localEmbeddingProvider.initialize(args?.baseUrl, args?.apiKey)
  })
}
