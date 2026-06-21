import { Loader2 } from 'lucide-react'
import { SettingsCard } from '@renderer/components/common'
import { useToastStore } from '@renderer/store'
import { OLLAMA_DEFAULT_PORT, OMLX_DEFAULT_PORT } from '../../../../../shared/constants'
import type {
  LLMProvider,
  LocalLLMBackend,
  OllamaStatus,
  OmlxExtendedStatus,
  PlatformInfo
} from '../../../../../shared/types'
import LocalModelSelector from '../LocalModelSelector'
import OllamaSetupModal from '../OllamaSetupModal'

// ─── Connection Status Badge ──────────────────────────────

function ConnectionStatusBadge({
  localStatus,
  backend,
  localHost,
  localPort,
  localModel: _localModel,
  modelLoading,
  isRemoteServer,
  onLoadOmlxModel
}: {
  localStatus: OmlxExtendedStatus | OllamaStatus | null
  backend: LocalLLMBackend
  localHost: string
  localPort: number
  localModel: string
  modelLoading: string | null
  isRemoteServer: boolean
  onLoadOmlxModel: (modelId: string) => void
}): React.JSX.Element | null {
  if (!localStatus) return null

  if (!localStatus.running) {
    return localStatus.installed ? (
      <span className="inline-flex items-center gap-1.5 text-xs text-yellow-500">
        <span className="w-2 h-2 rounded-full bg-yellow-500" />
        Installed but not running
      </span>
    ) : (
      <span className="inline-flex items-center gap-1.5 text-xs text-red-400">
        <span className="w-2 h-2 rounded-full bg-red-400" />
        {isRemoteServer ? 'Cannot reach server' : 'Not installed'}
      </span>
    )
  }

  const versionSuffix =
    backend === 'ollama' && localStatus.version
      ? ` — Ollama v${localStatus.version}`
      : backend === 'omlx'
        ? ' — oMLX'
        : ''
  const modelCount = localStatus.models.length
  const allModels =
    'allModels' in localStatus && localStatus.allModels ? localStatus.allModels : null

  return (
    <>
      <span className="inline-flex items-center gap-1.5 text-xs text-green-400">
        <span className="w-2 h-2 rounded-full bg-green-400" />
        Connected{versionSuffix}
        {modelCount > 0 && ` · ${modelCount} model${modelCount !== 1 ? 's' : ''}`}
      </span>

      {/* No-models warning — show actionable list when admin API has downloaded models */}
      {modelCount === 0 && allModels && allModels.length > 0 ? (
        <div className="mt-2 p-2.5 rounded-lg border border-yellow-500/20 bg-yellow-500/5">
          <p className="text-xs text-yellow-500 mb-2">
            {allModels.length} model{allModels.length !== 1 ? 's' : ''} downloaded but none loaded
            into memory. Select one to load:
          </p>
          <div className="space-y-1">
            {allModels.map((model) => (
              <div
                key={model.id}
                className="flex items-center justify-between px-2 py-1.5 rounded border border-border-subtle"
              >
                <div>
                  <span className="text-xs text-text-primary font-medium">{model.id}</span>
                  <span className="text-[10px] text-text-muted ml-2">{model.estimatedSize}</span>
                </div>
                <button
                  onClick={() => onLoadOmlxModel(model.id)}
                  disabled={model.isLoading || modelLoading === model.id}
                  className="text-xs px-2.5 py-1 rounded border border-primary text-primary hover:bg-primary-muted transition-colors disabled:opacity-50"
                >
                  {model.isLoading || modelLoading === model.id ? (
                    <>
                      <Loader2 size={10} className="animate-spin inline mr-1" />
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
        modelCount === 0 && (
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
  )
}

// ─── Context Window Override Hook ─────────────────────────

function useContextWindowOverride(
  activeWorkspaceId: string,
  localContextWindow: number | undefined,
  onContextWindowChange: (value: number | undefined) => void
): {
  onChange: React.ChangeEventHandler<HTMLInputElement>
  onBlur: () => Promise<void>
  onClear: () => Promise<void>
} {
  const addToast = useToastStore((s) => s.addToast)

  async function persistContextWindow(value: number | undefined): Promise<void> {
    try {
      const settings = await window.api.getWorkspaceSettings({ workspaceId: activeWorkspaceId })
      await window.api.updateWorkspaceSettings({
        workspaceId: activeWorkspaceId,
        settings: { ...settings, localContextWindow: value ?? null }
      })
    } catch (err) {
      console.error('Failed to save context window override:', err)
    }
  }

  return {
    onChange: (e) => {
      const raw = e.target.value
      if (raw === '') {
        onContextWindowChange(undefined)
      } else {
        const parsed = parseInt(raw, 10)
        if (!isNaN(parsed) && parsed > 0) {
          onContextWindowChange(parsed)
        }
      }
    },
    onBlur: async () => {
      await persistContextWindow(localContextWindow)
      if (localContextWindow) {
        addToast({
          message: `Context window override set to ${localContextWindow.toLocaleString()} tokens`,
          type: 'success'
        })
      }
    },
    onClear: async () => {
      onContextWindowChange(undefined)
      await persistContextWindow(undefined)
      addToast({ message: 'Context window override cleared', type: 'info' })
    }
  }
}

// ─── OllamaSetupModal Close Handler ──────────────────────

/** Handles post-close re-check of connection and auto-provider switch. */
function handleOllamaSetupClose(
  onShowOllamaSetupChange: (show: boolean) => void,
  backend: LocalLLMBackend,
  localHost: string,
  localPort: number,
  localApiKey: string,
  localModel: string,
  setProvider: (provider: LLMProvider) => void,
  saveProviderSettings: (provider: LLMProvider) => Promise<void>
): void {
  onShowOllamaSetupChange(false)
  const baseUrl = `http://${localHost}:${localPort}`
  const check =
    backend === 'ollama'
      ? window.api.ollamaCheckStatus({ baseUrl })
      : window.api.omlxCheckStatus({ baseUrl, apiKey: localApiKey || undefined })
  check.then((status) => {
    if (status?.running) {
      const hasModel = status.models.some(
        (m: string) => m === localModel || m.startsWith(`${localModel}:`)
      )
      if (hasModel) {
        setProvider('local-llm')
        saveProviderSettings('local-llm')
      }
    }
  })
}

// ─── Component ────────────────────────────────────────────

interface LocalLLMConfigSectionProps {
  backend: LocalLLMBackend
  platformInfo: PlatformInfo | null
  localHost: string
  localPort: number
  localApiKey: string
  localContextWindow: number | undefined
  localStatus: OmlxExtendedStatus | OllamaStatus | null
  connectionTesting: boolean
  modelLoading: string | null
  localModel: string
  localBaseUrl: string
  isRemoteServer: boolean
  showOllamaSetup: boolean
  provider: LLMProvider
  activeWorkspaceId: string
  onBackendChange: (backend: LocalLLMBackend) => void
  onLocalModelSelect: (modelId: string) => void
  onLoadOmlxModel: (modelId: string) => void
  onTestConnection: () => void
  onHostChange: (host: string) => void
  onPortChange: (port: number) => void
  onApiKeyChange: (key: string) => void
  onContextWindowChange: (value: number | undefined) => void
  onShowOllamaSetupChange: (show: boolean) => void
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
  setProvider: (provider: LLMProvider) => void
  setLocalModel: (model: string) => void
}

export default function LocalLLMConfigSection({
  backend,
  platformInfo,
  localHost,
  localPort,
  localApiKey,
  localContextWindow,
  localStatus,
  connectionTesting,
  modelLoading,
  localModel,
  localBaseUrl,
  isRemoteServer,
  showOllamaSetup,
  provider,
  activeWorkspaceId,
  onBackendChange,
  onLocalModelSelect,
  onLoadOmlxModel,
  onTestConnection,
  onHostChange,
  onPortChange,
  onApiKeyChange,
  onContextWindowChange,
  onShowOllamaSetupChange,
  saveProviderSettings,
  setProvider,
  setLocalModel
}: LocalLLMConfigSectionProps): React.JSX.Element {
  const addToast = useToastStore((s) => s.addToast)
  const ctxWindow = useContextWindowOverride(
    activeWorkspaceId,
    localContextWindow,
    onContextWindowChange
  )

  return (
    <div data-testid="local-llm-config" className="space-y-6">
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
                <button
                  onClick={() => onBackendChange('ollama')}
                  className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
                    backend === 'ollama'
                      ? 'border-primary bg-primary-muted text-primary-text'
                      : 'border-border-subtle hover:bg-surface-overlay text-text-secondary'
                  }`}
                >
                  🦙
                  <div className="text-left">
                    <div>Ollama</div>
                    <div className="text-[10px] font-normal text-text-muted">Cross-platform</div>
                  </div>
                </button>

                {platformInfo?.isAppleSilicon && (
                  <button
                    onClick={() => onBackendChange('omlx')}
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
                  onChange={(e) => onHostChange(e.target.value)}
                  onBlur={() => saveProviderSettings(provider, { host: localHost })}
                  placeholder="127.0.0.1"
                  className="flex-1 bg-surface-base border border-border-subtle rounded-lg px-3 py-1.5 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
                <span className="text-text-muted text-sm">:</span>
                <input
                  value={localPort}
                  onChange={(e) => {
                    const defaultPort = backend === 'omlx' ? OMLX_DEFAULT_PORT : OLLAMA_DEFAULT_PORT
                    onPortChange(parseInt(e.target.value) || defaultPort)
                  }}
                  onBlur={() => saveProviderSettings(provider, { port: localPort })}
                  type="number"
                  placeholder={backend === 'omlx' ? '8000' : '11434'}
                  className="w-24 bg-surface-base border border-border-subtle rounded-lg px-3 py-1.5 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
                <button
                  onClick={() => onTestConnection()}
                  disabled={connectionTesting}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary border border-border-default hover:bg-surface-hover rounded-lg transition-colors disabled:opacity-50"
                >
                  {connectionTesting ? <Loader2 size={12} className="animate-spin" /> : 'Test'}
                </button>
              </div>
              {/* Connection status badge */}
              <div className="mt-2">
                <ConnectionStatusBadge
                  localStatus={localStatus}
                  backend={backend}
                  localHost={localHost}
                  localPort={localPort}
                  localModel={localModel}
                  modelLoading={modelLoading}
                  isRemoteServer={isRemoteServer}
                  onLoadOmlxModel={onLoadOmlxModel}
                />
              </div>
            </div>

            {/* API Key (oMLX only — for authenticated admin API access) */}
            {backend === 'omlx' && (
              <div className="md:col-span-2">
                <label className="text-xs font-medium text-text-secondary">
                  API Key <span className="font-normal text-text-muted">(optional)</span>
                </label>
                <div className="flex items-center gap-2 mt-1">
                  <input
                    value={localApiKey}
                    onChange={(e) => onApiKeyChange(e.target.value)}
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
              localStatus && 'allModels' in localStatus ? localStatus.allModels : undefined
            }
            backend={backend}
            onSelect={onLocalModelSelect}
            onLoadModel={onLoadOmlxModel}
            onPull={(modelId) => {
              if (backend === 'omlx') {
                navigator.clipboard.writeText(modelId)
                const downloaderUrl = `http://${localHost}:${localPort}/admin/dashboard?tab=models&modelsTab=downloader`
                window.open(downloaderUrl, '_blank')
                addToast({
                  message: 'Model name copied — paste it in the oMLX downloader',
                  type: 'info'
                })
              } else {
                setLocalModel(modelId)
                onShowOllamaSetupChange(true)
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

      {/* Section 3: Advanced — Context Window Override */}
      <div>
        <h3 className="text-sm text-text-secondary uppercase tracking-wider mb-3 font-medium">
          Advanced
        </h3>
        <SettingsCard>
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <h4 className="text-sm font-medium text-text-primary">Context Window Override</h4>
              <p className="text-xs text-text-secondary mt-0.5">
                Override the auto-detected context window size (in tokens). Leave empty to use the
                auto-detected value from the model table or backend API.
              </p>
              <p className="text-[10px] text-text-muted mt-1">
                Useful when oMLX scales the context window down for auto-compact, or when Ollama
                allocates less than the model supports based on available VRAM.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <input
                value={localContextWindow ?? ''}
                onChange={ctxWindow.onChange}
                onBlur={ctxWindow.onBlur}
                type="number"
                placeholder="Auto-detect"
                className="w-36 bg-surface-base border border-border-subtle rounded-lg px-3 py-1.5 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
              {localContextWindow && (
                <button
                  onClick={ctxWindow.onClear}
                  className="text-xs text-text-muted hover:text-text-secondary transition-colors"
                  title="Clear override"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        </SettingsCard>
      </div>

      {/* Ollama setup modal — only used for Ollama backend pull flow */}
      {showOllamaSetup && (
        <OllamaSetupModal
          model={localModel}
          baseUrl={localBaseUrl}
          isRemote={isRemoteServer}
          onClose={() =>
            handleOllamaSetupClose(
              onShowOllamaSetupChange,
              backend,
              localHost,
              localPort,
              localApiKey,
              localModel,
              setProvider,
              saveProviderSettings
            )
          }
        />
      )}
    </div>
  )
}
