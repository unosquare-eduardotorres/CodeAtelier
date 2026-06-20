import { Cloud, Monitor } from 'lucide-react'
import { SettingsCard } from '@renderer/components/common'
import type { LLMProvider } from '../../../../../shared/types'

interface ProviderToggleProps {
  provider: LLMProvider
  onProviderChange: (provider: LLMProvider) => void
}

export default function ProviderToggle({
  provider,
  onProviderChange
}: ProviderToggleProps): React.JSX.Element {
  return (
    <div data-testid="provider-toggle" className="mb-8">
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
            onClick={() => onProviderChange('claude')}
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
            onClick={() => onProviderChange('local-llm')}
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
  )
}
