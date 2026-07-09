import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useWorkspaceStore, useToastStore } from '@renderer/store'
import {
  OMLX_DEFAULT_PORT,
  COMMUNICATION_TONES
} from '../../../../../shared/constants'
import type {
  CommunicationTone,
  CostPreference,
  ExecutorBackend,
  LLMProvider,
  ModelRoleMap,
  OmlxExtendedStatus,
  OmlxModelDetail,
  PlatformInfo,
  Workspace
} from '../../../../../shared/types'

// ─── Types ────────────────────────────────────────────────

/** Connection draft — only host/port/apiKey/contextWindow need explicit Save */
export interface ConnectionDraft {
  localHost: string
  localPort: number
  localApiKey: string
  localContextWindow: number | undefined
}

/** Claude CLI installation status */
export interface ClaudeCliStatus {
  installed: boolean
  version: string | null
  error: string | null
}

export interface ModelConfigState {
  activeWorkspace: Workspace | null
  // Connection draft (explicit save)
  connectionDraft: ConnectionDraft
  connectionPersisted: ConnectionDraft
  isConnectionDirty: boolean
  // Persisted workspace settings (instant-save)
  defaultProvider: LLMProvider
  executorBackend: ExecutorBackend
  localModel: string
  modelRoles: ModelRoleMap
  claudeModelOverrides: Record<string, string>
  // Workspace preferences (instant-save, not part of draft)
  costPreference: CostPreference
  fastMode: boolean
  budgetCapUsd: number | undefined
  communicationTone: CommunicationTone
  // Status
  platformInfo: PlatformInfo | null
  claudeCliStatus: ClaudeCliStatus | null
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
  // Connection draft mutations
  setLocalHost: (host: string) => void
  setLocalPort: (port: number) => void
  setLocalApiKey: (key: string) => void
  setLocalContextWindow: (value: number | undefined) => void
  // Connection draft save/discard
  saveConnection: () => Promise<void>
  discardConnection: () => void
  // Instant-persist actions
  handleSetDefaultProvider: (provider: LLMProvider) => Promise<void>
  handleExecutorBackendChange: (backend: ExecutorBackend) => Promise<void>
  handleLocalModelSelect: (modelId: string) => Promise<void>
  handleModelRolesChange: (roles: ModelRoleMap, overrides: Record<string, string>) => Promise<void>
  // oMLX model management
  handleLoadOmlxModel: (modelId: string) => Promise<void>
  handleUnloadOmlxModel: (modelId: string) => Promise<void>
  // Connection test
  testConnection: (host?: string, port?: number, silent?: boolean) => Promise<OmlxExtendedStatus | null>
  scheduleAutoTest: () => void
  // Workspace setting actions
  handleCostPreferenceChange: (pref: CostPreference) => Promise<void>
  handleFastModeToggle: () => Promise<void>
  handleBudgetCapChange: (value: string) => Promise<void>
  handleToneChange: (tone: CommunicationTone) => Promise<void>
}

// ─── Pure Helpers ─────────────────────────────────────────

const OMLX_DEFAULT_HOST = '127.0.0.1'

/** Persist a setting change to the workspace via IPC (read-modify-write). */
async function persistWorkspaceSetting(
  workspaceId: string,
  updates: Record<string, unknown>
): Promise<void> {
  const settings = await window.api.getWorkspaceSettings({ workspaceId })
  await window.api.updateWorkspaceSettings({
    workspaceId,
    settings: { ...settings, ...updates }
  })
}

function defaultConnectionDraft(): ConnectionDraft {
  return {
    localHost: OMLX_DEFAULT_HOST,
    localPort: OMLX_DEFAULT_PORT,
    localApiKey: '',
    localContextWindow: undefined
  }
}

function connectionDraftsEqual(a: ConnectionDraft, b: ConnectionDraft): boolean {
  return (
    a.localHost === b.localHost &&
    a.localPort === b.localPort &&
    a.localApiKey === b.localApiKey &&
    a.localContextWindow === b.localContextWindow
  )
}

// ─── Connection Test Hook ─────────────────────────────────

