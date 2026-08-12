import { ClipboardList, Hammer, Skull } from 'lucide-react'
import type { ConversationMode } from '../../../../shared/types'
import { isMacPlatform } from '@renderer/utils/platform'

interface ModeToggleProps {
  mode: ConversationMode
  onChange: (mode: ConversationMode) => void
  disabled?: boolean
}

const MODES: Array<{
  id: ConversationMode
  label: string
  Icon: typeof ClipboardList
  colorClass: string
  focusClass: string
}> = [
  {
    id: 'plan',
    label: 'Plan',
    Icon: ClipboardList,
    colorClass: 'bg-mode-plan-muted text-mode-plan-text border border-mode-plan-border',
    focusClass: 'focus-visible:ring-mode-plan/50'
  },
  {
    id: 'build',
    label: 'Build',
    Icon: Hammer,
    colorClass: 'bg-mode-build-muted text-mode-build-text border border-mode-build-border',
    focusClass: 'focus-visible:ring-mode-build/50'
  },
  {
    id: 'danger',
    label: 'Danger',
    Icon: Skull,
    colorClass: 'bg-mode-danger-muted text-mode-danger-text border border-mode-danger-border',
    focusClass: 'focus-visible:ring-mode-danger/50'
  }
]

export default function ModeToggle({
  mode,
  onChange,
  disabled
}: ModeToggleProps): React.JSX.Element {
  const shortcut = isMacPlatform ? '⌘.' : 'Ctrl+.'

  return (
    <div
      className="flex items-center gap-1.5 bg-surface-overlay rounded-lg p-0.5 border border-border-subtle"
      title={`Cycle mode (${shortcut})`}
    >
      {MODES.map(({ id, label, Icon, colorClass, focusClass }) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          disabled={disabled}
          className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors focus-visible:ring-2 ${focusClass} ${
            mode === id ? colorClass : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          <Icon size={12} />
          {label}
        </button>
      ))}
      <span className="text-xs text-text-muted px-1 font-mono">{shortcut}</span>
    </div>
  )
}
