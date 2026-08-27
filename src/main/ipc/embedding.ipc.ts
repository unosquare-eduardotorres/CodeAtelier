import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import {
  IPC_CHANNELS,
  MODEL_ROLE_ROWS,
  OMLX_DEFAULT_PORT,
  OLLAMA_DEFAULT_PORT,
  defaultLocalLlmBackend
} from '../../shared/constants'
import { resolveAssignment } from '../services/model-config.service'
import { localEmbeddingProvider } from '../services/local-embedding.provider'
import { omlxManager } from '../services/omlx-manager.service'
import { ollamaManager } from '../services/ollama-manager.service'
import { workspaceRepository } from '../db/repositories'
import { validateSender } from './validate-sender'
import type {
  EmbeddingModelStatus,
  LLMProvider,
  LocalLLMBackend,
  ModelOverrides,
  ModelRoleMap,
  ModelsRuntimeStatus,
  RuntimeRoleAssignment,
  RuntimeRoleRow
} from '../../shared/types'

const PLATFORM_DEFAULT_BACKEND = defaultLocalLlmBackend(
  process.platform === 'darwin' && process.arch === 'arm64'
)

function readRole(
  roles: ModelRoleMap,
  key: 'specialist:plan' | 'specialist:build'
): RuntimeRoleAssignment | null {
  const role = roles[key]
  return role ? { provider: role.provider, modelId: role.modelId } : null
}

/**
 * Resolve every routable role through the same chain the runtime uses, so the
 * "In Use" panel reports what will actually run — including the roles nobody
 * ever set, which is most of them on a fresh workspace.
 */
