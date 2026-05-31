import { Lightbulb, X } from 'lucide-react'

interface CreateIdeaModalProps {
  title: string
  description: string
  isCreating: boolean
  onTitleChange: (title: string) => void
  onDescriptionChange: (description: string) => void
  onCreate: () => void
  onClose: () => void
}

export default function CreateIdeaModal({
  title,
  description,
  isCreating,
  onTitleChange,
  onDescriptionChange,
  onCreate,
  onClose
}: CreateIdeaModalProps): React.JSX.Element {
  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onCreate()
    if (e.key === 'Escape') onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-surface-float rounded-xl border border-warning/30 shadow-xl w-96 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-warning-muted border-b border-warning/20">
          <div className="flex items-center gap-2">
            <Lightbulb size={16} className="text-warning" />
            <span className="text-sm font-medium text-warning">New Idea</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-surface-overlay text-text-secondary hover:text-text-primary transition-colors"
          >
            <X size={14} />
          </button>
        </div>
        {/* Body */}
        <div className="p-4 space-y-3">
          <input
            type="text"
            placeholder="Idea title..."
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full bg-surface-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none focus:border-warning/50 focus:ring-1 focus:ring-warning/20 transition-colors"
            autoFocus
          />
          <textarea
            placeholder="Description (optional)..."
            value={description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={4}
            className="w-full bg-surface-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none focus:border-warning/50 focus:ring-1 focus:ring-warning/20 transition-colors resize-none"
          />
        </div>
        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border-subtle">
          <span className="text-xs text-text-muted">⌘+Enter to save</span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary rounded-lg hover:bg-surface-overlay transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onCreate}
              disabled={!title.trim() || isCreating}
              className="px-3 py-1.5 text-xs font-medium text-surface-base bg-warning rounded-lg hover:brightness-110 disabled:opacity-30 transition-colors"
            >
              {isCreating ? 'Saving...' : 'Save Idea'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
