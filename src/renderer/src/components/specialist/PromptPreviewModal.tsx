import { useState, useEffect } from 'react'
import { X, Save } from 'lucide-react'

interface PromptPreviewModalProps {
  open: boolean
  prompt: string
  onSave: (prompt: string) => void
  onClose: () => void
  isSaving: boolean
}

/**
 * Full-screen overlay modal for editing the specialist's raw system prompt.
 * Uses a monospace textarea with char count and save/cancel actions.
 */
export default function PromptPreviewModal({
  open,
  prompt,
  onSave,
  onClose,
  isSaving
}: PromptPreviewModalProps): React.JSX.Element | null {
  const [draft, setDraft] = useState(prompt)
  const isDirty = draft !== prompt

  // Sync draft when modal opens or prompt changes externally
  useEffect(() => {
    if (open) setDraft(prompt)
  }, [open, prompt])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal content */}
      <div className="relative w-full max-w-4xl max-h-[90vh] mx-4 flex flex-col bg-surface-raised border border-border-default rounded-2xl shadow-2xl animate-in fade-in zoom-in-95">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Edit System Prompt</h3>
            <p className="text-[11px] text-text-muted mt-0.5">
              Raw markdown prompt sent to the AI agent
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-surface-overlay text-text-muted hover:text-text-primary transition-colors"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Textarea */}
        <div className="flex-1 min-h-0 p-6 overflow-hidden">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full h-full min-h-[400px] px-4 py-3 rounded-xl bg-surface-base border border-border-subtle
              text-xs text-text-body font-mono leading-relaxed resize-none
              focus:outline-none focus:ring-1 focus:ring-primary/40 focus:border-primary/40
              placeholder:text-text-muted"
            placeholder="Enter the system prompt…"
            spellCheck={false}
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-border-subtle">
          <span className="text-[11px] text-text-muted">
            {draft.length.toLocaleString()} characters
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-text-secondary hover:bg-surface-overlay transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => onSave(draft)}
              disabled={!isDirty || isSaving}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                bg-primary text-white hover:bg-primary/90
                disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Save size={12} />
              {isSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
