import { useState, useEffect, useCallback } from 'react'
import { Sparkles, FileText, Check, X, Loader2, FilePlus, ArrowLeftRight } from 'lucide-react'
import { useWorkspaceStore, useMemoryStore } from '@renderer/store'
import CodeEditor from '@renderer/components/settings/CodeEditor'
import RegenerateOverlay from './RegenerateOverlay'

/**
 * CLAUDE.md tab panel — loads current on-disk content, allows regeneration,
 * and shows an inline diff with sticky action bar for approval.
 */
export default function ClaudeMdPanel(): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const {
    claudeMdContent,
    claudeMdPath,
    claudeMdLoading,
    feedStatus,
    feedMessage,
    loadClaudeMd,
    startFeed,
    dismissFeed,
    cancelFeed
  } = useMemoryStore()

  const [diffData, setDiffData] = useState<{
    existing: string | null
    generated: string
  } | null>(null)
  const [editedContent, setEditedContent] = useState('')
  const [isConfirming, setIsConfirming] = useState(false)

  const workspacePath = activeWorkspace?.repoPath ?? ''
  const workspaceId = activeWorkspace?.id ?? ''

  // Load current CLAUDE.md on mount
  useEffect(() => {
    if (workspacePath) {
      loadClaudeMd(workspacePath)
    }
  }, [workspacePath])

  const handleRegenerate = useCallback(async () => {
    if (!workspacePath || !workspaceId) return
    startFeed('document')
    try {
      const result = await window.api.memoryRegenerateClaudeMd({
        workspacePath,
        workspaceId
      })
      if (result.success && result.content) {
        setDiffData({ existing: result.existing ?? null, generated: result.content })
        setEditedContent(result.content)
        dismissFeed()
      } else {
        useMemoryStore.setState({
          feedStatus: 'error',
          feedError: result.error || 'CLAUDE.md generation produced no content'
        })
      }
    } catch (err) {
      useMemoryStore.setState({
        feedStatus: 'error',
        feedError: err instanceof Error ? err.message : 'CLAUDE.md generation failed'
      })
    }
  }, [workspacePath, workspaceId])

  const handleConfirm = useCallback(async () => {
    if (!workspacePath) return
    setIsConfirming(true)
    try {
      await window.api.confirmClaudeMd({ workspacePath, content: editedContent })
      setDiffData(null)
      // Reload the on-disk content
      await loadClaudeMd(workspacePath)
    } finally {
      setIsConfirming(false)
    }
  }, [workspacePath, editedContent])

  const handleDismiss = useCallback(() => {
    setDiffData(null)
  }, [])

  // ── Diff view (after regeneration) ──
  if (diffData) {
    return (
      <div className="flex flex-col h-full min-h-0">
        {/* Sticky action bar */}
        <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-2.5 border-b border-border-default bg-surface-base/95 backdrop-blur-sm rounded-t-lg">
          <div className="flex items-center gap-2">
            <ArrowLeftRight size={14} className="text-primary-text" />
            <span className="text-sm font-medium text-text-primary">Review CLAUDE.md Changes</span>
            {claudeMdPath && (
              <span className="text-[11px] text-text-muted font-mono truncate max-w-[280px]">
                {claudeMdPath}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDismiss}
              disabled={isConfirming}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm text-text-muted hover:text-text-primary hover:bg-surface-raised transition-colors disabled:opacity-50"
            >
              <X size={14} />
              Cancel
            </button>
            <button
              data-testid="claude-md-approve"
              onClick={handleConfirm}
              disabled={isConfirming}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-md text-sm font-medium bg-success hover:bg-success/90 text-white transition-colors disabled:opacity-50"
            >
              {isConfirming ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Writing…
                </>
              ) : (
                <>
                  <Check size={14} />
                  Approve &amp; Write
                </>
              )}
            </button>
          </div>
        </div>

        {/* Side-by-side panels */}
        <div className="flex-1 flex min-h-0 overflow-hidden">
          {/* Left — Current */}
          <div className="flex-1 flex flex-col min-w-0 border-r border-border-default">
            <div className="flex items-center gap-2 px-4 py-2 border-b border-border-default bg-surface-base/30">
              <FileText size={13} className="text-text-muted" />
              <span className="text-xs font-medium text-text-muted">Current</span>
              {!diffData.existing && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-raised text-text-muted">
                  No file
                </span>
              )}
            </div>
            <div className="flex-1 overflow-auto p-2">
              {diffData.existing ? (
                <CodeEditor
                  value={diffData.existing}
                  onChange={() => {}}
                  language="markdown"
                  readOnly
                  className="h-full min-h-full !border-border-default"
                />
              ) : (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center">
                    <FilePlus size={28} className="text-border-default mx-auto mb-2" />
                    <p className="text-sm text-text-secondary">No CLAUDE.md exists</p>
                    <p className="text-xs text-border-default mt-1">A new file will be created</p>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Right — Proposed (editable) */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="flex items-center gap-2 px-4 py-2 border-b border-border-default bg-surface-base/30">
              <FilePlus size={13} className="text-success" />
              <span className="text-xs font-medium text-success">Proposed</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-success-muted text-success border border-success/20">
                Editable
              </span>
            </div>
            <div className="flex-1 overflow-auto p-2">
              <CodeEditor
                value={editedContent}
                onChange={setEditedContent}
                language="markdown"
                className="h-full min-h-full !border-border-default"
              />
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Main panel (no diff active) ──
  return (
    <div className="relative space-y-4">
      {/* Regeneration overlay */}
      {feedStatus === 'running' && (
        <RegenerateOverlay
          message={feedMessage}
          onCancel={cancelFeed}
        />
      )}

      {/* Header with file path */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-text-primary">CLAUDE.md</h3>
          {claudeMdPath && (
            <p className="text-xs text-text-muted font-mono mt-0.5 truncate max-w-lg">
              {claudeMdPath}
            </p>
          )}
        </div>
        <button
          onClick={handleRegenerate}
          disabled={feedStatus === 'running' || claudeMdLoading}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-primary-muted text-primary-text border border-border-default rounded-lg hover:bg-primary/20 disabled:opacity-50 transition-colors"
        >
          <Sparkles className="w-4 h-4" />
          Regenerate CLAUDE.md
        </button>
      </div>

      {/* Current content preview */}
      {claudeMdLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-5 h-5 animate-spin text-text-muted" />
        </div>
      ) : claudeMdContent ? (
        <div className="border border-border-default rounded-lg overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2 border-b border-border-default bg-surface-overlay/50">
            <FileText size={13} className="text-success" />
            <span className="text-xs font-medium text-text-secondary">Current on-disk content</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-success-muted text-success">
              {claudeMdContent.split('\n').length} lines
            </span>
          </div>
          <div className="max-h-[500px] overflow-auto">
            <CodeEditor
              value={claudeMdContent}
              onChange={() => {}}
              language="markdown"
              readOnly
              className="!border-0"
            />
          </div>
        </div>
      ) : (
        <div className="text-center py-16 text-text-muted border border-border-default border-dashed rounded-lg">
          <FileText className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p className="text-sm">No CLAUDE.md exists in this workspace</p>
          <p className="text-xs mt-1">Click "Regenerate CLAUDE.md" to create one from your memories</p>
        </div>
      )}

      {/* Feed error display */}
      {feedStatus === 'error' && (
        <div className="px-4 py-2.5 bg-danger/10 border border-danger/30 rounded-md text-xs text-danger">
          {useMemoryStore.getState().feedError ?? 'An error occurred'}
        </div>
      )}
    </div>
  )
}
