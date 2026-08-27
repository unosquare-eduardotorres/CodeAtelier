import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useWorkspaceStore, useToastStore } from '@renderer/store'
import {
  OMLX_DEFAULT_PORT,
  OLLAMA_DEFAULT_PORT,
  defaultLocalLlmBackend
} from '../../../../../shared/constants'
import {
  DEFAULT_LOCAL_MODEL,
  LOCAL_MODELS_DEFAULT_HOST,
  changedLocalModelsSettings,
  changedRoutingSettings,
  countUnsavedChanges,
  defaultLocalModelsDraft,
  defaultRoutingDraft,
  deriveProvider,
  localModelsDraftsEqual,
  routingDraftsEqual,
  type LocalModelsDraft,
  type RoutingDraft
} from './local-models-draft'
import type {
  CommunicationTone,
  CostPreference,
  LLMProvider,
  LocalLLMBackend,
  ModelRoleMap,
  OmlxExtendedStatus,
  OmlxModelDetail,
  PlatformInfo,
  Workspace
} from '../../../../../shared/types'

// ─── Types ────────────────────────────────────────────────

export type { LocalModelsDraft } from './local-models-draft'

/** Claude CLI installation status */
export interface ClaudeCliStatus {
  installed: boolean
  version: string | null
  error: string | null
}

export interface ModelConfigState {
  activeWorkspace: Workspace | null
  // Local Models card — one draft for the whole card (explicit save)
  localModelsDraft: LocalModelsDraft
  localModelsPersisted: LocalModelsDraft
  /** True when anything on the Configure tab is unsaved — connection or routing */
  isLocalModelsDirty: boolean
  /** How many distinct decisions are unsaved, for the save bar */
  unsavedChangeCount: number
  /** Specifically the embedding model is unsaved — narrower than the tab flag */
  isEmbeddingModelDirty: boolean
  /** Bumped on every successful save — consumers re-read live runtime status */
  localModelsSavedAt: number
  // Persisted workspace settings (instant-save)
  /** @deprecated Use derivedProvider — kept for backward compat during Phase 1 */
  defaultProvider: LLMProvider
  /** Provider derived from routing: reads plan action's provider from modelRoles */
  derivedProvider: LLMProvider
  /** Active local-LLM backend tab — draft value, 'omlx' or 'ollama' */
  localLlmBackend: LocalLLMBackend
  localModel: string
  modelRoles: ModelRoleMap
  claudeModelOverrides: Record<string, string>
  /** Workspace-level fallback model used when an assigned model is unavailable */
  fallbackModel: string | undefined
  /** Ollama embedding model used for semantic search — draft value */
  ollamaEmbeddingModel: string
  // Workspace preferences (instant-save, not part of draft)
  costPreference: CostPreference
  communicationTone: CommunicationTone
  // Status
  platformInfo: PlatformInfo | null
  claudeCliStatus: ClaudeCliStatus | null
  openCodeCliStatus: { available: boolean; version?: string } | null
  localStatus: OmlxExtendedStatus | null
  connectionTesting: boolean
  modelLoading: string | null
  localBaseUrl: string
  isRemoteServer: boolean
  /** oMLX models from last successful connection test */
  omlxModels: string[]
  /** oMLX models filtered to chat-capable only (excludes embedding/reranker) */
  omlxChatModels: string[]
}

export interface ModelConfigActions {
  // Local Models draft mutations (no IPC — every change lands on Save)
  setLocalLlmBackend: (backend: LocalLLMBackend) => void
  setLocalHost: (host: string) => void
  setLocalPort: (port: number) => void
  setLocalApiKey: (key: string) => void
  setLocalContextWindow: (value: number | undefined) => void
  handleLocalModelSelect: (modelId: string) => void
  handleOllamaEmbeddingModelChange: (model: string) => void
  // Save/discard — covers connection AND routing in one write
  saveLocalModels: () => Promise<void>
  discardLocalModels: () => void
  // Routing draft mutations (land on Save, like everything else on the tab)
  handleModelRolesChange: (roles: ModelRoleMap, overrides: Record<string, string>) => void
  handleFallbackModelChange: (modelId: string) => void
  // oMLX model management
  handleLoadOmlxModel: (modelId: string) => Promise<void>
  handleUnloadOmlxModel: (modelId: string) => Promise<void>
  // Connection test
  testConnection: (
    host?: string,
    port?: number,
    silent?: boolean
  ) => Promise<OmlxExtendedStatus | null>
  scheduleAutoTest: () => void
  // Workspace setting actions
  handleCostPreferenceChange: (pref: CostPreference) => Promise<void>
  handleToneChange: (tone: CommunicationTone) => void
}