function resolveRoleRows(opts: {
  modelRoles: ModelRoleMap
  modelOverrides: ModelOverrides
  workspaceProvider: LLMProvider
  workspaceBackend: LocalLLMBackend
  /** Models each reachable server listed; null when it could not be asked. */
  installed: Record<LocalLLMBackend, string[] | null>
}): RuntimeRoleRow[] {
  return MODEL_ROLE_ROWS.map((row): RuntimeRoleRow => {
    const resolved = resolveAssignment({
      action: row.primaryAction,
      modelRoles: opts.modelRoles,
      modelOverrides: opts.modelOverrides,
      workspaceProvider: opts.workspaceProvider,
      workspaceBackend: opts.workspaceBackend
    })

    let available = true
    if (resolved.provider === 'local-llm') {
      const backend = resolved.localBackend ?? opts.workspaceBackend
      const models = opts.installed[backend]
      // null means the server never answered — we cannot claim the model is gone
      if (models) available = models.includes(resolved.modelId)
    }

    return {
      action: row.primaryAction,
      group: row.group,
      label: row.label,
      provider: resolved.provider,
      modelId: resolved.modelId,
      localBackend: resolved.localBackend,
      source: resolved.source,
      available
    }
  })
}

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
    async (
      event,
      args?: { baseUrl?: string; apiKey?: string; workspaceId?: string }
    ): Promise<EmbeddingModelStatus> => {
      validateSender(event)

      // Align facade backend with workspace preferences before probing status
      if (args?.workspaceId) {
        localEmbeddingProvider.configureForWorkspace(args.workspaceId)
      }

      // Resolve config: explicit args → workspace settings → defaults
      let resolvedBaseUrl = args?.baseUrl
      let resolvedApiKey = args?.apiKey
      // Must match configureForWorkspace's fallback, or this reports the oMLX
      // branch on machines the facade actually put on Ollama.
      let activeBackend: LocalLLMBackend = PLATFORM_DEFAULT_BACKEND
      let ollamaEmbModel: string | null = null

      if (args?.workspaceId) {
        try {
          const settings = workspaceRepository.getSettings(args.workspaceId)
          activeBackend = (settings?.localLlmBackend as LocalLLMBackend) ?? PLATFORM_DEFAULT_BACKEND
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
          localEmbeddingProvider.initialize(ollamaUrl).catch(() => {
            /* non-fatal */
          })
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
      const embeddingModel = status.allModels?.find((m) => m.loaded && m.modelType === 'embedding')

      // When admin API is unavailable, synthesize allModels from /v1/models
      const allModels = status.allModels ?? []

      // Auto-initialize embedding provider when a loaded embedding model is found
      // but the provider hasn't been initialized yet
      if (embeddingModel?.loaded && !localEmbeddingProvider.isReady) {
        localEmbeddingProvider.initialize(resolvedBaseUrl, resolvedApiKey).catch(() => {
          /* non-fatal — UI will show the model status regardless */
        })
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

  ipcMain.handle(
    IPC_CHANNELS.EMBEDDING_INITIALIZE,
    async (event, args?: { baseUrl?: string; apiKey?: string; workspaceId?: string }) => {
      validateSender(event)
      // Without this the "Check Connection" button probes whatever the global
      // facade happens to hold, which is a different question from the one the
      // user is asking ("does MY workspace's embedding config work?").
      if (args?.workspaceId) {
        localEmbeddingProvider.configureForWorkspace(args.workspaceId)
      }
      await localEmbeddingProvider.initialize(args?.baseUrl, args?.apiKey)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MODELS_RUNTIME_STATUS,
    async (event, args: { workspaceId: string }): Promise<ModelsRuntimeStatus> => {
      validateSender(event)

      let settings: Record<string, unknown> = {}
      try {
        settings = (workspaceRepository.getSettings(args.workspaceId) ?? {}) as Record<
          string,
          unknown
        >
      } catch {
        // Fall through to defaults — status is diagnostic, never fatal
      }

      const savedBackend = (settings.localLlmBackend as LocalLLMBackend) ?? PLATFORM_DEFAULT_BACKEND
      const savedModelName = (settings.ollamaEmbeddingModel as string) ?? ''
      const activeBackend = localEmbeddingProvider.activeBackend
      const activeModelName = localEmbeddingProvider.activeModelName

      // oMLX picks its embedding model server-side, so only the Ollama branch
      // has a saved model name to compare against.
      const drift =
        savedBackend !== activeBackend ||
        (savedBackend === 'ollama' && savedModelName !== activeModelName)

      const host = (settings.localHost as string) ?? '127.0.0.1'
      const savedPort = settings.localPort as number | undefined
      const ollamaUrl = `http://${host}:${savedBackend === 'ollama' && savedPort ? savedPort : OLLAMA_DEFAULT_PORT}`
      const omlxUrl = `http://${host}:${savedBackend === 'omlx' && savedPort ? savedPort : OMLX_DEFAULT_PORT}`

      const [ollamaProbe, omlxProbe] = await Promise.allSettled([
        ollamaManager.checkStatus(ollamaUrl),
        omlxManager.checkStatus(omlxUrl, settings.localApiKey as string | undefined)
      ])

      const roles = (settings.modelRoles as ModelRoleMap) ?? {}

      const listed = (
        probe: PromiseSettledResult<{ running: boolean; models: string[] }>
      ): string[] | null =>
        probe.status === 'fulfilled' && probe.value.running ? probe.value.models : null

      return {
        embedding: {
          activeBackend,
          activeModelName,
          ready: localEmbeddingProvider.isReady,
          savedBackend,
          savedModelName,
          drift
        },
        chat: {
          plan: readRole(roles, 'specialist:plan'),
          build: readRole(roles, 'specialist:build')
        },
        roles: resolveRoleRows({
          modelRoles: roles,
          modelOverrides: (settings.modelOverrides as ModelOverrides) ?? {},
          workspaceProvider: (settings.llmProvider as LLMProvider) ?? 'claude',
          workspaceBackend: savedBackend,
          installed: { ollama: listed(ollamaProbe), omlx: listed(omlxProbe) }
        }),
        reachability: {
          ollamaRunning: ollamaProbe.status === 'fulfilled' && ollamaProbe.value.running,
          omlxRunning: omlxProbe.status === 'fulfilled' && omlxProbe.value.running
        }
      }
    }
  )
}
