import { useState, useEffect, useRef } from 'react'
import { GitBranch, FileText, Loader2, AlertTriangle } from 'lucide-react'
import { useChatStore, useWorkspaceStore } from '@renderer/store'
import InsightsSummary, { type ConversationInsights } from './InsightsSummary'

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Data-driven maps
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const CHANGE_TYPE_COLORS: Record<string, string> = {
  created: 'text-success',
  modified: 'text-warning',
  deleted: 'text-danger'
}

function getRepoConfigLabels(
  repoInfo: { isRepo: boolean; hasRemote?: boolean } | null,
  githubConfigured: boolean
): { buttonLabel: string; subtitle: string } {
  if (!repoInfo?.isRepo) return { buttonLabel: 'Complete', subtitle: 'Commit changes locally' }
  if (!repoInfo.hasRemote)
    return { buttonLabel: 'Complete & Commit', subtitle: 'Create a branch and commit changes' }
  if (!githubConfigured)
    return {
      buttonLabel: 'Complete & Push',
      subtitle: 'Create a branch, commit changes, and push to remote'
    }
  return {
    buttonLabel: 'Complete & Create PR',
    subtitle: 'Create a branch, commit changes, and create PR'
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// useCompleteDialogInit — initialization, async loads, escape key
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface DialogInitState {
  branchName: string
  setBranchName: (v: string) => void
  baseBranch: string
  setBaseBranch: (v: string) => void
  branches: { local: string[]; remote: string[]; current: string } | null
  branchesLoading: boolean
  commitMessage: string
  setCommitMessage: (v: string) => void
  prDescription: string
  setPrDescription: (v: string) => void
  fileChanges: Array<{ filePath: string; changeType: string }>
  isSubmitting: boolean
  setIsSubmitting: (v: boolean) => void
  isGenerating: boolean
  generationError: string | null
  error: string | null
  setError: (v: string | null) => void
  fileChangesLoaded: boolean
  insights: ConversationInsights | null
  insightsLoading: boolean
  inputRef: React.RefObject<HTMLInputElement | null>
}

function useCompleteDialogInit(
  isOpen: boolean,
  conversationTitle: string,
  conversationId: string,
  onCancel: () => void
): DialogInitState & { userEditedRef: React.MutableRefObject<boolean> } {
  const [branchName, setBranchName] = useState('')
  const [baseBranch, setBaseBranch] = useState('')
  const [branches, setBranches] = useState<{
    local: string[]
    remote: string[]
    current: string
  } | null>(null)
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [prDescription, setPrDescription] = useState('')
  const [fileChanges, setFileChanges] = useState<Array<{ filePath: string; changeType: string }>>(
    []
  )
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [generationError, setGenerationError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fileChangesLoaded, setFileChangesLoaded] = useState(false)
  const [insights, setInsights] = useState<ConversationInsights | null>(null)
  const [insightsLoading, setInsightsLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const userEditedRef = useRef(false)

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false

    // Pre-fill branch name: prefer existing conversation branch, else generate
    const activeConv = useChatStore.getState().activeConversation
    if (activeConv?.branchName) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBranchName(activeConv.branchName)
    } else {
      const slug = conversationTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBranchName(`chat/${slug}-${conversationId.slice(0, 8)}`)
    }

    // Pre-fill base branch: stored source branch > current branch from repoInfo
    const { repoInfo, activeWorkspace } = useWorkspaceStore.getState()
    const sourceBranch = activeConv?.sourceBranch
    setBaseBranch(sourceBranch || repoInfo?.currentBranch || 'main')

    // Load available branches for the dropdown
    if (activeWorkspace?.id) {
      setBranchesLoading(true)
      window.api
        .listBranches({ workspaceId: activeWorkspace.id })
        .then((result) => {
          if (cancelled) return
          setBranches(result)
          setBranchesLoading(false)
          // If source branch is set but doesn't exist in results, fall back to current
          if (
            sourceBranch &&
            !result.local.includes(sourceBranch) &&
            !result.remote.includes(sourceBranch)
          ) {
            setBaseBranch(result.current || 'main')
          }
        })
        .catch((err) => {
          if (cancelled) return
          console.warn('[CompleteDialog] Branch list load failed:', err)
          setBranchesLoading(false)
        })
    }

    // Pre-fill commit message
    setCommitMessage(conversationTitle)
    setError(null)
    setIsSubmitting(false)
    setGenerationError(null)
    setFileChangesLoaded(false)
    userEditedRef.current = false

    // Focus the input after a short delay to ensure the dialog is rendered
    setTimeout(() => inputRef.current?.focus(), 50)

    // Load tracked file changes
    window.api
      .getFileChanges({ conversationId })
      .then((changes) => {
        if (cancelled) return
        const typed = changes as Array<{ filePath: string; changeType: string }>
        setFileChanges(typed)
        setFileChangesLoaded(true)
        const lines = typed.map((fc) => `- ${fc.changeType}: ${fc.filePath}`)
        setPrDescription(lines.length > 0 ? `Changes:\n${lines.join('\n')}` : '')
      })
      .catch((err) => {
        if (cancelled) return
        console.warn('[CompleteDialog] Non-fatal: file changes load failed:', err)
        setFileChanges([])
        setFileChangesLoaded(true)
        setPrDescription('')
      })

    // Fetch session insights (independent)
    setInsightsLoading(true)
    window.api
      .getConversationInsights({ conversationId })
      .then((result) => {
        if (!cancelled) {
          setInsights(result)
          setInsightsLoading(false)
        }
      })
      .catch((err) => {
        if (cancelled) return
        console.warn('[CompleteDialog] Non-fatal: insights load failed:', err)
        setInsightsLoading(false)
      })

    // Auto-generate PR description — only overwrites if user hasn't manually edited
    setIsGenerating(true)
    window.api
      .generatePrDescription({ conversationId })
      .then((result) => {
        if (cancelled || userEditedRef.current) return
        setPrDescription(result.description)
        setIsGenerating(false)
      })
      .catch((err) => {
        if (cancelled) return
        console.warn('[CompleteDialog] Non-fatal: PR description generation failed:', err)
        setGenerationError('Failed to auto-generate. You can write one manually.')
        setIsGenerating(false)
      })

    return () => {
      cancelled = true
    }
  }, [isOpen, conversationTitle, conversationId])

  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onCancel])

  return {
    branchName,
    setBranchName,
    baseBranch,
    setBaseBranch,
    branches,
    branchesLoading,
    commitMessage,
    setCommitMessage,
    prDescription,
    setPrDescription,
    fileChanges,
    isSubmitting,
    setIsSubmitting,
    isGenerating,
    generationError,
    error,
    setError,
    fileChangesLoaded,
    insights,
    insightsLoading,
    inputRef,
    userEditedRef
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Component
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface CompleteDialogProps {
  isOpen: boolean
  conversationTitle: string
  conversationId: string
  onConfirm: (
    branchName: string,
    commitMessage: string,
    description: string,
    baseBranch?: string
  ) => Promise<void>
  onClose: () => Promise<void>
  onCancel: () => void
}

export default function CompleteDialog({
  isOpen,
  conversationTitle,
  conversationId,
  onConfirm,
  onClose,
  onCancel
}: CompleteDialogProps): React.JSX.Element | null {
  const { repoInfo, githubStatus } = useWorkspaceStore()
  const {
    branchName,
    setBranchName,
    baseBranch,
    setBaseBranch,
    branches,
    branchesLoading,
    commitMessage,
    setCommitMessage,
    prDescription,
    setPrDescription,
    fileChanges,
    isSubmitting,
    setIsSubmitting,
    isGenerating,
    generationError,
    error,
    setError,
    fileChangesLoaded,
    insights,
    insightsLoading,
    inputRef,
    userEditedRef
  } = useCompleteDialogInit(isOpen, conversationTitle, conversationId, onCancel)

  if (!isOpen) return null

  const noChanges = fileChangesLoaded && fileChanges.length === 0

  const handleClose = async (): Promise<void> => {
    setIsSubmitting(true)
    setError(null)
    try {
      await onClose()
    } catch (e) {
      setError((e as Error).message)
      setIsSubmitting(false)
    }
  }

  const handleConfirm = async (): Promise<void> => {
    if (!commitMessage.trim() || !branchName.trim()) return
    setIsSubmitting(true)
    setError(null)
    try {
      await onConfirm(
        branchName.trim(),
        commitMessage.trim(),
        prDescription.trim(),
        baseBranch.trim() || undefined
      )
    } catch (e) {
      setError((e as Error).message)
      setIsSubmitting(false)
    }
  }

  const { buttonLabel, subtitle } = getRepoConfigLabels(repoInfo, !!githubStatus?.configured)

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />

      {/* Dialog */}
      <div
        data-testid="complete-dialog"
        className="relative bg-surface-float border border-border-default rounded-xl shadow-2xl p-6 max-w-lg w-full mx-4 animate-in fade-in zoom-in-95"
      >
        {/* Header */}
        <div className="flex items-center gap-3 mb-5">
          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-success-muted flex items-center justify-center">
            <GitBranch size={20} className="text-success" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-text-primary">Complete Conversation</h3>
            <p className="text-xs text-text-secondary">{subtitle}</p>
          </div>
        </div>

        {/* Branch/commit/description inputs — dimmed when no changes */}
        <div className={noChanges ? 'opacity-40 pointer-events-none' : ''}>
          {/* Branch name input */}
          <div className="mb-4">
            <label
              htmlFor="branch-name"
              className="block text-sm font-medium text-text-body mb-1.5"
            >
              Branch name
            </label>
            <input
              ref={inputRef}
              id="branch-name"
              data-testid="complete-dialog-branch"
              type="text"
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              disabled={isSubmitting}
              className="w-full px-3 py-2 bg-surface-base border border-border-default rounded-lg text-text-body text-sm font-mono placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent disabled:opacity-50"
              placeholder="chat/my-feature"
            />
          </div>

          {/* Target branch (base for PR) */}
          <div className="mb-4">
            <label
              htmlFor="base-branch"
              className="block text-sm font-medium text-text-body mb-1.5"
            >
              Target branch
              <span className="text-xs text-text-muted font-normal ml-1">(merge into)</span>
            </label>
            <div className="relative">
              <input
                id="base-branch"
                data-testid="complete-dialog-base-branch"
                type="text"
                list={`branch-options-${conversationId}`}
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                disabled={isSubmitting}
                className="w-full px-3 py-2 bg-surface-base border border-border-default rounded-lg text-text-body text-sm font-mono placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent disabled:opacity-50"
                placeholder="main"
              />
              {branchesLoading && (
                <Loader2
                  size={14}
                  className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-text-muted"
                />
              )}
            </div>
            {branches && (
              <datalist id={`branch-options-${conversationId}`}>
                {branches.local
                  .filter((b) => b !== branchName)
                  .map((b) => (
                    <option key={`local:${b}`} value={b} />
                  ))}
                {branches.remote
                  .filter((b) => !branches.local.includes(b))
                  .map((b) => (
                    <option key={`remote:${b}`} value={b} />
                  ))}
              </datalist>
            )}
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
              data-testid="complete-dialog-commit"
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
            <div className="relative">
              <textarea
                id="pr-description"
                value={prDescription}
                onChange={(e) => {
                  userEditedRef.current = true
                  setPrDescription(e.target.value)
                }}
                disabled={isSubmitting}
                rows={6}
                className="w-full px-3 py-2 bg-surface-base border border-border-default rounded-lg text-text-body text-sm placeholder-text-muted resize-none focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent disabled:opacity-50"
                placeholder="Describe the changes in this PR..."
              />
              {isGenerating && (
                <div className="absolute top-2 right-2 flex items-center gap-1.5 px-2 py-1 bg-surface-overlay/90 rounded text-xs text-text-secondary">
                  <Loader2 size={12} className="animate-spin text-primary-text" />
                  Generating...
                </div>
              )}
            </div>
            {generationError && <p className="text-xs text-warning mt-1">{generationError}</p>}
          </div>
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
                  <span
                    className={`${CHANGE_TYPE_COLORS[fc.changeType] ?? 'text-text-secondary'} flex-shrink-0 w-16`}
                  >
                    {fc.changeType}
                  </span>
                  <span className="text-text-secondary truncate">{fc.filePath}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {noChanges && (
          <div className="mb-4 p-3 bg-info-muted border border-info/20 rounded-lg">
            <div className="flex items-start gap-2 text-info text-sm">
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-medium">No uncommitted changes found</p>
                <p className="text-text-secondary mt-0.5">
                  Changes may have been committed in another session. You can close this
                  conversation to clean up.
                </p>
              </div>
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
          {noChanges ? (
            <button
              onClick={handleClose}
              disabled={isSubmitting}
              className="px-4 py-2 text-sm font-medium rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-warning bg-warning hover:brightness-110 text-white disabled:opacity-50 flex items-center gap-2"
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Closing...
                </>
              ) : (
                'Close Conversation'
              )}
            </button>
          ) : (
            <button
              onClick={handleConfirm}
              disabled={isSubmitting || !commitMessage.trim() || !branchName.trim()}
              className="px-4 py-2 text-sm font-medium rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-success bg-success hover:brightness-110 text-white disabled:opacity-50 flex items-center gap-2"
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Completing...
                </>
              ) : (
                buttonLabel
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
