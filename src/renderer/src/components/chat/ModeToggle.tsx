import { ClipboardList, Hammer } from 'lucide-react'
import type { ConversationMode } from '../../../../shared/types'

interface ModeToggleProps {
  mode: ConversationMode
  onChange: (mode: ConversationMode) => void
  disabled?: boolean
}

export default function ModeToggle({
  mode,
  onChange,
  disabled
}: ModeToggleProps): React.JSX.Element {
  const isMac = navigator.platform.toUpperCase().includes('MAC')
  const shortcut = isMac ? '⌘.' : 'Ctrl+.'

  return (
    <div
      className="flex items-center gap-1.5 bg-surface-overlay rounded-lg p-0.5 border border-border-subtle"
      title={`Toggle mode (${shortcut})`}
    >
      <button
        onClick={() => onChange('plan')}
        disabled={disabled}
        className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-mode-plan/50 ${
          mode === 'plan'
            ? 'bg-mode-plan-muted text-mode-plan-text border border-mode-plan-border'
            : 'text-text-secondary hover:text-text-primary'
        }`}
      >
        <ClipboardList size={12} />
        Plan
      </button>
      <button
        onClick={() => onChange('build')}
        disabled={disabled}
        className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-mode-build/50 ${
          mode === 'build'
            ? 'bg-mode-build-muted text-mode-build-text border border-mode-build-border'
            : 'text-text-secondary hover:text-text-primary'
        }`}
      >
        <Hammer size={12} />
        Build
      </button>
      <span className="text-xs text-text-muted px-1 font-mono">{shortcut}</span>
    </div>
  )
}
