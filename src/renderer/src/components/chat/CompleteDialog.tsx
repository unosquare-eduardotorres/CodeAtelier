import { useState, useEffect, useRef } from 'react'
import { GitBranch, FileText, Loader2, AlertTriangle } from 'lucide-react'
import { useWorkspaceStore } from '@renderer/store'
import InsightsSummary, { type ConversationInsights } from './InsightsSummary'

interface CompleteDialogProps {
  isOpen: boolean
  conversationTitle: string
  conversationId: string
  onConfirm: (branchName: string, commitMessage: string, description: string) => Promise<void>
  onCancel: () => void
}

export default function CompleteDialog({
  isOpen,
  conversationTitle,
  conversationId,
  onConfirm,
  onCancel
}: CompleteDialogProps): React.JSX.Element | null {
  const { repoInfo, githubStatus } = useWorkspaceStore()

  const [branchName, setBranchName] = useState('')
  const [commitMessage, setCommitMessage] = useState('')
  const [prDescription, setPrDescription] = useState('')
  const [fileChanges, setFileChanges] = useState<Array<{ filePath: string; changeType: string }>>(
    []
  )
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [generationError, setGenerationError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [insights, setInsights] = useState<ConversationInsights | null>(null)
  const [insightsLoading, setInsightsLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isOpen) {
      // Pre-fill branch name from chat title
      const slug = conversationTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBranchName(`chat/${slug}-${conversationId.slice(0, 8)}`)

      // Pre-fill commit message

      setCommitMessage(conversationTitle)
      setError(null)
      setIsSubmitting(false)
      setGenerationError(null)

      // Focus the input after a short delay to ensure the dialog is rendered
      setTimeout(() => inputRef.current?.focus(), 50)

      // Load tracked file changes
      window.api
        .getFileChanges({ conversationId })
        .then((changes) => {
          const typed = changes as Array<{ filePath: string; changeType: string }>
          setFileChanges(typed)

          // Set initial description from file changes (will be replaced by AI generation)
          const lines = typed.map((fc) => `- ${fc.changeType}: ${fc.filePath}`)
          setPrDescription(lines.length > 0 ? `Changes:\n${lines.join('\n')}` : '')
        })
        .catch((err) => {
          console.warn('[CompleteDialog] Non-fatal: file changes load failed:', err)
          setFileChanges([])
          setPrDescription('')
        })

      // Fetch session insights
      setInsightsLoading(true)
      window.api
        .getConversationInsights({ conversationId })
        .then((result) => {
          setInsights(result)
          setInsightsLoading(false)
        })
        .catch((err) => {
          console.warn('[CompleteDialog] Non-fatal: insights load failed:', err)
          setInsightsLoading(false)
        })

      // Auto-generate PR description
      setIsGenerating(true)
      window.api
        .generatePrDescription({ conversationId })
        .then((result) => {
          setPrDescription(result.description)
          setIsGenerating(false)
        })
        .catch((err) => {
          console.warn('[CompleteDialog] Non-fatal: PR description generation failed:', err)
          setGenerationError('Failed to auto-generate. You can write one manually.')
          setIsGenerating(false)
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
    if (!commitMessage.trim() || !branchName.trim()) return
    setIsSubmitting(true)
    setError(null)
    try {
      await onConfirm(branchName.trim(), commitMessage.trim(), prDescription.trim())
    } catch (e) {
      setError((e as Error).message)
      setIsSubmitting(false)
    }
  }

  const changeTypeColor = (type: string): string => {
    switch (type) {
      case 'created':
        return 'text-success'
      case 'modified':
        return 'text-warning'
      case 'deleted':
        return 'text-danger'
      default:
        return 'text-text-secondary'
    }
  }

  // Determine button label based on repo/GitHub configuration
  const getButtonLabel = (): string => {
    if (!repoInfo?.isRepo) return 'Complete'
    if (!repoInfo.hasRemote) return 'Complete & Commit'
    if (!githubStatus?.configured) return 'Complete & Push'
    return 'Complete & Create PR'
  }

  // Determine subtitle based on config
  const getSubtitle = (): string => {
    if (!repoInfo?.isRepo) return 'Commit changes locally'
    if (!repoInfo.hasRemote) return 'Create a branch and commit changes'
    if (!githubStatus?.configured) return 'Create a branch, commit changes, and push to remote'
    return 'Create a branch, commit changes, and create PR'
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
      <div data-testid="complete-dialog" className="relative bg-surface-float border border-border-default rounded-xl shadow-2xl p-6 max-w-lg w-full mx-4 animate-in fade-in zoom-in-95">
        {/* Header */}
        <div className="flex items-center gap-3 mb-5">
          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-success-muted flex items-center justify-center">
            <GitBranch size={20} className="text-success" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-text-primary">Complete Conversation</h3>
            <p className="text-xs text-text-secondary">{getSubtitle()}</p>
          </div>
        </div>

        {/* Branch name input */}
        <div className="mb-4">
          <label htmlFor="branch-name" className="block text-sm font-medium text-text-body mb-1.5">
            Branch name
          </label>
          <input
            ref={inputRef}
            id="branch-name"
            type="text"
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            disabled={isSubmitting}
            className="w-full px-3 py-2 bg-surface-base border border-border-default rounded-lg text-text-body text-sm font-mono placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent disabled:opacity-50"
            placeholder="chat/my-feature"
          />
        </div>

        {/* Commit message input */}
        <div className="mb-4">
          <label
            htmlFor="commit-message"
            className="block text-sm font-medium text-text-body mb-1.5"
          >
            Commit message
          </label>
          <input
            id="commit-message"
            type="text"
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            disabled={isSubmitting}
            className="w-full px-3 py-2 bg-surface-base border border-border-default rounded-lg text-text-body text-sm placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent disabled:opacity-50"
            placeholder="feat: describe your changes..."
          />
        </div>

        {/* PR Description */}
        <div className="mb-4">
          <label
            htmlFor="pr-description"
            className="block text-sm font-medium text-text-body mb-1.5"
          >
            PR Description
          </label>
          {isGenerating ? (
            <div className="w-full px-3 py-4 bg-surface-base border border-border-default rounded-lg flex items-center gap-3">
              <Loader2 size={16} className="animate-spin text-primary-text" />
              <span className="text-sm text-text-secondary">Generating description with AI...</span>
            </div>
          ) : (
            <textarea
              id="pr-description"
              value={prDescription}
              onChange={(e) => setPrDescription(e.target.value)}
              disabled={isSubmitting}
              rows={6}
              className="w-full px-3 py-2 bg-surface-base border border-border-default rounded-lg text-text-body text-sm placeholder-text-muted resize-none focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent disabled:opacity-50"
              placeholder="Describe the changes in this PR..."
            />
          )}
          {generationError && <p className="text-xs text-warning mt-1">{generationError}</p>}
        </div>

        {/* Session Insights */}
        <InsightsSummary
          insights={insights}
          loading={insightsLoading}
          filesChanged={fileChanges.length}
        />

        {/* File changes list */}
        {fileChanges.length > 0 && (
          <div className="mb-4">
            <label className="block text-sm font-medium text-text-body mb-1.5">
              <FileText size={14} className="inline mr-1" />
              Tracked files ({fileChanges.length})
            </label>
            <div className="max-h-32 overflow-y-auto bg-surface-base border border-border-subtle rounded-lg p-2 space-y-1">
              {fileChanges.map((fc, i) => (
                <div key={i} className="flex items-center gap-2 text-xs font-mono">
                  <span className={`${changeTypeColor(fc.changeType)} flex-shrink-0 w-16`}>
                    {fc.changeType}
                  </span>
                  <span className="text-text-secondary truncate">{fc.filePath}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {fileChanges.length === 0 && !isGenerating && (
          <div className="mb-4 p-3 bg-warning-muted border border-warning/20 rounded-lg">
            <div className="flex items-center gap-2 text-warning text-sm">
              <AlertTriangle size={14} />
              <span>No file changes tracked for this conversation yet.</span>
            </div>
          </div>
        )}

        {/* Error display */}
        {error && (
          <div className="mb-4 p-3 bg-danger-muted border border-danger/20 rounded-lg">
            <div className="flex items-start gap-2 text-danger text-sm">
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
            className="px-4 py-2 text-sm font-medium text-text-body hover:text-text-primary bg-surface-overlay hover:bg-surface-raised rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-border-default disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={isSubmitting || isGenerating || !commitMessage.trim() || !branchName.trim()}
            className="px-4 py-2 text-sm font-medium rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-success bg-success hover:brightness-110 text-white disabled:opacity-50 flex items-center gap-2"
          >
            {isSubmitting ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Completing...
              </>
            ) : isGenerating ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Generating...
              </>
            ) : (
              getButtonLabel()
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