// ─── Pure Helpers ─────────────────────────────────────────

const OMLX_DEFAULT_HOST = LOCAL_MODELS_DEFAULT_HOST

/**
 * Persist a setting change to the workspace via IPC.
 *
 * Sends ONLY the changed keys. Main merges over the existing settings row, so
 * a read-modify-write here would revert every key another page has written
 * since this one loaded — which is how a saved embedding model could come back
 * empty after an unrelated toggle elsewhere.
 */
async function persistWorkspaceSetting(
  workspaceId: string,
  updates: Record<string, unknown>
): Promise<void> {
  await window.api.updateWorkspaceSettings({ workspaceId, settings: updates })
}

/**
 * Probe whichever local server the user is actually on.
 *
 * The Ollama tab used to be probed through `omlxCheckStatus`, which falls back
 * to the OpenAI-compatible /v1/models. That returns bare model ids and no type,
 * so every Ollama model reached the UI as an untyped name and was rendered as a
 * chat model. `ollamaCheckStatus` uses /api/tags + /api/show and carries real
 * capabilities.
 */
function probeLocalServer(
  backend: LocalLLMBackend,
  baseUrl: string,
  apiKey?: string
): Promise<OmlxExtendedStatus> {
  return backend === 'ollama'
    ? window.api.ollamaCheckStatus({ baseUrl })
    : window.api.omlxCheckStatus({ baseUrl, apiKey })
}

// ─── Connection Test Hook ─────────────────────────────────

function useConnectionTest(opts: {
  defaultProvider: LLMProvider
  localLlmBackend: LocalLLMBackend
  localHost: string
  localPort: number
  localApiKey: string
}): {
  localStatus: OmlxExtendedStatus | null
  connectionTesting: boolean
  testConnection: (
    host?: string,
    port?: number,
    silent?: boolean
  ) => Promise<OmlxExtendedStatus | null>
  scheduleAutoTest: () => void
} {
  const addToast = useToastStore((s) => s.addToast)
  const [localStatus, setLocalStatus] = useState<OmlxExtendedStatus | null>(null)
  const [connectionTesting, setConnectionTesting] = useState(false)
  const [autoTestDone, setAutoTestDone] = useState(false)

  const testConnection = useCallback(
    async (host?: string, port?: number, silent?: boolean): Promise<OmlxExtendedStatus | null> => {
      setConnectionTesting(true)
      const h = host ?? opts.localHost
      const p = port ?? opts.localPort
      const name = opts.localLlmBackend === 'ollama' ? 'Ollama' : 'oMLX'
      try {
        const baseUrl = `http://${h}:${p}`
        const status = await probeLocalServer(
          opts.localLlmBackend,
          baseUrl,
          opts.localApiKey || undefined
        )
        setLocalStatus(status)

        if (!silent) {
          if (status.running) {
            const mc = status.models.length
            addToast({
              message:
                mc > 0
                  ? `Connected to ${name} — ${mc} model${mc !== 1 ? 's' : ''} available`
                  : `Connected to ${name} — no models loaded yet`,
              type: mc > 0 ? 'success' : 'info'
            })
          } else if (status.installed) {
            addToast({
              message: `${name} is installed but not running. Start it and try again.`,
              type: 'error'
            })
          } else {
            addToast({ message: `Could not reach ${name} at ${h}:${p}`, type: 'error' })
          }
        }

        return status
      } catch {
        const fallback = {
          installed: false,
          running: false,
          models: []
        } as unknown as OmlxExtendedStatus
        setLocalStatus(fallback)
        if (!silent) {
          addToast({
            message: `Connection failed — ${name} is not reachable at ${h}:${p}`,
            type: 'error'
          })
        }
        return null
      } finally {
        setConnectionTesting(false)
      }
    },
    [opts.localHost, opts.localPort, opts.localApiKey, opts.localLlmBackend, addToast]
  )

  // Auto-test on mount when local-llm is the default provider OR Ollama backend is active
  // (user may use Claude for chat but Ollama for embeddings — still need to populate model list)
  useEffect(() => {
    if (!autoTestDone) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional one-time auto-test on mount
      setAutoTestDone(true)
      if (opts.defaultProvider === 'local-llm' || opts.localLlmBackend === 'ollama') {
        setConnectionTesting(true)
        const baseUrl = `http://${opts.localHost}:${opts.localPort}`
        probeLocalServer(opts.localLlmBackend, baseUrl, opts.localApiKey || undefined)
          .then((status) => setLocalStatus(status))
          .catch(() =>
            setLocalStatus({
              installed: false,
              running: false,
              models: []
            } as unknown as OmlxExtendedStatus)
          )
          .finally(() => setConnectionTesting(false))
      }
    }
  }, [
    opts.defaultProvider,
    opts.localLlmBackend,
    opts.localHost,
    opts.localPort,
    opts.localApiKey,
    autoTestDone
  ])

  // Debounced auto-test for blur-then-persist-then-test pattern
  const debouncedTestRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scheduleAutoTest = useCallback(() => {
    if (debouncedTestRef.current) clearTimeout(debouncedTestRef.current)
    debouncedTestRef.current = setTimeout(() => {
      testConnection()
    }, 600)
  }, [testConnection])

  useEffect(() => {
    return () => {
      if (debouncedTestRef.current) clearTimeout(debouncedTestRef.current)
    }
  }, [])

  return { localStatus, connectionTesting, testConnection, scheduleAutoTest }
}