function useConnectionTest(opts: {
  defaultProvider: LLMProvider
  localHost: string
  localPort: number
  localApiKey: string
}): {
  localStatus: OmlxExtendedStatus | null
  connectionTesting: boolean
  testConnection: (host?: string, port?: number, silent?: boolean) => Promise<OmlxExtendedStatus | null>
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
        const fallback = { installed: false, running: false, models: [] } as unknown as OmlxExtendedStatus
        setLocalStatus(fallback)
        if (!silent) {
          addToast({ message: `Connection failed — oMLX is not reachable at ${h}:${p}`, type: 'error' })
        }
        return null
      } finally {
        setConnectionTesting(false)
      }
    },
    [opts.localHost, opts.localPort, opts.localApiKey, addToast]
  )

  // Auto-test on mount when local-llm is already the default provider
  useEffect(() => {
    if (!autoTestDone) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional one-time auto-test on mount
      setAutoTestDone(true)
      if (opts.defaultProvider === 'local-llm') {
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
  }, [opts.defaultProvider, opts.localHost, opts.localPort, opts.localApiKey, autoTestDone])

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
  fastMode: boolean
  budgetCapUsd: number | undefined
  communicationTone: CommunicationTone
  setCostPreference: React.Dispatch<React.SetStateAction<CostPreference>>
  setFastMode: React.Dispatch<React.SetStateAction<boolean>>
  setBudgetCapUsd: React.Dispatch<React.SetStateAction<number | undefined>>
  setCommunicationTone: React.Dispatch<React.SetStateAction<CommunicationTone>>
  handleCostPreferenceChange: (pref: CostPreference) => Promise<void>
  handleFastModeToggle: () => Promise<void>
  handleBudgetCapChange: (value: string) => Promise<void>
  handleToneChange: (tone: CommunicationTone) => Promise<void>
} {
  const addToast = useToastStore((s) => s.addToast)
  const [costPreference, setCostPreference] = useState<CostPreference>('balanced')
  const [fastMode, setFastMode] = useState(false)
  const [budgetCapUsd, setBudgetCapUsd] = useState<number | undefined>(undefined)
  const [communicationTone, setCommunicationTone] = useState<CommunicationTone>('default')

  const handleCostPreferenceChange = async (pref: CostPreference): Promise<void> => {
    setCostPreference(pref)
    if (activeWorkspace) {
      await persistWorkspaceSetting(activeWorkspace.id, { costPreference: pref })
    }
  }

  const handleFastModeToggle = async (): Promise<void> => {
    const newValue = !fastMode
    setFastMode(newValue)
    if (activeWorkspace) {
      await persistWorkspaceSetting(activeWorkspace.id, { fastMode: newValue })
    }
  }

  const handleBudgetCapChange = async (value: string): Promise<void> => {
    const parsed = value ? Number(value) : undefined
    const capValue = parsed && parsed > 0 ? parsed : undefined
    setBudgetCapUsd(capValue)
    if (activeWorkspace) {
      await persistWorkspaceSetting(activeWorkspace.id, { budgetCapUsd: capValue ?? null })
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
    fastMode,
    budgetCapUsd,
    communicationTone,
    setCostPreference,
    setFastMode,
    setBudgetCapUsd,
    setCommunicationTone,
    handleCostPreferenceChange,
    handleFastModeToggle,
    handleBudgetCapChange,
    handleToneChange
  }
}

// ─── Main Hook ────────────────────────────────────────────

export function useModelConfig(): ModelConfigState & ModelConfigActions {
  const { activeWorkspace } = useWorkspaceStore()
  const addToast = useToastStore((s) => s.addToast)

  // ── Connection draft (explicit save) ──
  const [connectionDraft, setConnectionDraft] = useState<ConnectionDraft>(defaultConnectionDraft)
  const [connectionPersisted, setConnectionPersisted] = useState<ConnectionDraft>(defaultConnectionDraft)

  // ── Instant-persist workspace settings ──
  const [defaultProvider, setDefaultProvider] = useState<LLMProvider>('claude')
  const [executorBackend, setExecutorBackend] = useState<ExecutorBackend>('cli')
  const [localModel, setLocalModel] = useState('qwen3.6:35b-a3b-coding-nvfp4')
  const [modelRoles, setModelRoles] = useState<ModelRoleMap>({})
  const [claudeModelOverrides, setClaudeModelOverrides] = useState<Record<string, string>>({})

  // ── Platform + Claude CLI ──
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null)
  const [claudeCliStatus, setClaudeCliStatus] = useState<ClaudeCliStatus | null>(null)
  const [modelLoading, setModelLoading] = useState<string | null>(null)

  // Derived
  const isConnectionDirty = useMemo(
    () => !connectionDraftsEqual(connectionDraft, connectionPersisted),
    [connectionDraft, connectionPersisted]
  )

  // ── Sub-hooks ──
  const wsSettings = useWorkspaceSettingActions(activeWorkspace)
  const { localStatus, connectionTesting, testConnection, scheduleAutoTest } = useConnectionTest({
    defaultProvider,
    localHost: connectionDraft.localHost,
    localPort: connectionDraft.localPort,
    localApiKey: connectionDraft.localApiKey
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
  }, [])

  // Load current workspace settings
  useEffect(() => {
    if (!activeWorkspace) return
    window.api
      .getWorkspaceSettings({ workspaceId: activeWorkspace.id })
      .then((settings) => {
        // Workspace preferences (delegated to sub-hook)
        wsSettings.setCostPreference((settings.costPreference as CostPreference) || 'balanced')
        wsSettings.setFastMode(settings.fastMode === true)
        wsSettings.setBudgetCapUsd(
          typeof settings.budgetCapUsd === 'number' && settings.budgetCapUsd > 0
            ? (settings.budgetCapUsd as number)
            : undefined
        )
        wsSettings.setCommunicationTone(
          (settings.communicationTone as CommunicationTone) ?? 'default'
        )

        // Instant-persist settings
        setDefaultProvider((settings.llmProvider as LLMProvider) ?? 'claude')
        setExecutorBackend((settings.executorBackend as ExecutorBackend) ?? 'cli')
        setLocalModel(
          (settings.localModel as string) ??
          (settings.ollamaModel as string) ??
          'qwen3.6:35b-a3b-coding-nvfp4'
        )
        setModelRoles((settings.modelRoles as ModelRoleMap) ?? {})
        setClaudeModelOverrides((settings.modelOverrides as Record<string, string>) ?? {})

        // Connection draft — if legacy backend is ollama, use oMLX defaults
        const savedBackend = settings.localLlmBackend as string | undefined
        const useOmlxDefaults = savedBackend === 'ollama'
        const conn: ConnectionDraft = {
          localHost: useOmlxDefaults
            ? OMLX_DEFAULT_HOST
            : ((settings.localHost as string) ?? (settings.ollamaHost as string) ?? OMLX_DEFAULT_HOST),
          localPort: useOmlxDefaults
            ? OMLX_DEFAULT_PORT
            : ((settings.localPort as number) ?? (settings.ollamaPort as number) ?? OMLX_DEFAULT_PORT),
          localApiKey: (settings.localApiKey as string) ?? '',
          localContextWindow:
            typeof settings.localContextWindow === 'number'
              ? (settings.localContextWindow as number)
              : undefined
        }
        setConnectionPersisted(conn)
        setConnectionDraft(conn)
      })
      .catch(console.error)
  }, [activeWorkspace])

  // ── Connection draft setters ──
  const setLocalHost = useCallback(
    (host: string) => setConnectionDraft((prev) => ({ ...prev, localHost: host })),
    []
  )
  const setLocalPort = useCallback(
    (port: number) => setConnectionDraft((prev) => ({ ...prev, localPort: port })),
    []
  )
  const setLocalApiKey = useCallback(
    (key: string) => setConnectionDraft((prev) => ({ ...prev, localApiKey: key })),
    []
  )
  const setLocalContextWindow = useCallback(
    (value: number | undefined) => setConnectionDraft((prev) => ({ ...prev, localContextWindow: value })),
    []
  )

  // ── Save connection (also migrates legacy ollama → omlx) ──
  const saveConnection = useCallback(async () => {
    if (!activeWorkspace) return
    try {
      await persistWorkspaceSetting(activeWorkspace.id, {
        localLlmBackend: 'omlx',
        localHost: connectionDraft.localHost,
        localPort: connectionDraft.localPort,
        localApiKey: connectionDraft.localApiKey,
        localContextWindow: connectionDraft.localContextWindow ?? null
      })
      setConnectionPersisted({ ...connectionDraft })
      addToast({ message: 'Connection settings saved', type: 'success' })
    } catch (err) {
      console.error('Failed to save connection settings:', err)
      addToast({ message: 'Failed to save connection settings', type: 'error' })
    }
  }, [activeWorkspace, connectionDraft, addToast])

  // ── Discard connection draft ──
  const discardConnection = useCallback(() => {
    setConnectionDraft({ ...connectionPersisted })
    addToast({ message: 'Connection changes discarded', type: 'info' })
  }, [connectionPersisted, addToast])

  // ── Instant-persist: default provider ──
  const handleSetDefaultProvider = useCallback(
    async (provider: LLMProvider) => {
      if (!activeWorkspace) return
      setDefaultProvider(provider)
      await persistWorkspaceSetting(activeWorkspace.id, {
        llmProvider: provider,
        // Always persist omlx backend when switching to local
        ...(provider === 'local-llm' ? { localLlmBackend: 'omlx' } : {})
      })
      addToast({
        message: `Default provider set to ${provider === 'claude' ? 'Claude' : 'oMLX'}`,
        type: 'success'
      })
      if (provider === 'local-llm') {
        testConnection(undefined, undefined, true)
      }
    },
    [activeWorkspace, addToast, testConnection]
  )

  // ── Instant-persist: executor backend ──
  const handleExecutorBackendChange = useCallback(
    async (backend: ExecutorBackend) => {
      if (!activeWorkspace) return
      setExecutorBackend(backend)
      await persistWorkspaceSetting(activeWorkspace.id, { executorBackend: backend })
    },
    [activeWorkspace]
  )

  // ── Instant-persist: local model selection ──
  const handleLocalModelSelect = useCallback(
    async (modelId: string) => {
      if (!activeWorkspace) return
      setLocalModel(modelId)
      await persistWorkspaceSetting(activeWorkspace.id, { localModel: modelId })
    },
    [activeWorkspace]
  )

  // ── Instant-persist: model roles ──
  const handleModelRolesChange = useCallback(
    async (roles: ModelRoleMap, overrides: Record<string, string>) => {
      if (!activeWorkspace) return
      setModelRoles(roles)
      setClaudeModelOverrides(overrides)
      await persistWorkspaceSetting(activeWorkspace.id, {
        modelRoles: roles,
        modelOverrides: overrides
      })
    },
    [activeWorkspace]
  )

  // ── oMLX model load/unload ──
  const handleLoadOmlxModel = useCallback(
    async (modelId: string) => {
      setModelLoading(modelId)
      const baseUrl = `http://${connectionDraft.localHost}:${connectionDraft.localPort}`
      try {
        await window.api.omlxLoadModel({
          modelId,
          baseUrl,
          apiKey: connectionDraft.localApiKey || undefined
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
    [connectionDraft, testConnection, addToast]
  )

  const handleUnloadOmlxModel = useCallback(
    async (modelId: string) => {
      setModelLoading(modelId)
      const baseUrl = `http://${connectionDraft.localHost}:${connectionDraft.localPort}`
      try {
        await window.api.omlxUnloadModel({
          modelId,
          baseUrl,
          apiKey: connectionDraft.localApiKey || undefined
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
    [connectionDraft, testConnection, addToast]
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

  const isRemoteServer =
    connectionDraft.localHost !== '127.0.0.1' && connectionDraft.localHost !== 'localhost'
  const localBaseUrl = `http://${connectionDraft.localHost}:${connectionDraft.localPort}`

  return {
    // State
    activeWorkspace,
    connectionDraft,
    connectionPersisted,
    isConnectionDirty,
    defaultProvider,
    executorBackend,
    localModel,
    modelRoles,
    claudeModelOverrides,
    costPreference: wsSettings.costPreference,
    fastMode: wsSettings.fastMode,
    budgetCapUsd: wsSettings.budgetCapUsd,
    communicationTone: wsSettings.communicationTone,
    platformInfo,
    claudeCliStatus,
    localStatus,
    connectionTesting,
    modelLoading,
    localBaseUrl,
    isRemoteServer,
    omlxModels: localStatus?.models ?? [],
    omlxChatModels,
    // Actions
    setLocalHost,
    setLocalPort,
    setLocalApiKey,
    setLocalContextWindow,
    saveConnection,
    discardConnection,
    handleSetDefaultProvider,
    handleExecutorBackendChange,
    handleLocalModelSelect,
    handleModelRolesChange,
    handleLoadOmlxModel,
    handleUnloadOmlxModel,
    handleCostPreferenceChange: wsSettings.handleCostPreferenceChange,
    handleFastModeToggle: wsSettings.handleFastModeToggle,
    handleBudgetCapChange: wsSettings.handleBudgetCapChange,
    handleToneChange: wsSettings.handleToneChange,
    testConnection,
    scheduleAutoTest
  }
}
