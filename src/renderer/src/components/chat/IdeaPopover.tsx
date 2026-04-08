import { useState } from 'react'
import { Lightbulb, X, CheckCircle2 } from 'lucide-react'
import { useIdeaStore, useWorkspaceStore } from '@renderer/store'

interface IdeaPopoverProps {
  onClose: () => void
  initialTitle?: string
  initialDescription?: string
}

export default function IdeaPopover({
  onClose,
  initialTitle,
  initialDescription
}: IdeaPopoverProps): React.JSX.Element {
  const [title, setTitle] = useState(initialTitle ?? '')
  const [description, setDescription] = useState(initialDescription ?? '')
  const [isSaving, setIsSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const { createIdea } = useIdeaStore()
  const { activeWorkspace } = useWorkspaceStore()

  const handleSave = async (): Promise<void> => {
    if (!title.trim() || !activeWorkspace || isSaving) return
    setIsSaving(true)
    try {
      await createIdea(activeWorkspace.id, title.trim(), description.trim())
      setSaved(true)
      setTimeout(() => onClose(), 800)
    } catch (error) {
      console.error('Failed to save idea:', error)
      setIsSaving(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      onClose()
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      handleSave()
    }
  }

  return (
    <div
      className="absolute bottom-full mb-2 left-0 w-80 bg-surface-float rounded-xl border border-warning/30 shadow-xl z-50 overflow-hidden"
      onKeyDown={handleKeyDown}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-warning-muted border-b border-warning/20">
        <div className="flex items-center gap-2">
          <Lightbulb size={16} className="text-warning" />
          <span className="text-sm font-medium text-warning">Capture an Idea</span>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded-md hover:bg-surface-overlay text-text-secondary hover:text-text-primary transition-colors"
          aria-label="Close"
        >
          <X size={14} />
        </button>
      </div>

      {saved ? (
        /* Success feedback */
        <div className="flex flex-col items-center justify-center py-8 gap-2 animate-in fade-in duration-200">
          <CheckCircle2 size={28} className="text-success" />
          <span className="text-sm font-medium text-success">Idea saved!</span>
        </div>
      ) : (
        <>
          {/* Body */}
          <div className="p-4 space-y-3">
            <p className="text-xs text-text-secondary leading-relaxed">
              Save this idea for later. You can find it in{' '}
              <span className="text-text-primary font-medium">Workspace Settings → Ideas</span>,
              then refine it with &quot;Grill Me&quot; or convert it directly into a work item.
            </p>
            <input
              type="text"
              placeholder="Idea title..."
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full bg-surface-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none focus:border-warning/50 focus:ring-1 focus:ring-warning/20 transition-colors"
              autoFocus
            />
            <textarea
              placeholder="Description (optional)..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
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
                onClick={handleSave}
                disabled={!title.trim() || isSaving}
                className="px-3 py-1.5 text-xs font-medium text-surface-base bg-warning rounded-lg hover:brightness-110 disabled:opacity-30 transition-colors"
              >
                {isSaving ? 'Saving...' : 'Save Idea'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
