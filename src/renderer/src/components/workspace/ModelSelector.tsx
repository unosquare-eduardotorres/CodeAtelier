import { RotateCcw } from 'lucide-react'
import { AVAILABLE_MODELS, DEFAULT_MODEL_CONFIG } from '../../../../shared/constants'
import type { ModelAction } from '../../../../shared/types'
import { AgentIcon, AGENT_ICON_MAP } from '@renderer/assets/agent-icons'

interface ModelSelectorProps {
  action: ModelAction
  label: string
  description: string
  icon: string
  selectedModel: string
  onChange: (action: ModelAction, modelId: string) => void
  onReset: (action: ModelAction) => void
}

export default function ModelSelector({
  action,
  label,
  description,
  icon,
  selectedModel,
  onChange,
  onReset
}: ModelSelectorProps): React.JSX.Element {
  const defaultModel = DEFAULT_MODEL_CONFIG[action]
  const isOverridden = selectedModel !== defaultModel
  const defaultModelLabel = AVAILABLE_MODELS.find((m) => m.id === defaultModel)?.label ?? 'Unknown'

  return (
    <div
      className={`relative bg-surface-overlay border rounded p-4 shadow-sm transition-colors ${
        isOverridden ? 'border-mode-build/40 bg-mode-build/[0.03]' : 'border-border-subtle'
      }`}
    >
      {/* Left accent bar for overridden items */}
      {isOverridden && (
        <div className="absolute left-0 top-3 bottom-3 w-0.5 rounded-full bg-mode-build" />
      )}

      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          {AGENT_ICON_MAP[action] ? (
            <AgentIcon agentType={action} size={22} />
          ) : (
            <span className="text-base flex-shrink-0">{icon}</span>
          )}
          <div className="min-w-0">
            <h4 className="text-sm font-medium text-text-primary">{label}</h4>
            <p className="text-xs text-text-muted mt-0.5">{description}</p>
          </div>
        </div>
        <span className="text-xs text-text-muted whitespace-nowrap flex-shrink-0 mt-0.5">
          Default: {defaultModelLabel}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex gap-2 flex-1">
          {AVAILABLE_MODELS.map((model) => {
            const isSelected = selectedModel === model.id
            const isDefault = model.id === defaultModel
            return (
              <button
                key={model.id}
                onClick={() => onChange(action, model.id)}
                className={`flex-1 flex flex-col items-center gap-1 px-3 py-2.5 rounded-lg border text-xs font-medium transition-colors ${
                  isSelected
                    ? 'border-primary bg-primary-muted text-primary-text'
                    : 'border-border-subtle hover:bg-surface-overlay text-text-secondary hover:text-text-primary'
                }`}
              >
                <span className="flex items-center gap-1">
                  {model.label}
                  {isDefault && (
                    <span className="text-xs px-1 py-0.5 rounded bg-surface-raised text-text-muted font-normal">
                      default
                    </span>
                  )}
                </span>
                <span className="text-xs text-text-muted font-normal">{model.description}</span>
              </button>
            )
          })}
        </div>

        {/* Reset button — only visible when overridden */}
        {isOverridden && (
          <button
            onClick={() => onReset(action)}
            className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs text-mode-build-text hover:bg-mode-build-muted transition-colors flex-shrink-0"
            title={`Reset to default (${defaultModelLabel})`}
          >
            <RotateCcw size={12} />
            <span className="hidden sm:inline">Reset</span>
          </button>
        )}
      </div>

      {/* Override warning label */}
      {isOverridden && (
        <p className="text-xs text-mode-build-text/80 mt-2">
          ⚠️ Modified — default is {defaultModelLabel}
        </p>
      )}
    </div>
  )
}
