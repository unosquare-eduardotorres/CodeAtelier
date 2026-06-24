import { useState, useEffect, useCallback, useRef } from 'react'
import { useWorkspaceStore, useToastStore } from '@renderer/store'
import {
  OLLAMA_DEFAULT_HOST,
  OLLAMA_DEFAULT_PORT,
  OMLX_DEFAULT_PORT,
  COMMUNICATION_TONES
} from '../../../../../shared/constants'
import type {
  CommunicationTone,
  CostPreference,
  ExecutorBackend,
  LLMProvider,
  LocalLLMBackend,
  OllamaStatus,
  OmlxExtendedStatus,
  PlatformInfo,
  Workspace
} from '../../../../../shared/types'

// ─── Types ────────────────────────────────────────────────

export interface ModelConfigState {
  activeWorkspace: Workspace | null
  costPreference: CostPreference
  fastMode: boolean
  budgetCapUsd: number | undefined
  communicationTone: CommunicationTone
  executorBackend: ExecutorBackend
  provider: LLMProvider
  backend: LocalLLMBackend
  platformInfo: PlatformInfo | null
  localModel: string
  localHost: string
  localPort: number
  localApiKey: string
  localContextWindow: number | undefined
  localStatus: OmlxExtendedStatus | OllamaStatus | null
  showOllamaSetup: boolean
  connectionTesting: boolean
  modelLoading: string | null
  localBaseUrl: string
  isRemoteServer: boolean
}

export interface ModelConfigActions {
  handleProviderChange: (newProvider: LLMProvider) => Promise<void>
  handleBackendChange: (newBackend: LocalLLMBackend) => Promise<void>
  handleUnifiedProviderChange: (newProvider: LLMProvider, newBackend?: LocalLLMBackend) => Promise<void>
  handleLocalModelSelect: (modelId: string) => Promise<void>
  handleLoadOmlxModel: (modelId: string) => Promise<void>
  handleUnloadOmlxModel: (modelId: string) => Promise<void>
  handleCostPreferenceChange: (pref: CostPreference) => Promise<void>
  handleFastModeToggle: () => Promise<void>
  handleBudgetCapChange: (value: string) => Promise<void>
  handleToneChange: (tone: CommunicationTone) => Promise<void>
  testConnection: (
    activeBackend?: LocalLLMBackend,
    host?: string,
    port?: number
  ) => Promise<OllamaStatus | null>
  scheduleAutoTest: () => void
  saveProviderSettings: (
    newProvider: LLMProvider,
    opts?: {
      model?: string
      host?: string
      port?: number
      backend?: LocalLLMBackend
      apiKey?: string
    }
  ) => Promise<void>
  setLocalHost: (host: string) => void
  setLocalPort: (port: number) => void
  setLocalApiKey: (key: string) => void
  setLocalContextWindow: (value: number | undefined) => void
  setShowOllamaSetup: (show: boolean) => void
  setProvider: (provider: LLMProvider) => void
  setLocalModel: (model: string) => void
  setExecutorBackend: (backend: ExecutorBackend) => void
}

// ─── Pure Helpers ─────────────────────────────────────────

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

/** Determine if the Ollama setup modal should be shown after a backend switch. */
function shouldShowOllamaSetup(
  status: OllamaStatus | null,
  localModel: string
): boolean {
  if (!status) return false
  if (!status.installed || !status.running) return true
  return !status.models.some((m) => m === localModel || m.startsWith(`${localModel}:`))
}

// ─── Connection Test Hook ─────────────────────────────────

