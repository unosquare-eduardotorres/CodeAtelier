import { AlertTriangle, Loader2 } from 'lucide-react'
import { useState, useEffect } from 'react'
import { useWorkspaceStore } from '@renderer/store'

interface UnsavedChangesDialogProps {
  isOpen: boolean
  files: string[]
  fileCount: number
  onCancel: () => void
  onDiscard: () => Promise<void>
  onCommit: () => void
}

export default function UnsavedChangesDialog({
  isOpen,
  files,
  fileCount,
  onCancel,
  onDiscard,
  onCommit
}: UnsavedChangesDialogProps): React.JSX.Element | null {
  const { repoInfo, githubStatus } = useWorkspaceStore()
  const [isDiscarding, setIsDiscarding] = useState(false)

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

  const handleDiscard = async (): Promise<void> => {
    setIsDiscarding(true)
    try {
      await onDiscard()
    } catch {
      setIsDiscarding(false)
    }
  }

  // Determine commit button label based on config
  const getCommitLabel = (): string => {
    if (!repoInfo?.isRepo) return 'Commit'
    if (!repoInfo.hasRemote) return 'Commit'
    if (!githubStatus?.configured) return 'Commit & Push'
    return 'Commit & Create PR'
  }

  const displayFiles = files.slice(0, 5)
  const remainingCount = fileCount - displayFiles.length

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />

      {/* Dialog */}
      <div className="relative bg-surface-float border border-border-default rounded-xl shadow-2xl p-6 max-w-md w-full mx-4 animate-in fade-in zoom-in-95">
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-warning-muted flex items-center justify-center">
            <AlertTriangle size={20} className="text-warning" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-text-primary">Unsaved Changes</h3>
            <p className="text-xs text-text-secondary">
              This conversation has {fileCount} uncommitted file{fileCount !== 1 ? 's' : ''}
            </p>
          </div>
        </div>

        {/* File list */}
        <div className="mb-5 bg-surface-base border border-border-subtle rounded-lg p-3 space-y-1">
          {displayFiles.map((file, i) => (
            <div key={i} className="text-xs font-mono text-text-secondary truncate">
              {file}
            </div>
          ))}
          {remainingCount > 0 && (
            <div className="text-xs text-text-muted">...and {remainingCount} more</div>
          )}
        </div>

        <p className="text-sm text-text-body mb-5">What would you like to do?</p>

        {/* Buttons */}
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={isDiscarding}
            className="px-4 py-2 text-sm font-medium text-text-body hover:text-text-primary bg-surface-overlay hover:bg-surface-raised rounded-lg transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleDiscard}
            disabled={isDiscarding}
            className="px-4 py-2 text-sm font-medium text-danger border border-danger/30 hover:bg-danger-muted rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {isDiscarding ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Discarding...
              </>
            ) : (
              'Discard Changes'
            )}
          </button>
          <button
            onClick={onCommit}
            disabled={isDiscarding}
            className="px-4 py-2 text-sm font-medium bg-success hover:brightness-110 text-white rounded-lg transition-colors disabled:opacity-50"
          >
            {getCommitLabel()}
          </button>
        </div>
      </div>
    </div>
  )
}
