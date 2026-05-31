import { useState, useEffect, useCallback } from 'react'
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
  PlatformInfo
} from '../../../../../shared/types'

export interface ModelConfigState {
  activeWorkspace: ReturnType<typeof useWorkspaceStore>['activeWorkspace']
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
  handleLocalModelSelect: (modelId: string) => Promise<void>
  handleLoadOmlxModel: (modelId: string) => Promise<void>
  handleCostPreferenceChange: (pref: CostPreference) => Promise<void>
  handleFastModeToggle: () => Promise<void>
  handleBudgetCapChange: (value: string) => Promise<void>
  handleToneChange: (tone: CommunicationTone) => Promise<void>
  testConnection: (
    activeBackend?: LocalLLMBackend,
    host?: string,
    port?: number
  ) => Promise<OllamaStatus | null>
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

export function useModelConfig(): ModelConfigState & ModelConfigActions {
  const { activeWorkspace } = useWorkspaceStore()
  const addToast = useToastStore((s) => s.addToast)
  const [costPreference, setCostPreference] = useState<CostPreference>('balanced')
  const [fastMode, setFastMode] = useState(false)
  const [budgetCapUsd, setBudgetCapUsd] = useState<number | undefined>(undefined)
  const [communicationTone, setCommunicationTone] = useState<CommunicationTone>('default')

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
  const [localStatus, setLocalStatus] = useState<OmlxExtendedStatus | OllamaStatus | null>(null)
  const [showOllamaSetup, setShowOllamaSetup] = useState(false)
  const [connectionTesting, setConnectionTesting] = useState(false)
  const [modelLoading, setModelLoading] = useState<string | null>(null)

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
        setCostPreference((settings.costPreference as CostPreference) || 'balanced')
        setFastMode(settings.fastMode === true)
        setBudgetCapUsd(
          typeof settings.budgetCapUsd === 'number' && settings.budgetCapUsd > 0
            ? (settings.budgetCapUsd as number)
            : undefined
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
        setCommunicationTone((settings.communicationTone as CommunicationTone) ?? 'default')
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
      }
    },
    [activeWorkspace, backend, localModel, localHost, localPort, localApiKey]
  )

  /** Test connection at configured address — dispatches to correct backend */
  const testConnection = useCallback(
    async (
      activeBackend?: LocalLLMBackend,
      host?: string,
      port?: number
    ): Promise<OllamaStatus | null> => {
      setConnectionTesting(true)
      const b = activeBackend ?? backend
      const h = host ?? localHost
      const p = port ?? localPort
      const label = b === 'omlx' ? 'oMLX' : 'Ollama'
      try {
        const baseUrl = `http://${h}:${p}`
        const status =
          b === 'omlx'
            ? await window.api.omlxCheckStatus({
                baseUrl,
                apiKey: localApiKey || undefined
              })
            : await window.api.ollamaCheckStatus({ baseUrl })
        setLocalStatus(status)

        // Toast feedback
        if (status.running) {
          const modelCount = status.models.length
          addToast({
            message:
              modelCount > 0
                ? `Connected to ${label} — ${modelCount} model${modelCount !== 1 ? 's' : ''} available`
                : `Connected to ${label} — no models loaded yet`,
            type: modelCount > 0 ? 'success' : 'info'
          })
        } else if (status.installed) {
          addToast({
            message: `${label} is installed but not running. Start it and try again.`,
            type: 'error'
          })
        } else {
          addToast({
            message: `Could not reach ${label} at ${h}:${p}`,
            type: 'error'
          })
        }

        return status
      } catch {
        const failStatus = { installed: false, running: false, models: [] }
        setLocalStatus(failStatus)
        addToast({
          message: `Connection failed — ${label} is not reachable at ${h}:${p}`,
          type: 'error'
        })
        return null
      } finally {
        setConnectionTesting(false)
      }
    },
    [backend, localHost, localPort, localApiKey, addToast]
  )

  // Auto-test connection when page loads with local-llm already selected.
  const [autoTestDone, setAutoTestDone] = useState(false)
  useEffect(() => {
    if (provider === 'local-llm' && !autoTestDone) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional one-shot auto-test on mount
      setAutoTestDone(true)
      setConnectionTesting(true)
      const baseUrl = `http://${localHost}:${localPort}`
      const check =
        backend === 'omlx'
          ? window.api.omlxCheckStatus({ baseUrl, apiKey: localApiKey || undefined })
          : window.api.ollamaCheckStatus({ baseUrl })
      check
        .then((status) => setLocalStatus(status))
        .catch(() => setLocalStatus({ installed: false, running: false, models: [] }))
        .finally(() => setConnectionTesting(false))
    }
  }, [provider, backend, localHost, localPort, localApiKey, autoTestDone])

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

      if (newBackend === 'ollama' && status) {
        if (!status.installed || !status.running) {
          setShowOllamaSetup(true)
          return
        }
        const hasModel = status.models.some(
          (m) => m === localModel || m.startsWith(`${localModel}:`)
        )
        if (!hasModel) {
          setShowOllamaSetup(true)
        }
      }
    },
    [provider, localHost, localModel, saveProviderSettings, testConnection, addToast]
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

  const handleCostPreferenceChange = async (pref: CostPreference): Promise<void> => {
    setCostPreference(pref)
    if (activeWorkspace) {
      const settings = await window.api.getWorkspaceSettings({ workspaceId: activeWorkspace.id })
      await window.api.updateWorkspaceSettings({
        workspaceId: activeWorkspace.id,
        settings: { ...settings, costPreference: pref }
      })
    }
  }

  const handleFastModeToggle = async (): Promise<void> => {
    const newValue = !fastMode
    setFastMode(newValue)
    if (activeWorkspace) {
      const settings = await window.api.getWorkspaceSettings({ workspaceId: activeWorkspace.id })
      await window.api.updateWorkspaceSettings({
        workspaceId: activeWorkspace.id,
        settings: { ...settings, fastMode: newValue }
      })
    }
  }

  const handleBudgetCapChange = async (value: string): Promise<void> => {
    const parsed = value ? Number(value) : undefined
    setBudgetCapUsd(parsed && parsed > 0 ? parsed : undefined)
    if (activeWorkspace) {
      const settings = await window.api.getWorkspaceSettings({ workspaceId: activeWorkspace.id })
      await window.api.updateWorkspaceSettings({
        workspaceId: activeWorkspace.id,
        settings: { ...settings, budgetCapUsd: parsed && parsed > 0 ? parsed : null }
      })
    }
  }

  const handleToneChange = async (tone: CommunicationTone): Promise<void> => {
    setCommunicationTone(tone)
    if (activeWorkspace) {
      const settings = await window.api.getWorkspaceSettings({ workspaceId: activeWorkspace.id })
      await window.api.updateWorkspaceSettings({
        workspaceId: activeWorkspace.id,
        settings: { ...settings, communicationTone: tone }
      })
      addToast({
        message: `Communication tone set to ${COMMUNICATION_TONES.find((t) => t.id === tone)?.label ?? tone}`,
        type: 'info'
      })
    }
  }

  const isRemoteServer = localHost !== '127.0.0.1' && localHost !== 'localhost'
  const localBaseUrl = `http://${localHost}:${localPort}`

  return {
    // State
    activeWorkspace,
    costPreference,
    fastMode,
    budgetCapUsd,
    communicationTone,
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
    handleLocalModelSelect,
    handleLoadOmlxModel,
    handleCostPreferenceChange,
    handleFastModeToggle,
    handleBudgetCapChange,
    handleToneChange,
    testConnection,
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
