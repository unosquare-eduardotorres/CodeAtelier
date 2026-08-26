import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useWorkspaceStore, useToastStore } from '@renderer/store'
import {
  OMLX_DEFAULT_PORT,
  OLLAMA_DEFAULT_PORT,
  COMMUNICATION_TONES,
  defaultLocalLlmBackend
} from '../../../../../shared/constants'
import {
  DEFAULT_LOCAL_MODEL,
  LOCAL_MODELS_DEFAULT_HOST,
  changedLocalModelsSettings,
  defaultLocalModelsDraft,
  localModelsDraftsEqual,
  type LocalModelsDraft
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
  isLocalModelsDirty: boolean
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
  // Local Models draft save/discard
  saveLocalModels: () => Promise<void>
  discardLocalModels: () => void
  // Instant-persist actions
  handleModelRolesChange: (roles: ModelRoleMap, overrides: Record<string, string>) => Promise<void>
  handleFallbackModelChange: (modelId: string) => Promise<void>
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
  handleToneChange: (tone: CommunicationTone) => Promise<void>
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
      try {
        const baseUrl = `http://${h}:${p}`
        const status = await window.api.omlxCheckStatus({
          baseUrl,
          apiKey: opts.localApiKey || undefined
        })
        setLocalStatus(status)

        if (!silent) {
          if (status.running) {
            const mc = status.models.length
            addToast({
              message:
                mc > 0
                  ? `Connected to oMLX — ${mc} model${mc !== 1 ? 's' : ''} available`
                  : 'Connected to oMLX — no models loaded yet',
              type: mc > 0 ? 'success' : 'info'
            })
          } else if (status.installed) {
            addToast({
              message: 'oMLX is installed but not running. Start it and try again.',
              type: 'error'
            })
          } else {
            addToast({ message: `Could not reach oMLX at ${h}:${p}`, type: 'error' })
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
            message: `Connection failed — oMLX is not reachable at ${h}:${p}`,
            type: 'error'
          })
        }
        return null
      } finally {
        setConnectionTesting(false)
      }
    },
    [opts.localHost, opts.localPort, opts.localApiKey, addToast]
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
        window.api
          .omlxCheckStatus({ baseUrl, apiKey: opts.localApiKey || undefined })
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
  communicationTone: CommunicationTone
  setCostPreference: React.Dispatch<React.SetStateAction<CostPreference>>
  setCommunicationTone: React.Dispatch<React.SetStateAction<CommunicationTone>>
  handleCostPreferenceChange: (pref: CostPreference) => Promise<void>
  handleToneChange: (tone: CommunicationTone) => Promise<void>
} {
  const addToast = useToastStore((s) => s.addToast)
  const [costPreference, setCostPreference] = useState<CostPreference>('balanced')
  const [communicationTone, setCommunicationTone] = useState<CommunicationTone>('default')

  const handleCostPreferenceChange = async (pref: CostPreference): Promise<void> => {
    setCostPreference(pref)
    if (activeWorkspace) {
      await persistWorkspaceSetting(activeWorkspace.id, { costPreference: pref })
    }
  }

  const handleToneChange = async (tone: CommunicationTone): Promise<void> => {
    setCommunicationTone(tone)
    if (activeWorkspace) {
      await persistWorkspaceSetting(activeWorkspace.id, { communicationTone: tone })
      addToast({
        message: `Communication tone set to ${COMMUNICATION_TONES.find((t) => t.id === tone)?.label ?? tone}`,
        type: 'info'
      })
    }
  }

  return {
    costPreference,
    communicationTone,
    setCostPreference,
    setCommunicationTone,
    handleCostPreferenceChange,
    handleToneChange
  }
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

  // ── Instant-persist workspace settings ──
  const [defaultProvider, setDefaultProvider] = useState<LLMProvider>('claude')
  const [modelRoles, setModelRoles] = useState<ModelRoleMap>({})
  const [claudeModelOverrides, setClaudeModelOverrides] = useState<Record<string, string>>({})
  const [fallbackModel, setFallbackModel] = useState<string | undefined>(undefined)

  // ── Platform + Claude CLI ──
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null)
  const [claudeCliStatus, setClaudeCliStatus] = useState<ClaudeCliStatus | null>(null)
  const [openCodeCliStatus, setOpenCodeCliStatus] = useState<{
    available: boolean
    version?: string
  } | null>(null)
  const [modelLoading, setModelLoading] = useState<string | null>(null)

  // Derived — a single dirty flag for the whole card, so the backend tab can
  // no longer be silently unsaved just because host/port happen to match.
  const isLocalModelsDirty = useMemo(
    () => !localModelsDraftsEqual(localModelsDraft, localModelsPersisted),
    [localModelsDraft, localModelsPersisted]
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
        wsSettings.setCommunicationTone(
          (settings.communicationTone as CommunicationTone) ?? 'default'
        )

        // Instant-persist settings
        setDefaultProvider((settings.llmProvider as LLMProvider) ?? 'claude')
        setModelRoles((settings.modelRoles as ModelRoleMap) ?? {})
        setClaudeModelOverrides((settings.modelOverrides as Record<string, string>) ?? {})
        setFallbackModel((settings.fallbackModel as string) ?? undefined)

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

  // ── Save the whole Local Models card in one write ──
  const saveLocalModels = useCallback(async () => {
    if (!activeWorkspace) return
    const changed = changedLocalModelsSettings(localModelsDraft, localModelsPersisted)
    if (Object.keys(changed).length === 0) return
    try {
      await persistWorkspaceSetting(activeWorkspace.id, changed)
      setLocalModelsPersisted({ ...localModelsDraft })
      setLocalModelsSavedAt(Date.now())
      addToast({ message: 'Local model settings saved', type: 'success' })

      // Main re-points the embedding facade on settings change, but does not
      // re-probe it. Kick a probe so the "In use" panel reflects the new model
      // without waiting for a restart or the next search.
      if (localModelsDraft.localLlmBackend === 'ollama') {
        window.api.embeddingInitialize({ workspaceId: activeWorkspace.id }).catch(() => {
          /* non-fatal — failures surface via embedding modelError events */
        })
      }
    } catch (err) {
      console.error('Failed to save local model settings:', err)
      addToast({ message: 'Failed to save local model settings', type: 'error' })
    }
  }, [activeWorkspace, localModelsDraft, localModelsPersisted, addToast])

  // ── Discard the Local Models draft ──
  const discardLocalModels = useCallback(() => {
    setLocalModelsDraft({ ...localModelsPersisted })
    addToast({ message: 'Local model changes discarded', type: 'info' })
  }, [localModelsPersisted, addToast])

  // ── Instant-persist: model roles (also derives + persists llmProvider for backend compat) ──
  const handleModelRolesChange = useCallback(
    async (roles: ModelRoleMap, overrides: Record<string, string>) => {
      if (!activeWorkspace) return
      setModelRoles(roles)
      setClaudeModelOverrides(overrides)

      // Derive provider from plan action's provider for backend compatibility
      const planRole = roles['specialist:plan']
      const derived: LLMProvider = planRole?.provider ?? 'claude'
      setDefaultProvider(derived)

      await persistWorkspaceSetting(activeWorkspace.id, {
        modelRoles: roles,
        modelOverrides: overrides,
        // Keep backend llmProvider in sync with routing
        llmProvider: derived,
        // Materialise the *saved* backend (never the unsaved draft) so routing
        // to local-llm always has a backend recorded alongside it.
        ...(derived === 'local-llm'
          ? { localLlmBackend: localModelsPersisted.localLlmBackend }
          : {})
      })
    },
    [activeWorkspace, localModelsPersisted.localLlmBackend]
  )

  // ── Instant-persist: fallback model ──
  const handleFallbackModelChange = useCallback(
    async (modelId: string) => {
      if (!activeWorkspace) return
      setFallbackModel(modelId)
      await persistWorkspaceSetting(activeWorkspace.id, { fallbackModel: modelId })
    },
    [activeWorkspace]
  )

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
  const omlxChatModels = useMemo(() => {
    const models = localStatus?.models ?? []
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
    // Admin API unavailable — name-based heuristic fallback
    return models.filter((m) => !/embed|bge|rerank/i.test(m))
  }, [localStatus])

  // Derive provider from routing — reads plan action's provider from modelRoles
  const derivedProvider: LLMProvider = useMemo(() => {
    const planRole = modelRoles['specialist:plan']
    return planRole?.provider ?? defaultProvider
  }, [modelRoles, defaultProvider])

  const isRemoteServer =
    localModelsDraft.localHost !== '127.0.0.1' && localModelsDraft.localHost !== 'localhost'
  const localBaseUrl = `http://${localModelsDraft.localHost}:${localModelsDraft.localPort}`

  return {
    // State
    activeWorkspace,
    localModelsDraft,
    localModelsPersisted,
    isLocalModelsDirty,
    localModelsSavedAt,
    defaultProvider,
    derivedProvider,
    localLlmBackend: localModelsDraft.localLlmBackend,
    localModel: localModelsDraft.localModel,
    modelRoles,
    claudeModelOverrides,
    fallbackModel,
    ollamaEmbeddingModel: localModelsDraft.ollamaEmbeddingModel,
    costPreference: wsSettings.costPreference,
    communicationTone: wsSettings.communicationTone,
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
    handleToneChange: wsSettings.handleToneChange,
    testConnection,
    scheduleAutoTest
  }
}
