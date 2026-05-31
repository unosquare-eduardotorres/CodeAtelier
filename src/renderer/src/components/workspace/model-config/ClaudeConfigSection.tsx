import {
  Zap,
  Coins,
  Scale,
  Rocket,
  DollarSign,
  MessageSquare,
  Heart,
  Sun,
  Flame,
  Bone
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { SettingsCard } from '@renderer/components/common'
import { COMMUNICATION_TONES } from '../../../../../shared/constants'
import type { CommunicationTone, CostPreference } from '../../../../../shared/types'

/** Map tone icon names to Lucide components */
const TONE_ICONS: Record<string, LucideIcon> = {
  MessageSquare,
  Heart,
  Sun,
  Flame,
  Bone
}

/** Sample responses for each tone — shown as preview when selected */
const TONE_PREVIEWS: Record<CommunicationTone, string> = {
  default:
    '"Found a null check issue on line 42. The variable is uninitialized when the API returns an empty array."',
  calm: '"This is fixable — the variable on line 42 needs a fallback for when the API returns empty. Here\'s why it happens and how to sort it out."',
  optimistic:
    '"Good catch — we\'re one fix away from solid. Add a fallback on line 42 and this whole flow is rock-solid."',
  brutal: '"Bug. Line 42, no null check. Crashes on empty API response. Add a fallback."',
  caveman:
    '"Bug line 42. Null check missing. Variable uninitialized when API return empty array. Fix: add fallback."'
}

const COST_PREF_ICON: Record<CostPreference, React.ReactNode> = {
  economy: <Coins size={16} />,
  balanced: <Scale size={16} />,
  power: <Rocket size={16} />
}

interface ClaudeConfigSectionProps {
  costPreference: CostPreference
  fastMode: boolean
  budgetCapUsd: number | undefined
  communicationTone: CommunicationTone
  onCostPreferenceChange: (pref: CostPreference) => void
  onFastModeToggle: () => void
  onBudgetCapChange: (value: string) => void
  onToneChange: (tone: CommunicationTone) => void
}

export default function ClaudeConfigSection({
  costPreference,
  fastMode,
  budgetCapUsd,
  communicationTone,
  onCostPreferenceChange,
  onFastModeToggle,
  onBudgetCapChange,
  onToneChange
}: ClaudeConfigSectionProps): React.JSX.Element {
  return (
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
                <Zap size={14} className={fastMode ? 'text-mode-build-text' : 'text-text-muted'} />
                <h4 className="text-sm font-medium text-text-primary">Fast Mode</h4>
                {fastMode && (
                  <span className="text-xs px-1.5 py-0.5 rounded-full bg-mode-build-muted text-mode-build-text font-medium">
                    ON
                  </span>
                )}
              </div>
              <p className="text-xs text-text-secondary mt-1">
                {fastMode
                  ? 'Responses ~2.5× faster at 3× lower cost than previous Fast tier. Only affects the generalist chat — specialist agents run independently.'
                  : 'Uses included Claude Max usage at standard speed. Enable for faster responses.'}
              </p>
            </div>
            <button
              onClick={onFastModeToggle}
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
                onClick={() => onCostPreferenceChange(pref)}
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

      {/* Per-Turn Budget Cap */}
      <div className="col-span-full mt-2">
        <h3 className="text-sm text-text-secondary uppercase tracking-wider mb-3 font-medium">
          Budget
        </h3>
        <SettingsCard>
          <div className="flex items-start gap-3">
            <DollarSign size={14} className="text-text-muted mt-0.5 shrink-0" />
            <div className="flex-1">
              <h4 className="text-sm font-medium text-text-primary">Per-Turn Budget Cap (USD)</h4>
              <p className="text-xs text-text-secondary mt-0.5 mb-3">
                Optional. Leave empty for no cap (recommended for Claude Max subscriptions). If set,
                build mode gets 2× and audits get 3× this amount.
              </p>
              <input
                type="number"
                min={0}
                step={0.5}
                placeholder="No cap (recommended)"
                value={budgetCapUsd ?? ''}
                onChange={(e) => void onBudgetCapChange(e.target.value)}
                className="w-48 bg-surface-base border border-border-subtle rounded-lg px-3 py-1.5 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
              {budgetCapUsd != null && budgetCapUsd > 0 && (
                <p className="text-xs text-text-muted mt-2">
                  Plan: ${budgetCapUsd.toFixed(2)} · Build: ${(budgetCapUsd * 2).toFixed(2)} ·
                  Audit: ${(budgetCapUsd * 3).toFixed(2)}
                </p>
              )}
            </div>
          </div>
        </SettingsCard>
      </div>

      {/* Communication Tone */}
      <div className="col-span-full mt-2">
        <h3 className="text-sm text-text-secondary uppercase tracking-wider mb-3 font-medium">
          Communication Tone
        </h3>
        <SettingsCard>
          <div className="mb-1">
            <div className="flex items-center gap-2 mb-1">
              <MessageSquare size={14} className="text-primary-text" />
              <h4 className="text-sm font-medium text-text-primary">How the AI communicates</h4>
              <span className="text-xs text-text-muted ml-auto">Workspace default</span>
            </div>
            <p className="text-xs text-text-secondary mb-3">
              Sets the default tone for all new conversations. Individual chats can override this.
            </p>
          </div>
          <div className="grid grid-cols-5 gap-2 mb-3">
            {COMMUNICATION_TONES.map((tone) => {
              const Icon = TONE_ICONS[tone.icon] ?? MessageSquare
              const isActive = communicationTone === tone.id
              return (
                <button
                  key={tone.id}
                  onClick={() => void onToneChange(tone.id as CommunicationTone)}
                  className={`flex flex-col items-center gap-1.5 p-3 rounded-lg border text-center transition-all focus-visible:ring-2 focus-visible:ring-primary/50 ${
                    isActive
                      ? 'bg-primary-muted border-primary/30 text-primary-text ring-1 ring-primary/20'
                      : 'border-border-subtle hover:bg-surface-overlay text-text-secondary hover:text-text-primary'
                  }`}
                >
                  <Icon size={18} className={isActive ? 'text-primary-text' : undefined} />
                  <span className="text-xs font-semibold leading-tight">{tone.label}</span>
                  <span className="text-[10px] text-text-muted leading-tight">
                    {tone.description}
                  </span>
                </button>
              )
            })}
          </div>
          {/* Preview quote for selected tone */}
          <div className="bg-surface-base rounded-md px-3 py-2 border border-border-subtle">
            <p className="text-[10px] text-text-muted uppercase tracking-wider mb-1">Preview</p>
            <p className="text-xs text-text-secondary italic">{TONE_PREVIEWS[communicationTone]}</p>
          </div>
          {communicationTone === 'caveman' && (
            <p className="text-xs text-text-muted mt-2 flex items-center gap-1.5">
              <Zap size={12} className="text-success" />
              CaveMan mode saves ~60-75% output tokens by dropping filler words while keeping all
              technical substance.
            </p>
          )}
        </SettingsCard>
      </div>
    </div>
  )
}
