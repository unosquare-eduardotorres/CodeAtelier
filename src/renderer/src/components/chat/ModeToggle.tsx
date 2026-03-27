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
        className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-purple-500/50 ${
          mode === 'plan'
            ? 'bg-purple-600/30 text-purple-300 border border-purple-500/30'
            : 'text-text-secondary hover:text-text-primary'
        }`}
      >
        <ClipboardList size={12} />
        Plan
      </button>
      <button
        onClick={() => onChange('build')}
        disabled={disabled}
        className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-amber-500/50 ${
          mode === 'build'
            ? 'bg-amber-600/30 text-amber-300 border border-amber-500/30'
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
