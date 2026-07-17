/**
 * ProviderCards — Two always-visible provider connection cards (Claude + oMLX).
 *
 * These are the providers available for routing. Configure connections here.
 * No default/active concept — provider is derived from Model Routing config.
 *
 * Each card has: status dot + name + connection status text,
 *   provider-specific body, and a footer with save affordance.
 */

import { useState } from 'react'
import { Loader2, Cloud, Cpu, CheckCircle2, ChevronDown, ChevronRight, Save, Code2 } from 'lucide-react'
import { SettingsCard } from '@renderer/components/common'
import { useToastStore } from '@renderer/store'
import { OMLX_DEFAULT_PORT } from '../../../../../shared/constants'
import type {
  ExecutorBackend,
  OmlxExtendedStatus,
  PlatformInfo
} from '../../../../../shared/types'
import type { ClaudeCliStatus, ConnectionDraft } from './useModelConfig'
import LocalModelSelector from '../LocalModelSelector'

// ─── Status Dot ──────────────────────────────────────────

type StatusDotColor = 'green' | 'gray' | 'red' | 'amber'

function StatusDot({ color }: { color: StatusDotColor }): React.JSX.Element {
  const colorClasses: Record<StatusDotColor, string> = {
    green: 'bg-success',
    gray: 'bg-text-muted',
    red: 'bg-red-400',
    amber: 'bg-amber-400'
  }
  return <span className={`inline-block w-2 h-2 rounded-full ${colorClasses[color]}`} />
}

// ─── Connection Status Chips (oMLX) ─────────────────────

function ConnectionStatusChips({
  localStatus,
  connectionTesting,
  localHost,
  localPort,
  isRemoteServer
}: {
  localStatus: OmlxExtendedStatus | null
  connectionTesting: boolean
  localHost: string
  localPort: number
  isRemoteServer: boolean
}): React.JSX.Element | null {
  if (connectionTesting) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-base border border-border-subtle text-xs text-text-secondary">
          <Loader2 size={11} className="animate-spin" />
          Connecting to oMLX…
        </span>
      </div>
    )
  }

  if (!localStatus) return null

  // Timeout-specific
  if (!localStatus.running && 'diagnostics' in localStatus) {
    const diag = localStatus.diagnostics
    if (diag?.timedOut) {
      return (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-xs text-amber-400">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            Connection timed out
          </span>
        </div>
      )
    }
  }

  if (!localStatus.running) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        {localStatus.installed ? (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-yellow-500/10 border border-yellow-500/20 text-xs text-yellow-500">
            <span className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
            Installed · Not running
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-500/10 border border-red-500/20 text-xs text-red-400">
            <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
            {isRemoteServer ? 'Cannot reach server' : 'Not installed'}
          </span>
        )}
      </div>
    )
  }

  // Auth-limited
  if ('diagnostics' in localStatus && localStatus.diagnostics?.adminAuthRequired) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-xs text-amber-400">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
          Connected (limited)
        </span>
        {localStatus.models.length > 0 && (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-base border border-border-subtle text-xs text-text-secondary">
            {localStatus.models.length} model{localStatus.models.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>
    )
  }

  const modelCount = localStatus.models.length
  const allModels = 'allModels' in localStatus && localStatus.allModels ? localStatus.allModels : null
  const embeddingModel = allModels?.find((m) => m.loaded && m.modelType === 'embedding')

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-success/10 border border-success/20 text-xs text-success">
        <span className="w-1.5 h-1.5 rounded-full bg-success" />
        Connected · oMLX
      </span>
      {modelCount > 0 && (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-base border border-border-subtle text-xs text-text-secondary">
          {modelCount} model{modelCount !== 1 ? 's' : ''} loaded
        </span>
      )}
      {embeddingModel && (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-xs text-cyan-400">
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
          Embeddings ready
        </span>
      )}
      {modelCount === 0 && (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-yellow-500/10 border border-yellow-500/20 text-xs text-yellow-500">
          No models loaded
          {allModels && allModels.length > 0 ? (
            ' — load one below'
          ) : (
            <a
              href={`http://${localHost}:${localPort}/admin`}
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-yellow-400 ml-1"
            >
              Open admin panel ↗
            </a>
          )}
        </span>
      )}
      {localStatus.running && !embeddingModel && modelCount > 0 && (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface-base border border-border-subtle text-xs text-text-muted">
          💡 Load an embedding model for Semantic Search
        </span>
      )}
    </div>
  )
}

// ─── Card Header ─────────────────────────────────────────