function useConnectionTest(opts: {
  provider: LLMProvider
  backend: LocalLLMBackend
  localHost: string
  localPort: number
  localApiKey: string
}): {
  localStatus: OmlxExtendedStatus | OllamaStatus | null
  connectionTesting: boolean
  testConnection: (
    activeBackend?: LocalLLMBackend,
    host?: string,
    port?: number
  ) => Promise<OllamaStatus | null>
  scheduleAutoTest: () => void
} {
  const addToast = useToastStore((s) => s.addToast)
  const [localStatus, setLocalStatus] = useState<OmlxExtendedStatus | OllamaStatus | null>(null)
  const [connectionTesting, setConnectionTesting] = useState(false)
  const [autoTestDone, setAutoTestDone] = useState(false)

  const testConnection = useCallback(
    async (
      activeBackend?: LocalLLMBackend,
      host?: string,
      port?: number
    ): Promise<OllamaStatus | null> => {
      setConnectionTesting(true)
      const b = activeBackend ?? opts.backend
      const h = host ?? opts.localHost
      const p = port ?? opts.localPort
      const label = b === 'omlx' ? 'oMLX' : 'Ollama'
      try {
        const baseUrl = `http://${h}:${p}`
        const status =
          b === 'omlx'
            ? await window.api.omlxCheckStatus({ baseUrl, apiKey: opts.localApiKey || undefined })
            : await window.api.ollamaCheckStatus({ baseUrl })
        setLocalStatus(status)

        if (status.running) {
          const mc = status.models.length
          addToast({
            message:
              mc > 0
                ? `Connected to ${label} — ${mc} model${mc !== 1 ? 's' : ''} available`
                : `Connected to ${label} — no models loaded yet`,
            type: mc > 0 ? 'success' : 'info'
          })
        } else if (status.installed) {
          addToast({
            message: `${label} is installed but not running. Start it and try again.`,
            type: 'error'
          })
        } else {
          addToast({ message: `Could not reach ${label} at ${h}:${p}`, type: 'error' })
        }

        return status
      } catch {
        setLocalStatus({ installed: false, running: false, models: [] })
        addToast({ message: `Connection failed — ${label} is not reachable at ${h}:${p}`, type: 'error' })
        return null
      } finally {
        setConnectionTesting(false)
      }
    },
    [opts.backend, opts.localHost, opts.localPort, opts.localApiKey, addToast]
  )

  // Auto-test connection when page loads with local-llm already selected
  useEffect(() => {
    if (opts.provider === 'local-llm' && !autoTestDone) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional one-time auto-test on mount
      setAutoTestDone(true)
      setConnectionTesting(true)
      const baseUrl = `http://${opts.localHost}:${opts.localPort}`
      const check =
        opts.backend === 'omlx'
          ? window.api.omlxCheckStatus({ baseUrl, apiKey: opts.localApiKey || undefined })
          : window.api.ollamaCheckStatus({ baseUrl })
      check
        .then((status) => setLocalStatus(status))
        .catch(() => setLocalStatus({ installed: false, running: false, models: [] }))
        .finally(() => setConnectionTesting(false))
    }
  }, [opts.provider, opts.backend, opts.localHost, opts.localPort, opts.localApiKey, autoTestDone])

  // Debounced auto-test for blur-then-persist-then-test pattern
  const debouncedTestRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scheduleAutoTest = useCallback(() => {
    if (debouncedTestRef.current) clearTimeout(debouncedTestRef.current)
    debouncedTestRef.current = setTimeout(() => {
      testConnection()
    }, 600) // 600ms debounce — enough for tab-between-fields
  }, [testConnection])

  // Clean up debounce timer on unmount
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

  // ── Executor backend state ──
  const [executorBackend, setExecutorBackend] = useState<ExecutorBackend>('cli')

  // ── Local LLM provider state ──
  const [provider, setProvider] = useState<LLMProvider>('claude')
  const [backend, setBackend] = useState<LocalLLMBackend>('ollama')
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null)
  const [localModel, setLocalModel] = useState('qwen3.6:35b-a3b-coding-nvfp4')
  const [localHost, setLocalHost] = useState<string>(OLLAMA_DEFAULT_HOST)
  const [localPort, setLocalPort] = useState<number>(OLLAMA_DEFAULT_PORT)
  const [localApiKey, setLocalApiKey] = useState<string>('')
  const [localContextWindow, setLocalContextWindow] = useState<number | undefined>(undefined)
  const [showOllamaSetup, setShowOllamaSetup] = useState(false)
  const [modelLoading, setModelLoading] = useState<string | null>(null)

  // ── Sub-hooks ──
  const wsSettings = useWorkspaceSettingActions(activeWorkspace)
  const { localStatus, connectionTesting, testConnection, scheduleAutoTest } = useConnectionTest({
    provider,
    backend,
    localHost,
    localPort,
    localApiKey
  })

  // Load platform info on mount (for oMLX feature gating)
  useEffect(() => {
    window.api
      .getPlatformInfo()
      .then(setPlatformInfo)
      .catch((err) => console.warn('[useModelConfig] Non-fatal: platform info load failed:', err))
  }, [])

  // Load current workspace settings
  useEffect(() => {
    if (!activeWorkspace) return
    window.api
      .getWorkspaceSettings({ workspaceId: activeWorkspace.id })
      .then((settings) => {
        // Workspace settings (delegated to sub-hook)
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
        // Executor backend setting
        setExecutorBackend((settings.executorBackend as ExecutorBackend) ?? 'cli')
        // Local LLM provider settings (new keys with backward-compat fallback)
        setProvider((settings.llmProvider as LLMProvider) ?? 'claude')
        setBackend((settings.localLlmBackend as LocalLLMBackend) ?? 'ollama')
        setLocalModel(
          (settings.localModel as string) ??
            (settings.ollamaModel as string) ??
            'qwen3.6:35b-a3b-coding-nvfp4'
        )
        setLocalHost(
          (settings.localHost as string) ?? (settings.ollamaHost as string) ?? OLLAMA_DEFAULT_HOST
        )
        setLocalPort(
          (settings.localPort as number) ?? (settings.ollamaPort as number) ?? OLLAMA_DEFAULT_PORT
        )
        setLocalApiKey((settings.localApiKey as string) ?? '')
        setLocalContextWindow(
          typeof settings.localContextWindow === 'number'
            ? (settings.localContextWindow as number)
            : undefined
        )
      })
      .catch(console.error)
  }, [activeWorkspace])

  /** Save provider + local LLM settings to workspace */
  const saveProviderSettings = useCallback(
    async (
      newProvider: LLMProvider,
      opts?: {
        model?: string
        host?: string
        port?: number
        backend?: LocalLLMBackend
        apiKey?: string
      }
    ) => {
      if (!activeWorkspace) return
      try {
        const settings = await window.api.getWorkspaceSettings({
          workspaceId: activeWorkspace.id
        })
        await window.api.updateWorkspaceSettings({
          workspaceId: activeWorkspace.id,
          settings: {
            ...settings,
            llmProvider: newProvider,
            localLlmBackend: opts?.backend ?? backend,
            localModel: opts?.model ?? localModel,
            localHost: opts?.host ?? localHost,
            localPort: opts?.port ?? localPort,
            localApiKey: opts?.apiKey ?? localApiKey
          }
        })
      } catch (err) {
        console.error('Failed to save provider settings:', err)
        throw err
      }
    },
    [activeWorkspace, backend, localModel, localHost, localPort, localApiKey]
  )

  /** Handle provider switch */
  const handleProviderChange = useCallback(
    async (newProvider: LLMProvider) => {
      setProvider(newProvider)
      await saveProviderSettings(newProvider)
      addToast({
        message: `Provider switched to ${newProvider === 'claude' ? 'Claude' : 'Local LLM'}`,
        type: 'success'
      })
      if (newProvider === 'local-llm') {
        testConnection()
      }
    },
    [saveProviderSettings, testConnection, addToast]
  )

  /** Handle backend change (Ollama ↔ oMLX) */
  const handleBackendChange = useCallback(
    async (newBackend: LocalLLMBackend) => {
      setBackend(newBackend)
      const newPort = newBackend === 'omlx' ? OMLX_DEFAULT_PORT : OLLAMA_DEFAULT_PORT
      setLocalPort(newPort)
      await saveProviderSettings(provider, { backend: newBackend, port: newPort })
      addToast({
        message: `Backend switched to ${newBackend === 'omlx' ? 'oMLX' : 'Ollama'}`,
        type: 'success'
      })
      const status = await testConnection(newBackend, localHost, newPort)
      if (newBackend === 'ollama' && shouldShowOllamaSetup(status, localModel)) {
        setShowOllamaSetup(true)
      }
    },
    [provider, localHost, localModel, saveProviderSettings, testConnection, addToast]
  )

  /** Handle unified provider change — single-step Claude / Ollama / oMLX switch */
  const handleUnifiedProviderChange = useCallback(
    async (newProvider: LLMProvider, newBackend?: LocalLLMBackend) => {
      setProvider(newProvider)

      if (newProvider === 'local-llm' && newBackend) {
        const oldBackend = backend
        setBackend(newBackend)
        // Reset port to default when backend changes
        if (newBackend !== oldBackend) {
          const newPort = newBackend === 'omlx' ? OMLX_DEFAULT_PORT : OLLAMA_DEFAULT_PORT
          setLocalPort(newPort)
          await saveProviderSettings(newProvider, { backend: newBackend, port: newPort })
        } else {
          await saveProviderSettings(newProvider, { backend: newBackend })
        }
      } else {
        await saveProviderSettings(newProvider)
      }

      addToast({
        message:
          newProvider === 'claude'
            ? 'Provider switched to Claude'
            : `Provider switched to ${newBackend === 'omlx' ? 'oMLX' : 'Ollama'}`,
        type: 'success'
      })

      if (newProvider === 'local-llm') {
        const port =
          newBackend !== backend
            ? newBackend === 'omlx'
              ? OMLX_DEFAULT_PORT
              : OLLAMA_DEFAULT_PORT
            : localPort
        const status = await testConnection(newBackend ?? backend, localHost, port)
        if (newBackend === 'ollama' && shouldShowOllamaSetup(status, localModel)) {
          setShowOllamaSetup(true)
        }
      }
    },
    [backend, localHost, localPort, localModel, saveProviderSettings, testConnection, addToast]
  )

  /** Handle local model selection */
  const handleLocalModelSelect = useCallback(
    async (modelId: string) => {
      setLocalModel(modelId)
      await saveProviderSettings(provider, { model: modelId })
      addToast({ message: `Model set to ${modelId}`, type: 'success' })
    },
    [provider, saveProviderSettings, addToast]
  )

  /** Load a downloaded oMLX model into memory via admin API, then refresh */
  const handleLoadOmlxModel = useCallback(
    async (modelId: string) => {
      setModelLoading(modelId)
      const baseUrl = `http://${localHost}:${localPort}`
      try {
        await window.api.omlxLoadModel({
          modelId,
          baseUrl,
          apiKey: localApiKey || undefined
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
    [localHost, localPort, localApiKey, testConnection, addToast]
  )

  /** Unload a model from memory via admin API, then refresh */
  const handleUnloadOmlxModel = useCallback(
    async (modelId: string) => {
      setModelLoading(modelId)
      const baseUrl = `http://${localHost}:${localPort}`
      try {
        await window.api.omlxUnloadModel({
          modelId,
          baseUrl,
          apiKey: localApiKey || undefined
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
    [localHost, localPort, localApiKey, testConnection, addToast]
  )

  const isRemoteServer = localHost !== '127.0.0.1' && localHost !== 'localhost'
  const localBaseUrl = `http://${localHost}:${localPort}`

  return {
    // State
    activeWorkspace,
    costPreference: wsSettings.costPreference,
    fastMode: wsSettings.fastMode,
    budgetCapUsd: wsSettings.budgetCapUsd,
    communicationTone: wsSettings.communicationTone,
    executorBackend,
    provider,
    backend,
    platformInfo,
    localModel,
    localHost,
    localPort,
    localApiKey,
    localContextWindow,
    localStatus,
    showOllamaSetup,
    connectionTesting,
    modelLoading,
    localBaseUrl,
    isRemoteServer,
    // Actions
    handleProviderChange,
    handleBackendChange,
    handleUnifiedProviderChange,
    handleLocalModelSelect,
    handleLoadOmlxModel,
    handleUnloadOmlxModel,
    handleCostPreferenceChange: wsSettings.handleCostPreferenceChange,
    handleFastModeToggle: wsSettings.handleFastModeToggle,
    handleBudgetCapChange: wsSettings.handleBudgetCapChange,
    handleToneChange: wsSettings.handleToneChange,
    testConnection,
    scheduleAutoTest,
    saveProviderSettings,
    setLocalHost,
    setLocalPort,
    setLocalApiKey,
    setLocalContextWindow,
    setShowOllamaSetup,
    setProvider,
    setLocalModel,
    setExecutorBackend
  }
}
