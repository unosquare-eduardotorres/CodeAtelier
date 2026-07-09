/**
 * ModelPicker — two-step provider → model selector for new chat creation.
 *
 * Emits (provider, modelId) directly — no preset indirection.
 * Claude model selection stores overrides via workspace modelOverrides;
 * local model selection uses the workspace-configured local model.
 */

import { useMemo } from 'react'
import { Monitor, Settings } from 'lucide-react'
import { AVAILABLE_MODELS } from '../../../../shared/constants'
import type { LLMProvider, PlatformInfo } from '../../../../shared/types'
import type { LocalModelInfo } from './useWorkspaceModelInfo'

interface ModelPickerProps {
  /** Currently selected provider */
  provider: LLMProvider
  /** Currently selected Claude model ID (e.g. 'claude-opus-4-8') */
  selectedModelId: string | null
  /** Local model info from workspace settings */
  localModelInfo: LocalModelInfo | null
  /** Platform info for Apple Silicon detection */
  platformInfo: PlatformInfo | null
  /** Called when user changes selection */
  onChange: (provider: LLMProvider, modelId: string | null) => void
  /** Compact mode for sidebar modal */
  compact?: boolean
}

// ── Provider definitions ──

type ProviderOption = {
  value: LLMProvider
  label: string
  icon: string
  backendFilter?: string
}

const PROVIDER_OPTIONS: ProviderOption[] = [
  { value: 'claude', label: 'Claude', icon: '☁️' },
  { value: 'local-llm', label: 'Ollama', icon: '🦙', backendFilter: 'ollama' },
  { value: 'local-llm', label: 'oMLX', icon: '🐧', backendFilter: 'omlx' }
]

/** Default Claude model when none is selected */
const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-8'

// ── Component ──

export function ModelPicker({
  provider,
  selectedModelId,
  localModelInfo,
  platformInfo,
  onChange,
  compact
}: ModelPickerProps): React.JSX.Element {
  // Determine which local backend is currently configured
  const localBackend = localModelInfo?.backend ?? 'ollama'
  const localModelName = localModelInfo?.model ?? 'unknown'

  // Filter visible providers based on workspace config
  const visibleProviders = useMemo(() => {
    const result: ProviderOption[] = [PROVIDER_OPTIONS[0]] // Claude always visible

    const hasOllama = localModelInfo && localBackend === 'ollama'
    const hasOmlx =
      localModelInfo &&
      localBackend === 'omlx' &&
      platformInfo?.isAppleSilicon

    if (hasOllama) result.push(PROVIDER_OPTIONS[1])
    if (hasOmlx) result.push(PROVIDER_OPTIONS[2])

    // If local-llm is configured but backend doesn't match known labels,
    // show generic "Local LLM" option
    if (!hasOllama && !hasOmlx && localModelInfo) {
      result.push({
        value: 'local-llm',
        label: 'Local LLM',
        icon: '🖥️'
      })
    }

    return result
  }, [localModelInfo, localBackend, platformInfo])

  // Derive active model ID
  const activeModelId = useMemo(() => {
    if (provider !== 'claude') return null
    return selectedModelId ?? DEFAULT_CLAUDE_MODEL
  }, [provider, selectedModelId])

  // ── Handlers ──

  const handleProviderChange = (p: LLMProvider): void => {
    if (p === 'claude') {
      onChange('claude', activeModelId ?? DEFAULT_CLAUDE_MODEL)
    } else {
      onChange('local-llm', null)
    }
  }

  const handleModelChange = (modelId: string): void => {
    onChange('claude', modelId)
  }

  // ── Compact mode (sidebar modal) ──

  if (compact) {
    return (
      <div data-testid="model-picker-compact">
        <label className="block text-sm font-medium text-text-primary mb-1.5">Default chat model</label>
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* Claude model pills */}
          {AVAILABLE_MODELS.slice().reverse().map((m) => (
            <button
              key={m.id}
              onClick={() => handleModelChange(m.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors
                focus-visible:ring-2 focus-visible:ring-primary/50 ${
                  provider === 'claude' && activeModelId === m.id
                    ? 'bg-primary-muted text-primary-text border border-primary/20'
                    : 'text-text-secondary hover:bg-surface-overlay border border-transparent'
                }`}
            >
              ☁️ {m.label}
            </button>
          ))}
          {/* Local model pill (if configured) */}
          {visibleProviders.some((p) => p.value === 'local-llm') && (
            <button
              onClick={() => handleProviderChange('local-llm')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors
                focus-visible:ring-2 focus-visible:ring-primary/50 ${
                  provider === 'local-llm'
                    ? 'bg-primary-muted text-primary-text border border-primary/20'
                    : 'text-text-secondary hover:bg-surface-overlay border border-transparent'
                }`}
            >
              {localBackend === 'omlx' ? '🐧' : '🦙'} {localModelName}
            </button>
          )}
        </div>
      </div>
    )
  }

  // ── Full mode (NewChatPage) ──

  return (
    <div className="w-full mb-5" data-testid="model-picker">
      <label className="block text-sm font-medium text-text-primary mb-1.5">Default chat model</label>

      {/* Row 1 — Provider pills */}
      <div className="flex items-center gap-2 bg-surface-overlay rounded-lg p-1 border border-border-subtle w-fit mb-2">
        {visibleProviders.map((opt, i) => {
          const isActive =
            opt.value === provider &&
            (opt.value === 'claude' || opt.backendFilter === localBackend || !opt.backendFilter)
          return (
            <button
              key={`${opt.value}-${i}`}
              onClick={() => handleProviderChange(opt.value)}
              className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
                  isActive
                    ? 'bg-primary-muted text-primary-text border border-primary/30'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
            >
              <span>{opt.icon}</span>
              {opt.label}
            </button>
          )
        })}
      </div>

      {/* Row 2 — Model pills (Claude) or local model info */}
      {provider === 'claude' ? (
        <div className="flex items-center gap-1.5 flex-wrap">
          {AVAILABLE_MODELS.slice().reverse().map((m) => {
            const isActive = activeModelId === m.id
            const isOpus = m.tier === 'opus'
            return (
              <button
                key={m.id}
                onClick={() => handleModelChange(m.id)}
                className={`flex flex-col items-center px-4 py-2 rounded-md text-xs font-medium transition-colors
                  focus-visible:ring-2 focus-visible:ring-primary/50 ${
                    isActive
                      ? 'bg-primary-muted text-primary-text border border-primary/20'
                      : 'text-text-secondary hover:bg-surface-overlay border border-transparent'
                  }`}
              >
                <span className="flex items-center gap-1">
                  {m.label}
                  {isOpus && <span className="text-warning text-[10px]">★</span>}
                </span>
                <span className="text-[10px] text-text-muted mt-0.5">{m.description}</span>
              </button>
            )
          })}
        </div>
      ) : (
        <div className="flex items-center gap-2 text-xs text-text-secondary px-1 py-1.5">
          <Monitor size={14} className="text-text-muted" />
          <span>
            Currently configured:{' '}
            <span className="text-text-primary font-medium">{localModelName}</span>
          </span>
          <button
            onClick={() => {
              // Navigate to workspace settings
              window.dispatchEvent(new CustomEvent('navigate-workspace-settings', { detail: 'model-config' }))
            }}
            className="flex items-center gap-1 text-primary hover:text-primary-hover transition-colors ml-2"
          >
            <Settings size={12} />
            Change in settings
          </button>
        </div>
      )}
    </div>
  )
}
