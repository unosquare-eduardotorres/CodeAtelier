import { useState, useEffect, useRef } from 'react'
import { GitBranch, FileText, Loader2, AlertTriangle } from 'lucide-react'

interface CompleteDialogProps {
  isOpen: boolean
  conversationTitle: string
  conversationId: string
  onConfirm: (commitMessage: string, description: string) => Promise<void>
  onCancel: () => void
}

export default function CompleteDialog({
  isOpen,
  conversationTitle,
  conversationId,
  onConfirm,
  onCancel
}: CompleteDialogProps): React.JSX.Element | null {
  const [commitMessage, setCommitMessage] = useState('')
  const [description, setDescription] = useState('')
  const [fileChanges, setFileChanges] = useState<Array<{ filePath: string; changeType: string }>>(
    []
  )
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isOpen) {
      // Auto-populate commit message from chat title
      setCommitMessage(conversationTitle)
      setError(null)
      setIsSubmitting(false)

      // Focus the input after a short delay to ensure the dialog is rendered
      setTimeout(() => inputRef.current?.focus(), 50)

      // Load tracked file changes
      window.api
        .getFileChanges({ conversationId })
        .then((changes) => {
          const typed = changes as Array<{ filePath: string; changeType: string }>
          setFileChanges(typed)

          // Auto-generate description from file changes
          const lines = typed.map((fc) => `- ${fc.changeType}: ${fc.filePath}`)
          setDescription(lines.length > 0 ? `Changes:\n${lines.join('\n')}` : '')
        })
        .catch(() => {
          setFileChanges([])
          setDescription('')
        })
    }
  }, [isOpen, conversationTitle, conversationId])

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

  const handleConfirm = async (): Promise<void> => {
    if (!commitMessage.trim()) return
    setIsSubmitting(true)
    setError(null)
    try {
      await onConfirm(commitMessage.trim(), description.trim())
    } catch (e) {
      setError((e as Error).message)
      setIsSubmitting(false)
    }
  }

  const changeTypeColor = (type: string): string => {
    switch (type) {
      case 'created':
        return 'text-green-400'
      case 'modified':
        return 'text-amber-400'
      case 'deleted':
        return 'text-red-400'
      default:
        return 'text-gray-400'
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />

      {/* Dialog */}
      <div className="relative bg-gray-800 border border-gray-700 rounded-xl shadow-2xl p-6 max-w-lg w-full mx-4 animate-in fade-in zoom-in-95">
        {/* Header */}
        <div className="flex items-center gap-3 mb-5">
          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-green-500/10 flex items-center justify-center">
            <GitBranch size={20} className="text-green-400" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-gray-100">Complete Conversation</h3>
            <p className="text-xs text-gray-400">
              Create a branch, commit changes, and push to remote
            </p>
          </div>
        </div>

        {/* Commit message input */}
        <div className="mb-4">
          <label
            htmlFor="commit-message"
            className="block text-sm font-medium text-gray-300 mb-1.5"
          >
            Commit message
          </label>
          <input
            ref={inputRef}
            id="commit-message"
            type="text"
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            disabled={isSubmitting}
            className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-gray-200 text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent disabled:opacity-50"
            placeholder="feat: describe your changes..."
          />
        </div>

        {/* Description textarea */}
        <div className="mb-4">
          <label
            htmlFor="commit-description"
            className="block text-sm font-medium text-gray-300 mb-1.5"
          >
            Description
          </label>
          <textarea
            id="commit-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={isSubmitting}
            rows={4}
            className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-gray-200 text-sm placeholder-gray-500 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent disabled:opacity-50"
            placeholder="Detailed description of changes..."
          />
        </div>

        {/* File changes list */}
        {fileChanges.length > 0 && (
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-300 mb-1.5">
              <FileText size={14} className="inline mr-1" />
              Tracked files ({fileChanges.length})
            </label>
            <div className="max-h-32 overflow-y-auto bg-gray-900 border border-gray-700 rounded-lg p-2 space-y-1">
              {fileChanges.map((fc, i) => (
                <div key={i} className="flex items-center gap-2 text-xs font-mono">
                  <span className={`${changeTypeColor(fc.changeType)} flex-shrink-0 w-16`}>
                    {fc.changeType}
                  </span>
                  <span className="text-gray-400 truncate">{fc.filePath}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {fileChanges.length === 0 && (
          <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
            <div className="flex items-center gap-2 text-amber-400 text-sm">
              <AlertTriangle size={14} />
              <span>No file changes tracked for this conversation yet.</span>
            </div>
          </div>
        )}

        {/* Error display */}
        {error && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
            <div className="flex items-start gap-2 text-red-400 text-sm">
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          </div>
        )}

        {/* Buttons */}
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={isSubmitting}
            className="px-4 py-2 text-sm font-medium text-gray-300 hover:text-gray-100 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-500 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={isSubmitting || !commitMessage.trim()}
            className="px-4 py-2 text-sm font-medium rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500 bg-green-600 hover:bg-green-500 text-white disabled:opacity-50 disabled:hover:bg-green-600 flex items-center gap-2"
          >
            {isSubmitting ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Completing...
              </>
            ) : (
              'Complete & Push'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
