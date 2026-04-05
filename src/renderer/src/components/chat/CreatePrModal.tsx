import { useState, useEffect } from 'react'
import {
  X,
  Loader2,
  GitPullRequest,
  ExternalLink,
  AlertCircle,
  Sparkles
} from 'lucide-react'
import { useCodeChangesStore } from '@renderer/store'

interface CreatePrModalProps {
  conversationId: string
  onClose: () => void
}

export default function CreatePrModal({
  conversationId,
  onClose
}: CreatePrModalProps): React.JSX.Element {
  const pushStatus = useCodeChangesStore((s) => s.pushStatus)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [baseBranch, setBaseBranch] = useState('main')
  const [isGenerating, setIsGenerating] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [prUrl, setPrUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Auto-fill title from branch name
  useEffect(() => {
    if (pushStatus?.branch) {
      const branchName = pushStatus.branch
        .replace(/^(feature|fix|chore|docs)\//i, '')
        .replace(/[-_]/g, ' ')
      setTitle(branchName.charAt(0).toUpperCase() + branchName.slice(1))
    }
  }, [pushStatus?.branch])

  const handleGenerateDescription = async (): Promise<void> => {
    setIsGenerating(true)
    try {
      const result = await window.api.generatePrDescription({ conversationId })
      setDescription(result.description)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate description')
    } finally {
      setIsGenerating(false)
    }
  }

  const handleCreate = async (): Promise<void> => {
    if (!title.trim()) return
    setIsCreating(true)
    setError(null)

    try {
      // First ensure we're pushed
      if (pushStatus?.hasRemote) {
        await window.api.repoPush({ conversationId })
      }

      // Create PR via GitHub API
      const result = await window.api.createPr({
        conversationId,
        title: title.trim(),
        body: description.trim(),
        base: baseBranch,
        head: pushStatus?.branch ?? 'main'
      })

      if (result?.url) {
        setPrUrl(result.url)
      } else {
        setError('PR created but no URL returned')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create pull request')
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center">
      {/* Backdrop */}
      <button
        type="button"
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
        onClick={onClose}
        aria-label="Close modal"
      />

      {/* Modal */}
      <div className="relative w-full max-w-lg bg-surface-raised rounded-xl border border-border-default shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <div className="flex items-center gap-2">
            <GitPullRequest size={16} className="text-primary-text" />
            <h2 className="text-sm font-semibold text-text-primary">Create Pull Request</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {prUrl ? (
            /* Success state */
            <div className="text-center py-6">
              <div className="w-12 h-12 mx-auto rounded-full bg-success-muted flex items-center justify-center mb-3">
                <GitPullRequest size={24} className="text-success" />
              </div>
              <p className="text-sm font-medium text-text-primary mb-2">Pull Request Created</p>
              <a
                href={prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-primary-text hover:underline"
                onClick={(e) => {
                  e.preventDefault()
                  window.open(prUrl, '_blank')
                }}
              >
                <ExternalLink size={12} />
                Open in Browser
              </a>
            </div>
          ) : (
            <>
              {/* Branch info */}
              <div className="flex items-center gap-2 text-xs text-text-secondary bg-surface-overlay/50 rounded-md px-3 py-2">
                <span className="font-mono">{pushStatus?.branch ?? 'unknown'}</span>
                <span className="text-text-muted">→</span>
                <input
                  type="text"
                  value={baseBranch}
                  onChange={(e) => setBaseBranch(e.target.value)}
                  className="font-mono bg-transparent border-b border-border-default text-text-primary outline-none focus:border-primary/50 px-1 w-20"
                  placeholder="main"
                />
              </div>

              {/* Title */}
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">Title</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="PR title..."
                  className="w-full px-3 py-2 rounded-md text-sm bg-surface-base border border-border-default text-text-body placeholder-text-muted outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30 transition-colors"
                />
              </div>

              {/* Description */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-text-secondary">Description</label>
                  <button
                    type="button"
                    onClick={() => void handleGenerateDescription()}
                    disabled={isGenerating}
                    className="inline-flex items-center gap-1 text-[10px] text-info hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {isGenerating ? (
                      <Loader2 size={10} className="animate-spin" />
                    ) : (
                      <Sparkles size={10} />
                    )}
                    Auto-generate
                  </button>
                </div>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Describe your changes..."
                  rows={6}
                  className="w-full px-3 py-2 rounded-md text-xs bg-surface-base border border-border-default text-text-body placeholder-text-muted outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30 transition-colors resize-none font-mono"
                />
              </div>

              {/* Error */}
              {error && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-danger/10 border border-danger/20 text-xs text-danger">
                  <AlertCircle size={14} className="shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border-subtle">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-md text-xs font-medium border border-border-default text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-colors"
          >
            {prUrl ? 'Close' : 'Cancel'}
          </button>
          {!prUrl && (
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={!title.trim() || isCreating}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-xs font-medium bg-primary hover:bg-primary-hover text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isCreating ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <GitPullRequest size={12} />
              )}
              Create Pull Request
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
