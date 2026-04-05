import { useState } from 'react'
import {
  Loader2,
  Sparkles,
  GitCommitHorizontal,
  Upload,
  GitPullRequest,
  GitBranch
} from 'lucide-react'
import { useCodeChangesStore } from '@renderer/store'
import CreatePrModal from './CreatePrModal'

interface CommitBarProps {
  conversationId: string
}

export default function CommitBar({ conversationId }: CommitBarProps): React.JSX.Element {
  const [showPrModal, setShowPrModal] = useState(false)
  const files = useCodeChangesStore((s) => s.files)
  const checkedFiles = useCodeChangesStore((s) => s.checkedFiles)
  const commitMessage = useCodeChangesStore((s) => s.commitMessage)
  const isCommitting = useCodeChangesStore((s) => s.isCommitting)
  const isGeneratingMessage = useCodeChangesStore((s) => s.isGeneratingMessage)
  const isPushing = useCodeChangesStore((s) => s.isPushing)
  const pushStatus = useCodeChangesStore((s) => s.pushStatus)
  const error = useCodeChangesStore((s) => s.error)

  const {
    setCommitMessage,
    generateCommitMessage,
    commitSelected,
    commitAll,
    push
  } = useCodeChangesStore.getState()

  const hasFiles = files.length > 0
  const hasChecked = checkedFiles.size > 0
  const hasMessage = commitMessage.trim().length > 0
  const showPushState = !hasFiles && pushStatus && pushStatus.commitsAhead > 0

  return (
    <>
      <div className="shrink-0 border-t border-border-subtle bg-surface-float/80 backdrop-blur-sm px-4 py-3">
        {error && (
          <div className="mb-2 px-3 py-1.5 rounded-md bg-danger/10 border border-danger/20 text-xs text-danger">
            {error}
          </div>
        )}

        {showPushState ? (
          /* State 2: All changes committed — show push/PR options */
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <GitBranch size={14} />
              <span className="font-medium">{pushStatus.branch}</span>
              <span className="text-text-muted">
                · {pushStatus.commitsAhead} commit{pushStatus.commitsAhead !== 1 ? 's' : ''} ahead
              </span>
            </div>
            <div className="flex items-center gap-2">
              {pushStatus.hasRemote && (
                <button
                  type="button"
                  onClick={() => void push(conversationId)}
                  disabled={isPushing}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-border-default bg-surface-float text-text-primary hover:bg-surface-overlay disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isPushing ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Upload size={12} />
                  )}
                  Push
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowPrModal(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary hover:bg-primary-hover text-white transition-colors"
              >
                <GitPullRequest size={12} />
                Create PR
              </button>
            </div>
          </div>
        ) : hasFiles ? (
          /* State 1: Uncommitted changes — show commit controls */
          <div className="flex items-center gap-2">
            {/* Auto-generate button */}
            <button
              type="button"
              onClick={() => void generateCommitMessage(conversationId)}
              disabled={isGeneratingMessage || isCommitting}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium border border-border-default bg-surface-float text-text-secondary hover:text-text-primary hover:bg-surface-overlay disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
              title="Auto-generate commit message from conversation context"
            >
              {isGeneratingMessage ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Sparkles size={12} />
              )}
              Auto
            </button>

            {/* Commit message input */}
            <input
              type="text"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="Commit message..."
              disabled={isCommitting}
              className="flex-1 px-3 py-1.5 rounded-md text-xs bg-surface-base border border-border-default text-text-body placeholder-text-muted outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30 disabled:opacity-50 transition-colors"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && hasMessage && !isCommitting) {
                  if (hasChecked) {
                    void commitSelected(conversationId)
                  } else {
                    void commitAll(conversationId)
                  }
                }
              }}
            />

            {/* Commit selected */}
            {hasChecked && (
              <button
                type="button"
                onClick={() => void commitSelected(conversationId)}
                disabled={!hasMessage || isCommitting}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium bg-primary hover:bg-primary-hover text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
              >
                {isCommitting ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <GitCommitHorizontal size={12} />
                )}
                Commit ({checkedFiles.size})
              </button>
            )}

            {/* Commit all */}
            <button
              type="button"
              onClick={() => void commitAll(conversationId)}
              disabled={!hasMessage || isCommitting}
              className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed ${
                hasChecked
                  ? 'border border-border-default bg-surface-float text-text-primary hover:bg-surface-overlay'
                  : 'bg-primary hover:bg-primary-hover text-white'
              }`}
            >
              {isCommitting && !hasChecked ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <GitCommitHorizontal size={12} />
              )}
              Commit All
            </button>
          </div>
        ) : (
          /* No files and no push — clean state */
          <div className="text-xs text-text-muted text-center py-1">
            No pending changes in this conversation
          </div>
        )}
      </div>

      {showPrModal && (
        <CreatePrModal
          conversationId={conversationId}
          onClose={() => setShowPrModal(false)}
        />
      )}
    </>
  )
}
