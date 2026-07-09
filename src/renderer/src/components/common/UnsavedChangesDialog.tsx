import { useEffect, useRef } from 'react'

interface UnsavedChangesDialogProps {
  isOpen: boolean
  onSave: () => void
  onDiscard: () => void
  onCancel: () => void
}

/**
 * Three-action unsaved-changes dialog.
 *
 * - **Save & continue** (primary) — persists the draft, then continues navigation
 * - **Discard changes** (secondary/danger-tint) — drops changes, continues navigation
 * - **Keep editing** (ghost) — cancels the navigation, stays on the page
 *
 * Escape = keep editing (same as ConfirmDialog convention).
 */
export default function UnsavedChangesDialog({
  isOpen,
  onSave,
  onDiscard,
  onCancel
}: UnsavedChangesDialogProps): React.JSX.Element | null {
  const saveRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (isOpen) {
      saveRef.current?.focus()
    }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onCancel()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onCancel])

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="unsaved-dialog-title"
      aria-describedby="unsaved-dialog-message"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-[rgba(15,21,23,0.85)] backdrop-blur-sm"
        onClick={onCancel}
      />

      {/* Dialog */}
      <div
        data-testid="unsaved-changes-dialog"
        className="relative bg-surface-float border border-border-default rounded shadow-2xl p-6 max-w-sm w-full mx-4 animate-in fade-in zoom-in-95"
      >
        <h3
          id="unsaved-dialog-title"
          className="text-base font-semibold text-text-primary"
        >
          Unsaved changes
        </h3>
        <p
          id="unsaved-dialog-message"
          className="text-sm text-text-secondary mt-1"
        >
          You have unsaved model configuration changes. What would you like to do?
        </p>

        <div className="flex items-center justify-end gap-2 mt-6">
          {/* Keep editing (ghost) */}
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-text-body hover:text-text-primary transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-border-default rounded-lg"
          >
            Keep editing
          </button>

          {/* Discard changes (danger-tint) */}
          <button
            onClick={onDiscard}
            className="px-4 py-2 text-sm font-medium text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50"
          >
            Discard changes
          </button>

          {/* Save & continue (primary) */}
          <button
            ref={saveRef}
            onClick={onSave}
            className="px-4 py-2 text-sm font-medium bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary press-scale"
          >
            Save &amp; continue
          </button>
        </div>
      </div>
    </div>
  )
}
