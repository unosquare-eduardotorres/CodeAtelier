import { useEffect, useRef } from 'react'
import { AlertTriangle } from 'lucide-react'

interface ConfirmDialogProps {
  isOpen: boolean
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'danger' | 'default'
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  onConfirm,
  onCancel
}: ConfirmDialogProps): React.JSX.Element | null {
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (isOpen) {
      confirmRef.current?.focus()
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
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-message"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />

      {/* Dialog */}
      <div className="relative bg-surface-float border border-border-default rounded-xl shadow-2xl p-6 max-w-sm w-full mx-4 animate-in fade-in zoom-in-95">
        <div className="flex items-start gap-3 mb-4">
          {variant === 'danger' && (
            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-danger-muted flex items-center justify-center">
              <AlertTriangle size={20} className="text-red-400" />
            </div>
          )}
          <div>
            <h3 id="confirm-dialog-title" className="text-base font-semibold text-text-primary">
              {title}
            </h3>
            <p id="confirm-dialog-message" className="text-sm text-text-secondary mt-1">
              {message}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 mt-6">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-text-body hover:text-text-primary bg-surface-overlay hover:bg-surface-raised rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-border-default"
            aria-label={cancelLabel}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors focus:outline-none focus-visible:ring-2 press-scale ${
              variant === 'danger'
                ? 'bg-red-600 hover:bg-red-500 text-white focus-visible:ring-red-500'
                : 'bg-primary hover:bg-primary-hover text-white focus-visible:ring-primary'
            }`}
            aria-label={confirmLabel}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
