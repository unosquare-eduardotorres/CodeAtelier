import { Sparkles } from 'lucide-react'
import { SettingsCard } from '@renderer/components/common'
import { ToggleRow } from '../settings-sections'
import { DEFAULT_MODEL_CONFIG } from '../../../../../shared/constants'

interface PromptOptimizerCardProps {
  enabled: boolean
  onToggle: (enabled: boolean) => Promise<void>
  onNavigateToModels?: () => void
}

export default function PromptOptimizerCard({
  enabled,
  onToggle,
  onNavigateToModels
}: PromptOptimizerCardProps): React.JSX.Element {
  const resolvedModel = DEFAULT_MODEL_CONFIG['prompt:optimize']

  return (
    <SettingsCard>
      <ToggleRow
        label="Prompt Optimizer"
        description="Auto-rewrites chat prompts for clarity before sending to the model."
        checked={enabled}
        onChange={onToggle}
      />

      {enabled && (
        <div className="space-y-2 pt-2 border-t border-border-subtle mt-3">
          <div className="flex items-center gap-2 pl-1">
            <Sparkles size={12} className="text-text-secondary" />
            <span className="text-xs text-text-secondary">
              Model: <span className="text-text-body font-medium">{resolvedModel}</span>
            </span>
            {onNavigateToModels && (
              <button
                onClick={onNavigateToModels}
                className="text-xs text-primary hover:text-primary-hover ml-1"
              >
                Configure in Models →
              </button>
            )}
          </div>
          <p className="text-[10px] text-text-muted pl-1">
            A one-shot call rewrites your prompt before dispatch. The original ↔ optimized text
            appears in a Prompt Optimizer activity card. Skipped for short prompts (&lt;80 chars)
            and slash commands.
          </p>
        </div>
      )}
    </SettingsCard>
  )
}
