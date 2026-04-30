import { useState, useEffect, useCallback } from 'react'
import { Zap, Coins, Scale, Rocket, Cloud, Monitor, Loader2 } from 'lucide-react'
import { useWorkspaceStore, useToastStore } from '@renderer/store'
import { SettingsCard } from '@renderer/components/common'
import {
  OLLAMA_DEFAULT_HOST,
  OLLAMA_DEFAULT_PORT,
  OMLX_DEFAULT_PORT
} from '../../../../shared/constants'
import type {
  CostPreference,
  LLMProvider,
  LocalLLMBackend,
  OllamaStatus,
  OmlxExtendedStatus,
  PlatformInfo
} from '../../../../shared/types'
import LocalModelSelector from './LocalModelSelector'
import OllamaSetupModal from './OllamaSetupModal'

const COST_PREF_ICON: Record<CostPreference, React.ReactNode> = {
  economy: <Coins size={16} />,
  balanced: <Scale size={16} />,
  power: <Rocket size={16} />
}

export default function ModelConfigTab(): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const addToast = useToastStore((s) => s.addToast)
  const [costPreference, setCostPreference] = useState<CostPreference>('balanced')
  const [fastMode, setFastMode] = useState(false)

  // ── Local LLM provider state ──
  const [provider, setProvider] = useState<LLMProvider>('claude')
  const [backend, setBackend] = useState<LocalLLMBackend>('ollama')
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null)
  const [localModel, setLocalModel] = useState('qwen3.6:35b-a3b-coding-nvfp4')
  const [localHost, setLocalHost] = useState<string>(OLLAMA_DEFAULT_HOST)
  const [localPort, setLocalPort] = useState<number>(OLLAMA_DEFAULT_PORT)
  const [localApiKey, setLocalApiKey] = useState<string>('')
  const [localStatus, setLocalStatus] = useState<OmlxExtendedStatus | OllamaStatus | null>(null)
  const [showOllamaSetup, setShowOllamaSetup] = useState(false)
  const [connectionTesting, setConnectionTesting] = useState(false)
  const [modelLoading, setModelLoading] = useState<string | null>(null)

  // Load platform info on mount (for oMLX feature gating)
  useEffect(() => {
    window.api
      .getPlatformInfo()
      .then(setPlatformInfo)
      .catch(() => {})
  }, [])

  // Load current workspace settings
  useEffect(() => {
    if (!activeWorkspace) return
    window.api
      .getWorkspaceSettings({ workspaceId: activeWorkspace.id })
      .then((settings) => {
        setCostPreference((settings.costPreference as CostPreference) || 'balanced')
        setFastMode(settings.fastMode === true)
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
  // Inline logic avoids stale-closure issues from the previous setTimeout + useRef pattern.
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

  /** Handle provider switch — always succeeds; health checks happen in handleBackendChange */
  const handleProviderChange = useCallback(
    async (newProvider: LLMProvider) => {
      setProvider(newProvider)
      await saveProviderSettings(newProvider)
      addToast({
        message: `Provider switched to ${newProvider === 'claude' ? 'Claude' : 'Local LLM'}`,
        type: 'success'
      })
      // When switching TO local-llm, trigger a non-blocking connection test
      // so the status badge shows immediately — but don't gate on it
      if (newProvider === 'local-llm') {
        testConnection()
      }
    },
    [saveProviderSettings, testConnection, addToast]
  )

  /** Handle backend change (Ollama ↔ oMLX) — shows setup modal if Ollama needs it */
  const handleBackendChange = useCallback(
    async (newBackend: LocalLLMBackend) => {
      setBackend(newBackend)
      // Update port to backend default
      const newPort = newBackend === 'omlx' ? OMLX_DEFAULT_PORT : OLLAMA_DEFAULT_PORT
      setLocalPort(newPort)
      await saveProviderSettings(provider, { backend: newBackend, port: newPort })
      addToast({
        message: `Backend switched to ${newBackend === 'omlx' ? 'oMLX' : 'Ollama'}`,
        type: 'success'
      })
      // Re-test connection with new backend
      const status = await testConnection(newBackend, localHost, newPort)

      // Ollama-specific: show setup modal if not running or model missing
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
        // Re-test connection to refresh model list
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

  if (!activeWorkspace) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-sm text-text-secondary">Select a workspace to configure models.</p>
      </div>
    )
  }

  const isRemoteServer = localHost !== '127.0.0.1' && localHost !== 'localhost'
  const localBaseUrl = `http://${localHost}:${localPort}`

  return (
    <div className="w-full px-6 py-8">
      {/* Header — full width */}
      <div className="mb-6">
        <h2 className="text-base font-semibold text-text-primary">Model Configuration</h2>
        <p className="text-xs text-text-secondary mt-1">
          Configure which LLM provider and models power this workspace.
        </p>
      </div>

      {/* ── LLM Provider Toggle ── */}
      <div className="mb-8">
        <h3 className="text-sm text-text-secondary uppercase tracking-wider mb-3 font-medium">
          Provider
        </h3>
        <SettingsCard>
          <div className="mb-4">
            <h4 className="text-sm font-medium text-text-primary">LLM Provider</h4>
            <p className="text-xs text-text-secondary mt-0.5">
              Switch to a local model when Claude tokens run low. Starts a fresh conversation.
            </p>
          </div>

          {/* Provider toggle buttons */}
          <div className="flex gap-2">
            <button
              onClick={() => handleProviderChange('claude')}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border text-sm font-medium transition-colors flex-1 ${
                provider === 'claude'
                  ? 'border-primary bg-primary-muted text-primary-text'
                  : 'border-border-subtle hover:bg-surface-overlay text-text-secondary'
              }`}
            >
              <Cloud size={16} />
              <div className="text-left">
                <div>Claude</div>
                <div className="text-[10px] font-normal text-text-muted">
                  Cloud API / Max subscription
                </div>
              </div>
            </button>
            <button
              onClick={() => handleProviderChange('local-llm')}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border text-sm font-medium transition-colors flex-1 ${
                provider === 'local-llm'
                  ? 'border-primary bg-primary-muted text-primary-text'
                  : 'border-border-subtle hover:bg-surface-overlay text-text-secondary'
              }`}
            >
              <Monitor size={16} />
              <div className="text-left">
                <div>Local LLM</div>
                <div className="text-[10px] font-normal text-text-muted">
                  Ollama / oMLX — free, runs on your machine
                </div>
              </div>
            </button>
          </div>
        </SettingsCard>
      </div>

      {/* ── Claude-specific config (only when Claude provider) ── */}
      {provider === 'claude' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Speed */}
          <div>
            <h3 className="text-sm text-text-secondary uppercase tracking-wider mb-3 font-medium">
              Speed
            </h3>
            <SettingsCard>
              <div className="flex items-center justify-between">
                <div className="flex-1 mr-4">
                  <div className="flex items-center gap-2">
                    <Zap
                      size={14}
                      className={fastMode ? 'text-mode-build-text' : 'text-text-muted'}
                    />
                    <h4 className="text-sm font-medium text-text-primary">Fast Mode</h4>
                    {fastMode && (
                      <span className="text-xs px-1.5 py-0.5 rounded-full bg-mode-build-muted text-mode-build-text font-medium">
                        ON
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-text-secondary mt-1">
                    {fastMode
                      ? 'Responses ~2.5× faster, billed as extra usage. Only affects the generalist chat — specialist agents run independently.'
                      : 'Uses included Claude Max usage at standard speed. Enable for faster responses (billed separately).'}
                  </p>
                </div>
                <button
                  onClick={handleFastModeToggle}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                    fastMode ? 'bg-mode-build' : 'bg-border-default'
                  }`}
                  role="switch"
                  aria-checked={fastMode}
                  aria-label="Toggle fast mode"
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      fastMode ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            </SettingsCard>
          </div>

          {/* Cost Preference */}
          <div>
            <h3 className="text-sm text-text-secondary uppercase tracking-wider mb-3 font-medium">
              Cost Preference
            </h3>
            <SettingsCard>
              <div className="mb-3">
                <h4 className="text-sm font-medium text-text-primary">Default Routing</h4>
                <p className="text-xs text-text-secondary mt-0.5">
                  Controls which AI model is used for specialist tasks based on task complexity.
                </p>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {(['economy', 'balanced', 'power'] as const).map((pref) => (
                  <button
                    key={pref}
                    onClick={() => handleCostPreferenceChange(pref)}
                    className={`flex flex-col items-center gap-1.5 px-3 py-3 rounded-lg border text-xs font-medium transition-colors ${
                      costPreference === pref
                        ? 'border-primary bg-primary-muted text-primary-text'
                        : 'border-border-subtle hover:bg-surface-overlay text-text-secondary'
                    }`}
                  >
                    <span className="text-base">{COST_PREF_ICON[pref]}</span>
                    <span className="capitalize">{pref}</span>
                    <span className="text-xs text-text-muted">
                      {pref === 'economy'
                        ? 'Always Haiku'
                        : pref === 'balanced'
                          ? 'Auto-route'
                          : 'Always Opus'}
                    </span>
                  </button>
                ))}
              </div>
            </SettingsCard>
          </div>
        </div>
      )}

      {/* ── Local LLM configuration (only when local-llm selected) ── */}
      {provider === 'local-llm' && (
        <div className="space-y-6">
          {/* Section 1: Backend + Server Address */}
          <div>
            <h3 className="text-sm text-text-secondary uppercase tracking-wider mb-3 font-medium">
              Connection
            </h3>
            <SettingsCard>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 gap-y-4">
                {/* Backend selector */}
                <div>
                  <label className="text-xs font-medium text-text-secondary">Backend</label>
                  <div className="flex gap-2 mt-1">
                    {/* Always show Ollama */}
                    <button
                      onClick={() => handleBackendChange('ollama')}
                      className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
                        backend === 'ollama'
                          ? 'border-primary bg-primary-muted text-primary-text'
                          : 'border-border-subtle hover:bg-surface-overlay text-text-secondary'
                      }`}
                    >
                      🦙
                      <div className="text-left">
                        <div>Ollama</div>
                        <div className="text-[10px] font-normal text-text-muted">
                          Cross-platform
                        </div>
                      </div>
                    </button>

                    {/* Show oMLX only on macOS Apple Silicon */}
                    {platformInfo?.isAppleSilicon && (
                      <button
                        onClick={() => handleBackendChange('omlx')}
                        className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
                          backend === 'omlx'
                            ? 'border-primary bg-primary-muted text-primary-text'
                            : 'border-border-subtle hover:bg-surface-overlay text-text-secondary'
                        }`}
                      >
                        🐧
                        <div className="text-left">
                          <div>oMLX</div>
                          <div className="text-[10px] font-normal text-text-muted">
                            Apple Silicon native
                          </div>
                        </div>
                      </button>
                    )}
                  </div>
                </div>

                {/* Server Address */}
                <div>
                  <label className="text-xs font-medium text-text-secondary">Server Address</label>
                  <div className="flex items-center gap-2 mt-1">
                    <input
                      value={localHost}
                      onChange={(e) => setLocalHost(e.target.value)}
                      onBlur={() => saveProviderSettings(provider, { host: localHost })}
                      placeholder="127.0.0.1"
                      className="flex-1 bg-surface-base border border-border-subtle rounded-lg px-3 py-1.5 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                    <span className="text-text-muted text-sm">:</span>
                    <input
                      value={localPort}
                      onChange={(e) => {
                        const defaultPort =
                          backend === 'omlx' ? OMLX_DEFAULT_PORT : OLLAMA_DEFAULT_PORT
                        setLocalPort(parseInt(e.target.value) || defaultPort)
                      }}
                      onBlur={() => saveProviderSettings(provider, { port: localPort })}
                      type="number"
                      placeholder={backend === 'omlx' ? '8000' : '11434'}
                      className="w-24 bg-surface-base border border-border-subtle rounded-lg px-3 py-1.5 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                    <button
                      onClick={() => testConnection()}
                      disabled={connectionTesting}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary border border-border-default hover:bg-surface-hover rounded-lg transition-colors disabled:opacity-50"
                    >
                      {connectionTesting ? <Loader2 size={12} className="animate-spin" /> : 'Test'}
                    </button>
                  </div>
                  {/* Connection status badge */}
                  {localStatus && (
                    <div className="mt-2">
                      {localStatus.running ? (
                        <>
                          <span className="inline-flex items-center gap-1.5 text-xs text-green-400">
                            <span className="w-2 h-2 rounded-full bg-green-400" />
                            Connected
                            {backend === 'ollama' && localStatus.version
                              ? ` — Ollama v${localStatus.version}`
                              : backend === 'omlx'
                                ? ' — oMLX'
                                : ''}
                            {localStatus.models.length > 0 &&
                              ` · ${localStatus.models.length} model${localStatus.models.length !== 1 ? 's' : ''}`}
                          </span>
                          {/* No-models warning — show actionable list when admin API has downloaded models */}
                          {localStatus.models.length === 0 &&
                            'allModels' in localStatus &&
                            localStatus.allModels &&
                            localStatus.allModels.length > 0 ? (
                              <div className="mt-2 p-2.5 rounded-lg border border-yellow-500/20 bg-yellow-500/5">
                                <p className="text-xs text-yellow-500 mb-2">
                                  {localStatus.allModels.length} model
                                  {localStatus.allModels.length !== 1 ? 's' : ''} downloaded but
                                  none loaded into memory. Select one to load:
                                </p>
                                <div className="space-y-1">
                                  {localStatus.allModels.map((model) => (
                                    <div
                                      key={model.id}
                                      className="flex items-center justify-between px-2 py-1.5 rounded border border-border-subtle"
                                    >
                                      <div>
                                        <span className="text-xs text-text-primary font-medium">
                                          {model.id}
                                        </span>
                                        <span className="text-[10px] text-text-muted ml-2">
                                          {model.estimatedSize}
                                        </span>
                                      </div>
                                      <button
                                        onClick={() => handleLoadOmlxModel(model.id)}
                                        disabled={model.isLoading || modelLoading === model.id}
                                        className="text-xs px-2.5 py-1 rounded border border-primary text-primary hover:bg-primary-muted transition-colors disabled:opacity-50"
                                      >
                                        {model.isLoading || modelLoading === model.id ? (
                                          <>
                                            <Loader2
                                              size={10}
                                              className="animate-spin inline mr-1"
                                            />
                                            Loading…
                                          </>
                                        ) : (
                                          'Load'
                                        )}
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ) : (
                              localStatus.models.length === 0 && (
                                <p className="text-xs text-yellow-500 mt-1.5">
                                  ⚠ No models loaded — load a model in{' '}
                                  {backend === 'omlx' ? (
                                    <a
                                      href={`http://${localHost}:${localPort}/admin`}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="underline hover:text-yellow-400"
                                    >
                                      oMLX admin panel
                                    </a>
                                  ) : (
                                    'Ollama'
                                  )}{' '}
                                  before starting a chat or audit.
                                </p>
                              )
                            )}
                        </>
                      ) : localStatus.installed ? (
                        <span className="inline-flex items-center gap-1.5 text-xs text-yellow-500">
                          <span className="w-2 h-2 rounded-full bg-yellow-500" />
                          Installed but not running
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-xs text-red-400">
                          <span className="w-2 h-2 rounded-full bg-red-400" />
                          {isRemoteServer ? 'Cannot reach server' : 'Not installed'}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* API Key (oMLX only — for authenticated admin API access) */}
                {backend === 'omlx' && (
                  <div className="md:col-span-2">
                    <label className="text-xs font-medium text-text-secondary">
                      API Key{' '}
                      <span className="font-normal text-text-muted">(optional)</span>
                    </label>
                    <div className="flex items-center gap-2 mt-1">
                      <input
                        value={localApiKey}
                        onChange={(e) => setLocalApiKey(e.target.value)}
                        onBlur={() => saveProviderSettings(provider, { apiKey: localApiKey })}
                        type="password"
                        placeholder="Enter oMLX API key if authentication is enabled"
                        className="flex-1 bg-surface-base border border-border-subtle rounded-lg px-3 py-1.5 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50"
                      />
                    </div>
                    <p className="text-[10px] text-text-muted mt-1">
                      Required if oMLX has an API key configured. Set in oMLX admin → Settings.
                    </p>
                  </div>
                )}
              </div>
            </SettingsCard>
          </div>

          {/* Section 2: Model Selector — full width */}
          <div>
            <h3 className="text-sm text-text-secondary uppercase tracking-wider mb-3 font-medium">
              Models
            </h3>
            <SettingsCard>
              <LocalModelSelector
                selectedModel={localModel}
                installedModels={localStatus?.models ?? []}
                downloadedModels={
                  localStatus && 'allModels' in localStatus
                    ? localStatus.allModels
                    : undefined
                }
                backend={backend}
                onSelect={handleLocalModelSelect}
                onLoadModel={handleLoadOmlxModel}
                onPull={(modelId) => {
                  if (backend === 'omlx') {
                    // Copy model name to clipboard + open downloader tab
                    navigator.clipboard.writeText(modelId)
                    const downloaderUrl = `http://${localHost}:${localPort}/admin/dashboard?tab=models&modelsTab=downloader`
                    window.open(downloaderUrl, '_blank')
                    addToast({
                      message: 'Model name copied — paste it in the oMLX downloader',
                      type: 'info'
                    })
                  } else {
                    setLocalModel(modelId)
                    setShowOllamaSetup(true)
                  }
                }}
                onCopyAndOpenDownloader={(modelName) => {
                  navigator.clipboard.writeText(modelName)
                  const downloaderUrl = `http://${localHost}:${localPort}/admin/dashboard?tab=models&modelsTab=downloader`
                  window.open(downloaderUrl, '_blank')
                  addToast({
                    message: 'Model name copied — paste it in the oMLX downloader',
                    type: 'info'
                  })
                }}
              />
            </SettingsCard>
          </div>
        </div>
      )}

      {/* Ollama setup modal — only used for Ollama backend pull flow */}
      {showOllamaSetup && (
        <OllamaSetupModal
          model={localModel}
          baseUrl={localBaseUrl}
          isRemote={isRemoteServer}
          onClose={() => {
            setShowOllamaSetup(false)
            testConnection().then((status) => {
              if (status?.running) {
                const hasModel = status.models.some(
                  (m) => m === localModel || m.startsWith(`${localModel}:`)
                )
                if (hasModel) {
                  setProvider('local-llm')
                  saveProviderSettings('local-llm')
                }
              }
            })
          }}
        />
      )}
    </div>
  )
}