// ─── Workspace Setting Actions Hook ───────────────────────

function useWorkspaceSettingActions(activeWorkspace: Workspace | null): {
  costPreference: CostPreference
  setCostPreference: React.Dispatch<React.SetStateAction<CostPreference>>
  handleCostPreferenceChange: (pref: CostPreference) => Promise<void>
} {
  const [costPreference, setCostPreference] = useState<CostPreference>('balanced')

  const handleCostPreferenceChange = async (pref: CostPreference): Promise<void> => {
    setCostPreference(pref)
    if (activeWorkspace) {
      await persistWorkspaceSetting(activeWorkspace.id, { costPreference: pref })
    }
  }

  return { costPreference, setCostPreference, handleCostPreferenceChange }
}

// ─── Main Hook ────────────────────────────────────────────

export function useModelConfig(): ModelConfigState & ModelConfigActions {
  const { activeWorkspace } = useWorkspaceStore()
  const addToast = useToastStore((s) => s.addToast)

  // ── Local Models draft (explicit save — covers the whole card) ──
  const [localModelsDraft, setLocalModelsDraft] =
    useState<LocalModelsDraft>(defaultLocalModelsDraft)
  const [localModelsPersisted, setLocalModelsPersisted] =
    useState<LocalModelsDraft>(defaultLocalModelsDraft)
  const [localModelsSavedAt, setLocalModelsSavedAt] = useState(0)

  // ── Routing draft (routing + fallback + tone — saved with the connection) ──
  const [routingDraft, setRoutingDraft] = useState<RoutingDraft>(defaultRoutingDraft)
  const [routingPersisted, setRoutingPersisted] = useState<RoutingDraft>(defaultRoutingDraft)
  const [defaultProvider, setDefaultProvider] = useState<LLMProvider>('claude')

  // ── Platform + Claude CLI ──
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null)
  const [claudeCliStatus, setClaudeCliStatus] = useState<ClaudeCliStatus | null>(null)
  const [openCodeCliStatus, setOpenCodeCliStatus] = useState<{
    available: boolean
    version?: string
  } | null>(null)
  const [modelLoading, setModelLoading] = useState<string | null>(null)

  // Derived — a single dirty flag for the whole tab, so the backend tab can
  // no longer be silently unsaved just because host/port happen to match, and
  // routing can no longer save behind the user's back.
  const isLocalModelsDirty = useMemo(
    () =>
      !localModelsDraftsEqual(localModelsDraft, localModelsPersisted) ||
      !routingDraftsEqual(routingDraft, routingPersisted),
    [localModelsDraft, localModelsPersisted, routingDraft, routingPersisted]
  )

  // Narrower than the tab-wide flag on purpose: the "will be used after saving"
  // hint is about the embedding model, and a routing edit must not make it lie.
  const isEmbeddingModelDirty =
    localModelsDraft.ollamaEmbeddingModel !== localModelsPersisted.ollamaEmbeddingModel

  const unsavedChangeCount = useMemo(
    () =>
      countUnsavedChanges(
        { draft: localModelsDraft, persisted: localModelsPersisted },
        { draft: routingDraft, persisted: routingPersisted }
      ),
    [localModelsDraft, localModelsPersisted, routingDraft, routingPersisted]
  )

  // ── Sub-hooks ──
  const wsSettings = useWorkspaceSettingActions(activeWorkspace)
  const { localStatus, connectionTesting, testConnection, scheduleAutoTest } = useConnectionTest({
    defaultProvider,
    localLlmBackend: localModelsDraft.localLlmBackend,
    localHost: localModelsDraft.localHost,
    localPort: localModelsDraft.localPort,
    localApiKey: localModelsDraft.localApiKey
  })

  // Load platform info + Claude CLI status on mount
  useEffect(() => {
    window.api
      .getPlatformInfo()
      .then(setPlatformInfo)
      .catch((err) => console.warn('[useModelConfig] Non-fatal: platform info load failed:', err))
    window.api
      .checkClaudeCli()
      .then(setClaudeCliStatus)
      .catch((err) => console.warn('[useModelConfig] Non-fatal: Claude CLI check failed:', err))
    window.api
      .checkOpenCodeCli()
      .then(setOpenCodeCliStatus)
      .catch((err) => console.warn('[useModelConfig] Non-fatal: OpenCode CLI check failed:', err))
  }, [])

  // Load current workspace settings
  useEffect(() => {
    if (!activeWorkspace) return
    Promise.all([
      window.api.getWorkspaceSettings({ workspaceId: activeWorkspace.id }),
      window.api.getPlatformInfo().catch(() => null)
    ])
      .then(([settings, platform]) => {
        // Workspace preferences (delegated to sub-hook)
        wsSettings.setCostPreference((settings.costPreference as CostPreference) || 'balanced')

        setDefaultProvider((settings.llmProvider as LLMProvider) ?? 'claude')

        const loadedRouting: RoutingDraft = {
          modelRoles: (settings.modelRoles as ModelRoleMap) ?? {},
          modelOverrides: (settings.modelOverrides as Record<string, string>) ?? {},
          fallbackModel: (settings.fallbackModel as string) ?? undefined,
          communicationTone: (settings.communicationTone as CommunicationTone) ?? 'default'
        }
        setRoutingPersisted(loadedRouting)
        setRoutingDraft(loadedRouting)

        // Restore saved backend tab.  When no tab is persisted yet, default to
        // omlx on Apple Silicon and ollama elsewhere — oMLX cannot run off
        // Apple Silicon, so defaulting to it there makes embeddings unreachable.
        const savedBackend = settings.localLlmBackend as LocalLLMBackend | undefined
        const resolvedBackend: LocalLLMBackend =
          savedBackend ?? defaultLocalLlmBackend(platform?.isAppleSilicon ?? true)

        const defaultPort = resolvedBackend === 'ollama' ? OLLAMA_DEFAULT_PORT : OMLX_DEFAULT_PORT
        const loaded: LocalModelsDraft = {
          localLlmBackend: resolvedBackend,
          localHost:
            (settings.localHost as string) ?? (settings.ollamaHost as string) ?? OMLX_DEFAULT_HOST,
          localPort:
            (settings.localPort as number) ?? (settings.ollamaPort as number) ?? defaultPort,
          localApiKey: (settings.localApiKey as string) ?? '',
          localContextWindow:
            typeof settings.localContextWindow === 'number'
              ? (settings.localContextWindow as number)
              : undefined,
          localModel:
            (settings.localModel as string) ??
            (settings.ollamaModel as string) ??
            DEFAULT_LOCAL_MODEL,
          ollamaEmbeddingModel: (settings.ollamaEmbeddingModel as string) ?? ''
        }
        setLocalModelsPersisted(loaded)
        setLocalModelsDraft(loaded)

        // When settings resolve to Ollama backend, schedule a connection test
        // so the model list populates (the initial auto-test may have fired
        // before settings loaded, using the wrong port).
        if (resolvedBackend === 'ollama') {
          setTimeout(() => scheduleAutoTest(), 100)
        }
      })
      .catch(console.error)
  }, [activeWorkspace]) // eslint-disable-line react-hooks/exhaustive-deps -- scheduleAutoTest is stable ref

  // ── Backend tab switch (draft-only — lands on Save like every other field) ──
  const setLocalLlmBackend = useCallback((backend: LocalLLMBackend) => {
    // Switch default port when toggling tabs, but only if the current port
    // matches the OTHER backend's default (avoid clobbering custom ports).
    const otherDefault = backend === 'ollama' ? OMLX_DEFAULT_PORT : OLLAMA_DEFAULT_PORT
    const thisDefault = backend === 'ollama' ? OLLAMA_DEFAULT_PORT : OMLX_DEFAULT_PORT
    setLocalModelsDraft((prev) => ({
      ...prev,
      localLlmBackend: backend,
      localPort: prev.localPort === otherDefault ? thisDefault : prev.localPort
    }))
  }, [])

  // ── Local Models draft setters ──
  const setLocalHost = useCallback(
    (host: string) => setLocalModelsDraft((prev) => ({ ...prev, localHost: host })),
    []
  )
  const setLocalPort = useCallback(
    (port: number) => setLocalModelsDraft((prev) => ({ ...prev, localPort: port })),
    []
  )
  const setLocalApiKey = useCallback(
    (key: string) => setLocalModelsDraft((prev) => ({ ...prev, localApiKey: key })),
    []
  )
  const setLocalContextWindow = useCallback(
    (value: number | undefined) =>
      setLocalModelsDraft((prev) => ({ ...prev, localContextWindow: value })),
    []
  )
  const handleLocalModelSelect = useCallback(
    (modelId: string) => setLocalModelsDraft((prev) => ({ ...prev, localModel: modelId })),
    []
  )
  const handleOllamaEmbeddingModelChange = useCallback(
    (model: string) => setLocalModelsDraft((prev) => ({ ...prev, ollamaEmbeddingModel: model })),
    []
  )

  // ── Save the whole tab in one write ──
  const saveLocalModels = useCallback(async () => {
    if (!activeWorkspace) return
    const changed = {
      ...changedLocalModelsSettings(localModelsDraft, localModelsPersisted),
      ...changedRoutingSettings(routingDraft, routingPersisted, localModelsDraft.localLlmBackend)
    }
    if (Object.keys(changed).length === 0) return
    try {
      await persistWorkspaceSetting(activeWorkspace.id, changed)
      setLocalModelsPersisted({ ...localModelsDraft })
      setRoutingPersisted({ ...routingDraft })
      setDefaultProvider(deriveProvider(routingDraft.modelRoles))
      setLocalModelsSavedAt(Date.now())
      addToast({ message: 'Model settings saved', type: 'success' })

      // Main re-points the embedding facade on settings change, but does not
      // re-probe it. Kick a probe so the "In use" panel reflects the new model
      // without waiting for a restart or the next search.
      if (localModelsDraft.localLlmBackend === 'ollama') {
        window.api.embeddingInitialize({ workspaceId: activeWorkspace.id }).catch(() => {
          /* non-fatal — failures surface via embedding modelError events */
        })
      }
    } catch (err) {
      console.error('Failed to save model settings:', err)
      addToast({ message: 'Failed to save model settings', type: 'error' })
    }
  }, [
    activeWorkspace,
    localModelsDraft,
    localModelsPersisted,
    routingDraft,
    routingPersisted,
    addToast
  ])

  // ── Discard everything on the tab ──
  const discardLocalModels = useCallback(() => {
    setLocalModelsDraft({ ...localModelsPersisted })
    setRoutingDraft({ ...routingPersisted })
    addToast({ message: 'Model changes discarded', type: 'info' })
  }, [localModelsPersisted, routingPersisted, addToast])

  // ── Routing draft setters ──
  const handleModelRolesChange = useCallback(
    (roles: ModelRoleMap, overrides: Record<string, string>) => {
      setRoutingDraft((prev) => ({ ...prev, modelRoles: roles, modelOverrides: overrides }))
    },
    []
  )

  const handleFallbackModelChange = useCallback((modelId: string) => {
    setRoutingDraft((prev) => ({ ...prev, fallbackModel: modelId }))
  }, [])

  const handleToneChange = useCallback((tone: CommunicationTone) => {
    setRoutingDraft((prev) => ({ ...prev, communicationTone: tone }))
  }, [])

  // ── oMLX model load/unload ──
  const handleLoadOmlxModel = useCallback(
    async (modelId: string) => {
      setModelLoading(modelId)
      const baseUrl = `http://${localModelsDraft.localHost}:${localModelsDraft.localPort}`
      try {
        await window.api.omlxLoadModel({
          modelId,
          baseUrl,
          apiKey: localModelsDraft.localApiKey || undefined
        })
        addToast({ message: `Model "${modelId}" loaded successfully`, type: 'success' })
        await testConnection()
      } catch (err) {
        addToast({
          message: `Failed to load model: ${err instanceof Error ? err.message : String(err)}`,
          type: 'error'
        })
      } finally {
        setModelLoading(null)
      }
    },
    [localModelsDraft, testConnection, addToast]
  )

  const handleUnloadOmlxModel = useCallback(
    async (modelId: string) => {
      setModelLoading(modelId)
      const baseUrl = `http://${localModelsDraft.localHost}:${localModelsDraft.localPort}`
      try {
        await window.api.omlxUnloadModel({
          modelId,
          baseUrl,
          apiKey: localModelsDraft.localApiKey || undefined
        })
        addToast({ message: `Model "${modelId}" unloaded`, type: 'info' })
        await testConnection()
      } catch (err) {
        addToast({
          message: `Failed to unload model: ${err instanceof Error ? err.message : String(err)}`,
          type: 'error'
        })
      } finally {
        setModelLoading(null)
      }
    },
    [localModelsDraft, testConnection, addToast]
  )

  // ── Chat-safe model list (excludes embedding/reranker models) ──
  // Routing a role to an embedding model produces a request the server cannot
  // answer, so these must never reach the routing dropdowns.
  const omlxChatModels = useMemo(() => {
    const models = localStatus?.models ?? []

    // Ollama: real per-model capabilities from /api/show + family + name
    const details = localStatus?.modelDetails
    if (details && details.length > 0) {
      const nonChat = new Set(
        details.filter((m) => m.capability === 'embedding').map((m) => m.name)
      )
      return models.filter((m) => !nonChat.has(m))
    }

    // oMLX: model types from the admin API
    const allModels: OmlxModelDetail[] | undefined =
      localStatus && 'allModels' in localStatus
        ? (localStatus as { allModels?: OmlxModelDetail[] }).allModels
        : undefined
    if (allModels) {
      const nonChat = new Set(
        allModels
          .filter((m) => m.modelType === 'embedding' || m.modelType === 'reranker')
          .map((m) => m.id)
      )
      return models.filter((m) => !nonChat.has(m))
    }

    // Nothing reported a type — name-based heuristic fallback
    return models.filter((m) => !/embed|bge|rerank/i.test(m))
  }, [localStatus])

  // Derive provider from routing — reads plan action's provider from modelRoles
  const derivedProvider: LLMProvider = useMemo(() => {
    const planRole = routingDraft.modelRoles['specialist:plan']
    return planRole?.provider ?? defaultProvider
  }, [routingDraft.modelRoles, defaultProvider])

  const isRemoteServer =
    localModelsDraft.localHost !== '127.0.0.1' && localModelsDraft.localHost !== 'localhost'
  const localBaseUrl = `http://${localModelsDraft.localHost}:${localModelsDraft.localPort}`

  return {
    // State
    activeWorkspace,
    localModelsDraft,
    localModelsPersisted,
    isLocalModelsDirty,
    unsavedChangeCount,
    isEmbeddingModelDirty,
    localModelsSavedAt,
    defaultProvider,
    derivedProvider,
    localLlmBackend: localModelsDraft.localLlmBackend,
    localModel: localModelsDraft.localModel,
    modelRoles: routingDraft.modelRoles,
    claudeModelOverrides: routingDraft.modelOverrides,
    fallbackModel: routingDraft.fallbackModel,
    ollamaEmbeddingModel: localModelsDraft.ollamaEmbeddingModel,
    costPreference: wsSettings.costPreference,
    communicationTone: routingDraft.communicationTone,
    platformInfo,
    claudeCliStatus,
    openCodeCliStatus,
    localStatus,
    connectionTesting,
    modelLoading,
    localBaseUrl,
    isRemoteServer,
    omlxModels: localStatus?.models ?? [],
    omlxChatModels,
    // Actions
    setLocalLlmBackend,
    setLocalHost,
    setLocalPort,
    setLocalApiKey,
    setLocalContextWindow,
    handleLocalModelSelect,
    handleOllamaEmbeddingModelChange,
    saveLocalModels,
    discardLocalModels,
    handleModelRolesChange,
    handleFallbackModelChange,
    handleLoadOmlxModel,
    handleUnloadOmlxModel,
    handleCostPreferenceChange: wsSettings.handleCostPreferenceChange,
    handleToneChange,
    testConnection,
    scheduleAutoTest
  }
}