function ProviderCardHeader({
  icon,
  name,
  sublabel,
  statusDot,
  statusText
}: {
  icon: React.ReactNode
  name: string
  sublabel: string
  statusDot: StatusDotColor
  statusText: string
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 mb-4">
      <StatusDot color={statusDot} />
      <div className="flex items-center gap-2">
        {icon}
        <div>
          <h3 className="text-sm font-semibold text-text-primary">{name}</h3>
          <p className="text-xs text-text-muted">{sublabel}</p>
        </div>
      </div>
      <span className="ml-auto text-xs text-text-secondary">{statusText}</span>
    </div>
  )
}

// ─── Claude Provider Card ────────────────────────────────

interface ClaudeProviderCardProps {
  claudeCliStatus: ClaudeCliStatus | null
  executorBackend: ExecutorBackend
  onExecutorBackendChange: (backend: ExecutorBackend) => void
}

function ClaudeProviderCard({
  claudeCliStatus,
  executorBackend,
  onExecutorBackendChange
}: ClaudeProviderCardProps): React.JSX.Element {
  const addToast = useToastStore((s) => s.addToast)

  const handleBackendChange = (backend: ExecutorBackend): void => {
    if (backend === 'codex') {
      // Phase A: Codex executor not yet implemented — show status toast only
      window.api
        .validateSubscriptions()
        .then((result) => {
          const cliStatus = result.codexCli?.installed
            ? `CLI installed (${result.codexCli.version ?? 'unknown version'})`
            : 'CLI not found — install with: npm install -g @openai/codex'
          addToast({
            message: `Codex backend coming soon. ${cliStatus}`,
            type: 'info'
          })
        })
        .catch(() => {
          addToast({
            message: 'Codex backend coming soon',
            type: 'info'
          })
        })
      return
    }
    onExecutorBackendChange(backend)
  }

  const statusDot: StatusDotColor = claudeCliStatus
    ? claudeCliStatus.installed ? 'green' : 'gray'
    : 'gray'

  const statusText = claudeCliStatus
    ? claudeCliStatus.installed
      ? `CLI ${claudeCliStatus.version ?? 'installed'}`
      : 'CLI not found'
    : 'Checking…'

  return (
    <div data-testid="claude-config-section" className="rounded-lg border border-border-subtle bg-surface-float p-4">
      <ProviderCardHeader
        icon={<Cloud size={16} className="text-text-secondary" />}
        name="Claude"
        sublabel="Cloud API"
        statusDot={statusDot}
        statusText={statusText}
      />

      {/* ── Execution Backend ── */}
      <div className="mb-4">
        <h4 className="text-xs font-medium text-text-secondary mb-2">Execution Backend</h4>
        <div className="flex gap-2">
          {([
            { value: 'cli' as ExecutorBackend, label: 'Claude CLI', desc: 'Max subscription billing', icon: <Cloud size={14} /> },
            { value: 'opencode' as ExecutorBackend, label: 'OpenCode', desc: 'Multi-provider runtime', icon: <Cpu size={14} /> },
            { value: 'codex' as ExecutorBackend, label: 'Codex', desc: 'OpenAI coding agent', icon: <Code2 size={14} /> }
          ]).map((opt) => (
            <button
              key={opt.value}
              onClick={() => handleBackendChange(opt.value)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition-colors flex-1 ${
                executorBackend === opt.value
                  ? 'border-primary bg-primary-muted text-primary-text'
                  : 'border-border-subtle hover:bg-surface-overlay text-text-secondary'
              }`}
            >
              {opt.icon}
              <div className="text-left">
                <div>{opt.label}</div>
                <div className="text-xs font-normal text-text-muted">{opt.desc}</div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="mt-3 flex items-center gap-1 text-xs text-text-muted">
        <CheckCircle2 size={10} className="text-success" />
        Saves automatically
      </div>
    </div>
  )
}

// ─── oMLX Provider Card ──────────────────────────────────

interface OmlxProviderCardProps {
  connectionDraft: ConnectionDraft
  isConnectionDirty: boolean
  localStatus: OmlxExtendedStatus | null
  connectionTesting: boolean
  modelLoading: string | null
  localModel: string
  localBaseUrl: string
  isRemoteServer: boolean
  platformInfo: PlatformInfo | null
  onHostChange: (host: string) => void
  onPortChange: (port: number) => void
  onApiKeyChange: (key: string) => void
  onContextWindowChange: (value: number | undefined) => void
  onSaveConnection: () => void
  onDiscardConnection: () => void
  onTestConnection: () => void
  onAutoTest: () => void
  onLocalModelSelect: (modelId: string) => void
  onLoadOmlxModel: (modelId: string) => void
  onUnloadOmlxModel: (modelId: string) => void
}

function OmlxProviderCard({
  connectionDraft,
  isConnectionDirty,
  localStatus,
  connectionTesting,
  modelLoading: _modelLoading,
  localModel,
  localBaseUrl: _localBaseUrl,
  isRemoteServer,
  platformInfo: _platformInfo,
  onHostChange,
  onPortChange,
  onApiKeyChange,
  onContextWindowChange,
  onSaveConnection,
  onDiscardConnection: _onDiscardConnection,
  onTestConnection,
  onAutoTest,
  onLocalModelSelect,
  onLoadOmlxModel,
  onUnloadOmlxModel
}: OmlxProviderCardProps): React.JSX.Element {
  const addToast = useToastStore((s) => s.addToast)
  const [modelsExpanded, setModelsExpanded] = useState(true)

  const statusDot: StatusDotColor = localStatus
    ? localStatus.running
      ? 'green'
      : 'diagnostics' in localStatus && localStatus.diagnostics?.timedOut
        ? 'amber'
        : 'red'
    : 'gray'

  const modelCount = localStatus?.models?.length ?? 0
  const statusText = localStatus
    ? localStatus.running
      ? `Connected · ${modelCount} model${modelCount !== 1 ? 's' : ''}`
      : localStatus.installed ? 'Not running' : 'Not reachable'
    : connectionTesting ? 'Connecting…' : 'Not configured'

  const handleContextWindowChange: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const raw = e.target.value
    if (raw === '') {
      onContextWindowChange(undefined)
    } else {
      const parsed = parseInt(raw, 10)
      if (!isNaN(parsed) && parsed > 0) {
        onContextWindowChange(parsed)
      }
    }
  }

  return (
    <div data-testid="local-llm-config" className="rounded-lg border border-border-subtle bg-surface-float p-4">
      <ProviderCardHeader
        icon={<Cpu size={16} className="text-text-secondary" />}
        name="oMLX"
        sublabel="Apple Silicon or remote server"
        statusDot={statusDot}
        statusText={statusText}
      />

      {/* ── Server Connection ── */}
      <SettingsCard>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 gap-y-4">
          <div>
            <label className="text-xs font-medium text-text-secondary">Server Address</label>
            <div className="flex items-center gap-2 mt-1">
              <input
                value={connectionDraft.localHost}
                onChange={(e) => onHostChange(e.target.value)}
                onBlur={() => onAutoTest()}
                placeholder="127.0.0.1"
                className="flex-1 bg-surface-base border border-border-subtle rounded-lg px-3 py-1.5 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
              <span className="text-text-muted text-sm">:</span>
              <input
                value={connectionDraft.localPort}
                onChange={(e) => onPortChange(parseInt(e.target.value) || OMLX_DEFAULT_PORT)}
                onBlur={() => onAutoTest()}
                type="number"
                placeholder="8000"
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
            <div className="mt-2">
              <ConnectionStatusChips
                localStatus={localStatus}
                connectionTesting={connectionTesting}
                localHost={connectionDraft.localHost}
                localPort={connectionDraft.localPort}
                isRemoteServer={isRemoteServer}
              />
            </div>
          </div>

          {/* API Key */}
          <div className="md:col-span-2">
            <label className="text-xs font-medium text-text-secondary">
              API Key <span className="font-normal text-text-muted">(optional)</span>
            </label>
            <div className="flex items-center gap-2 mt-1">
              <input
                value={connectionDraft.localApiKey}
                onChange={(e) => onApiKeyChange(e.target.value)}
                onBlur={() => onAutoTest()}
                type="password"
                placeholder="Enter oMLX API key if authentication is enabled"
                className="flex-1 bg-surface-base border border-border-subtle rounded-lg px-3 py-1.5 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
            <p className="text-xs text-text-muted mt-1">
              Required if oMLX has an API key configured. Set in oMLX admin → Settings.
            </p>
          </div>
        </div>
      </SettingsCard>

      {/* ── Server Models (collapsible) ── */}
      <div className="mt-4">
        <button
          onClick={() => setModelsExpanded(!modelsExpanded)}
          className="flex items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors mb-2"
        >
          {modelsExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          Server models{modelCount > 0 ? ` (${modelCount} loaded)` : ''}
        </button>
        {modelsExpanded && (
          <SettingsCard>
            <LocalModelSelector
              selectedModel={localModel}
              installedModels={localStatus?.models ?? []}
              downloadedModels={
                localStatus && 'allModels' in localStatus ? localStatus.allModels : undefined
              }
              backend="omlx"
              onSelect={onLocalModelSelect}
              onLoadModel={onLoadOmlxModel}
              onUnloadModel={onUnloadOmlxModel}
              onPull={(modelId) => {
                navigator.clipboard.writeText(modelId)
                const downloaderUrl = `http://${connectionDraft.localHost}:${connectionDraft.localPort}/admin/dashboard?tab=models&modelsTab=downloader`
                window.open(downloaderUrl, '_blank')
                addToast({
                  message: 'Model name copied — paste it in the oMLX downloader',
                  type: 'info'
                })
              }}
              onCopyAndOpenDownloader={(modelName) => {
                navigator.clipboard.writeText(modelName)
                const downloaderUrl = `http://${connectionDraft.localHost}:${connectionDraft.localPort}/admin/dashboard?tab=models&modelsTab=downloader`
                window.open(downloaderUrl, '_blank')
                addToast({
                  message: 'Model name copied — paste it in the oMLX downloader',
                  type: 'info'
                })
              }}
            />
          </SettingsCard>
        )}
      </div>

      {/* ── Context Window Override ── */}
      <div className="mt-4">
        <SettingsCard>
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <h4 className="text-sm font-medium text-text-primary">Context Window Override</h4>
              <p className="text-xs text-text-secondary mt-0.5">
                Override auto-detected context window (tokens). Leave empty to auto-detect.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <input
                value={connectionDraft.localContextWindow ?? ''}
                onChange={handleContextWindowChange}
                type="number"
                placeholder="Auto-detect"
                className="w-36 bg-surface-base border border-border-subtle rounded-lg px-3 py-1.5 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
              {connectionDraft.localContextWindow && (
                <button
                  onClick={() => onContextWindowChange(undefined)}
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

      {/* ── Footer: Save connection ── */}
      <div className="mt-3 flex items-center gap-3">
        {isConnectionDirty ? (
          <>
            <span className="inline-flex items-center gap-1.5 text-xs text-amber-400">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
              Unsaved
            </span>
            <button
              onClick={onSaveConnection}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg text-white bg-primary hover:bg-primary-hover transition-colors"
            >
              <Save size={12} />
              Save connection
            </button>
          </>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-text-muted">
            <CheckCircle2 size={10} className="text-success" />
            Connection saved
          </span>
        )}
      </div>
    </div>
  )
}

// ─── Main Grid ───────────────────────────────────────────

export interface ProviderCardsProps {
  claudeCliStatus: ClaudeCliStatus | null
  executorBackend: ExecutorBackend
  connectionDraft: ConnectionDraft
  isConnectionDirty: boolean
  localStatus: OmlxExtendedStatus | null
  connectionTesting: boolean
  modelLoading: string | null
  localModel: string
  localBaseUrl: string
  isRemoteServer: boolean
  platformInfo: PlatformInfo | null
  onExecutorBackendChange: (backend: ExecutorBackend) => void
  onHostChange: (host: string) => void
  onPortChange: (port: number) => void
  onApiKeyChange: (key: string) => void
  onContextWindowChange: (value: number | undefined) => void
  onSaveConnection: () => void
  onDiscardConnection: () => void
  onTestConnection: () => void
  onAutoTest: () => void
  onLocalModelSelect: (modelId: string) => void
  onLoadOmlxModel: (modelId: string) => void
  onUnloadOmlxModel: (modelId: string) => void
}

export default function ProviderCards(props: ProviderCardsProps): React.JSX.Element {
  return (
    <div data-testid="provider-toggle" className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
      <ClaudeProviderCard
        claudeCliStatus={props.claudeCliStatus}
        executorBackend={props.executorBackend}
        onExecutorBackendChange={props.onExecutorBackendChange}
      />
      <OmlxProviderCard
        connectionDraft={props.connectionDraft}
        isConnectionDirty={props.isConnectionDirty}
        localStatus={props.localStatus}
        connectionTesting={props.connectionTesting}
        modelLoading={props.modelLoading}
        localModel={props.localModel}
        localBaseUrl={props.localBaseUrl}
        isRemoteServer={props.isRemoteServer}
        platformInfo={props.platformInfo}
        onHostChange={props.onHostChange}
        onPortChange={props.onPortChange}
        onApiKeyChange={props.onApiKeyChange}
        onContextWindowChange={props.onContextWindowChange}
        onSaveConnection={props.onSaveConnection}
        onDiscardConnection={props.onDiscardConnection}
        onTestConnection={props.onTestConnection}
        onAutoTest={props.onAutoTest}
        onLocalModelSelect={props.onLocalModelSelect}
        onLoadOmlxModel={props.onLoadOmlxModel}
        onUnloadOmlxModel={props.onUnloadOmlxModel}
      />
    </div>
  )
}
