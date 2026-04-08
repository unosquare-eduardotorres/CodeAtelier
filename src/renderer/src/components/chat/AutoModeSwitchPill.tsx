import { ArrowRightLeft } from 'lucide-react'
import { useChatStore } from '@renderer/store'

export default function AutoModeSwitchPill(): React.JSX.Element | null {
  const pill = useChatStore((s) => s.autoModeSwitchPill)
  const clearPill = useChatStore((s) => s.clearAutoModeSwitchPill)

  if (!pill) return null

  return (
    <div className="flex items-center justify-center py-2 animate-in fade-in slide-in-from-top-2 duration-300">
      <div
        className="flex items-center gap-2 px-3 py-1.5 rounded-full
                    bg-mode-plan-muted border border-mode-plan-border text-mode-plan-text text-xs font-medium"
      >
        <ArrowRightLeft size={12} />
        <span>Changed to Plan Mode</span>
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
