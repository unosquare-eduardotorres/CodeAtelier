/**
 * CreateIdeaModal — self-contained modal for capturing a new idea.
 *
 * Layout:
 *   Header:  icon + "New Idea"
 *   Body:    title input + example chips + description textarea
 *   Footer:  ⌘+Enter hint + Cancel + Save
 */

import { useState } from 'react'
import { Lightbulb, X, Loader2 } from 'lucide-react'

const EXAMPLES = [
  'Dark mode toggle for settings page',
  'Add rate limiting to public API endpoints',
  'Migrate user auth to OAuth 2.0',
  'Add E2E tests for checkout flow'
]

interface CreateIdeaModalProps {
  onCreateIdea: (title: string, description: string) => Promise<void>
  onClose: () => void
}

export default function CreateIdeaModal({
  onCreateIdea,
  onClose
}: CreateIdeaModalProps): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  const handleCreate = async (): Promise<void> => {
    if (!title.trim() || isCreating) return
    setIsCreating(true)
    try {
      await onCreateIdea(title.trim(), description.trim())
      onClose()
    } catch (error) {
      console.error('Failed to create idea:', error)
    } finally {
      setIsCreating(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleCreate()
    if (e.key === 'Escape') onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-surface-float rounded-xl border border-warning/30 shadow-xl w-[640px] max-w-full max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-warning-muted border-b border-warning/20 flex-shrink-0">
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
        <div className="p-4 space-y-3 flex flex-col flex-1 min-h-0 overflow-y-auto">
          <input
            type="text"
            placeholder="Idea title..."
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full bg-surface-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none focus:border-warning/50 focus:ring-1 focus:ring-warning/20 transition-colors"
            autoFocus
          />

          {/* Example chips — disappear once typing starts */}
          {!title && (
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map((ex) => (
                <button
                  type="button"
                  key={ex}
                  onClick={() => setTitle(ex)}
                  className="px-2.5 py-1 text-[11px] text-text-muted hover:text-text-secondary bg-surface-base hover:bg-surface-hover border border-border-subtle rounded-md transition-colors truncate max-w-[240px]"
                >
                  {ex}
                </button>
              ))}
            </div>
          )}

          <textarea
            placeholder="Describe your idea — context, goal, sections, requirements. Markdown welcome."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full flex-1 min-h-[260px] bg-surface-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none focus:border-warning/50 focus:ring-1 focus:ring-warning/20 transition-colors resize-y leading-relaxed"
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border-subtle flex-shrink-0">
          <span className="text-[11px] text-text-muted">
            {title.trim() ? '⌘+Enter to save' : ' '}
          </span>
          <div className="flex items-center gap-2">
            {isCreating && (
              <span className="flex items-center gap-1.5 text-xs text-text-muted">
                <Loader2 size={12} className="animate-spin" />
                Saving…
              </span>
            )}
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary rounded-lg hover:bg-surface-overlay transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={!title.trim() || isCreating}
              className="px-3 py-1.5 text-xs font-medium text-surface-base bg-warning rounded-lg hover:brightness-110 disabled:opacity-30 transition-colors"
            >
              Save Idea
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
