import { Cloud } from 'lucide-react'
import { SettingsCard } from '@renderer/components/common'
import type { LLMProvider, LocalLLMBackend, PlatformInfo } from '../../../../../shared/types'

interface ProviderToggleProps {
  provider: LLMProvider
  backend: LocalLLMBackend
  platformInfo: PlatformInfo | null
  onProviderChange: (provider: LLMProvider, backend?: LocalLLMBackend) => void
}

export default function ProviderToggle({
  provider,
  backend,
  platformInfo,
  onProviderChange
}: ProviderToggleProps): React.JSX.Element {
  const isClaude = provider === 'claude'
  const isOllama = provider === 'local-llm' && backend === 'ollama'
  const isOmlx = provider === 'local-llm' && backend === 'omlx'

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

        {/* Provider toggle buttons — unified 3-way selector */}
        <div className="flex gap-2">
          {/* Claude */}
          <button
            onClick={() => onProviderChange('claude')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border text-sm font-medium transition-colors flex-1 ${
              isClaude
                ? 'border-primary bg-primary-muted text-primary-text'
                : 'border-border-subtle hover:bg-surface-overlay text-text-secondary'
            }`}
          >
            <Cloud size={16} />
            <div className="text-left">
              <div>Claude</div>
              <div className="text-[10px] font-normal text-text-muted">Cloud API</div>
            </div>
          </button>

          {/* Ollama */}
          <button
            onClick={() => onProviderChange('local-llm', 'ollama')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border text-sm font-medium transition-colors flex-1 ${
              isOllama
                ? 'border-primary bg-primary-muted text-primary-text'
                : 'border-border-subtle hover:bg-surface-overlay text-text-secondary'
            }`}
          >
            <span className="text-base">🦙</span>
            <div className="text-left">
              <div>Ollama</div>
              <div className="text-[10px] font-normal text-text-muted">Cross-platform</div>
            </div>
          </button>

          {/* oMLX — Apple Silicon only */}
          {platformInfo?.isAppleSilicon && (
            <button
              onClick={() => onProviderChange('local-llm', 'omlx')}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border text-sm font-medium transition-colors flex-1 ${
                isOmlx
                  ? 'border-primary bg-primary-muted text-primary-text'
                  : 'border-border-subtle hover:bg-surface-overlay text-text-secondary'
              }`}
            >
              <span className="text-base">🐧</span>
              <div className="text-left">
                <div>oMLX</div>
                <div className="text-[10px] font-normal text-text-muted">Apple Silicon</div>
              </div>
            </button>
          )}
        </div>
      </SettingsCard>
    </div>
  )
}
