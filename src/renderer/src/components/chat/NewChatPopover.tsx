import type { ConversationMode } from '../../../../shared/types'

interface NewChatPopoverProps {
  onSelect: (mode: ConversationMode) => void
  onClose: () => void
}

export default function NewChatPopover({
  onSelect,
  onClose
}: NewChatPopoverProps): React.JSX.Element {
  return (
    <div className="absolute top-full left-0 mt-1 w-56 bg-surface-float border border-border-default rounded-lg shadow-xl z-50 p-2">
      <button
        onClick={() => {
          onSelect('plan')
          onClose()
        }}
        className="flex items-start gap-3 w-full px-3 py-2.5 rounded-lg hover:bg-surface-overlay transition-colors text-left"
      >
        <span className="text-lg mt-0.5">📋</span>
        <div>
          <div className="text-sm font-medium text-text-primary">Plan Mode</div>
          <div className="text-xs text-text-muted">Analyze, brainstorm, create plans</div>
        </div>
      </button>
      <button
        onClick={() => {
          onSelect('build')
          onClose()
        }}
        className="flex items-start gap-3 w-full px-3 py-2.5 rounded-lg hover:bg-surface-overlay transition-colors text-left"
      >
        <span className="text-lg mt-0.5">🔨</span>
        <div>
          <div className="text-sm font-medium text-text-primary">Build Mode</div>
          <div className="text-xs text-text-muted">Write code, make changes</div>
        </div>
      </button>
    </div>
  )
}
