import { ArrowRightLeft, ClipboardList, Hammer } from 'lucide-react'
import { useChatStore } from '@renderer/store'

export default function AutoModeSwitchPill(): React.JSX.Element | null {
  const pill = useChatStore((s) => s.autoModeSwitchPill)
  const clearPill = useChatStore((s) => s.clearAutoModeSwitchPill)

  if (!pill) return null

  const isPlan = pill.to === 'plan'
  const label = isPlan ? 'Plan' : 'Build'
  const Icon = isPlan ? ClipboardList : Hammer
  const colorClasses = isPlan
    ? 'bg-mode-plan-muted border-mode-plan-border text-mode-plan-text'
    : 'bg-mode-build-muted border-mode-build-border text-mode-build-text'

  return (
    <div className="flex items-center justify-center py-2 animate-in fade-in slide-in-from-top-2 duration-300">
      <div
        className={`flex items-center gap-2 px-3 py-1.5 rounded-full
                    border text-xs font-medium ${colorClasses}`}
      >
        <ArrowRightLeft size={12} />
        <Icon size={12} />
        <span>Changed to {label} Mode</span>
        <button
          onClick={clearPill}
          className="ml-1 text-text-muted hover:text-text-primary transition-colors"
          aria-label="Dismiss"
        >
          &times;
        </button>
      </div>
    </div>
  )
}
