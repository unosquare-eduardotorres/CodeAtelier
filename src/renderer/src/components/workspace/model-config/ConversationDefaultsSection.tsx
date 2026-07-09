import { MessageSquare, Heart, Sun, Flame, Bone, Zap, CheckCircle2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { COMMUNICATION_TONES } from '../../../../../shared/constants'
import type { CommunicationTone } from '../../../../../shared/types'

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
  caveman: '"FIX BUG line 42. Null check missing"'
}

interface ConversationDefaultsSectionProps {
  communicationTone: CommunicationTone
  onToneChange: (tone: CommunicationTone) => void
}

export default function ConversationDefaultsSection({
  communicationTone,
  onToneChange
}: ConversationDefaultsSectionProps): React.JSX.Element {
  return (
    <div data-testid="conversation-defaults-section" className="mt-8">
      <div className="flex items-center gap-2 mb-3">
        <h3 className="text-sm text-text-secondary uppercase tracking-wider font-medium">
          Workspace Defaults
        </h3>
        <span className="inline-flex items-center gap-1 text-xs text-text-muted">
          <CheckCircle2 size={10} className="text-success" />
          Saves automatically
        </span>
      </div>
      <div className="rounded-lg border border-border-subtle bg-surface-float p-4">
        {/* Header row */}
        <div className="flex items-center gap-2 mb-3">
          <MessageSquare size={14} className="text-primary-text" />
          <h4 className="text-sm font-medium text-text-primary">Communication Tone</h4>
          <span className="text-xs text-text-muted ml-auto">
            Applies to all providers
          </span>
        </div>

        {/* Compact pill row */}
        <div className="flex items-center gap-1.5 mb-2">
          {COMMUNICATION_TONES.map((tone) => {
            const Icon = TONE_ICONS[tone.icon] ?? MessageSquare
            const isActive = communicationTone === tone.id
            return (
              <button
                key={tone.id}
                onClick={() => void onToneChange(tone.id as CommunicationTone)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                  isActive
                    ? 'bg-primary-muted border border-primary/30 text-primary-text'
                    : 'border border-border-subtle hover:bg-surface-overlay text-text-secondary hover:text-text-primary'
                }`}
                title={tone.description}
              >
                <Icon size={12} className={isActive ? 'text-primary-text' : undefined} />
                {tone.label}
              </button>
            )
          })}
        </div>

        {/* Single-line italic preview */}
        <p className="text-xs text-text-secondary italic truncate">
          {TONE_PREVIEWS[communicationTone]}
        </p>

        {communicationTone === 'caveman' && (
          <p className="text-xs text-text-muted mt-1.5 flex items-center gap-1.5">
            <Zap size={12} className="text-success" />
            CaveMan mode saves ~60-75% output tokens by dropping filler words while keeping all
            technical substance.
          </p>
        )}
      </div>
    </div>
  )
}
