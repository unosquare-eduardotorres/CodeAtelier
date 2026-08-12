import { useState, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued'
import {
  Sparkles,
  FileText,
  Check,
  X,
  Loader2,
  ArrowLeftRight,
  Copy,
  FolderOpen,
  Pencil
} from 'lucide-react'
import { useWorkspaceStore, useMemoryStore } from '@renderer/store'
import CodeEditor from '@renderer/components/settings/CodeEditor'
import { codeAtelierDiffStyles } from '@renderer/components/chat/diff-theme'
import { Button, SegmentedControl, Tooltip } from '@renderer/components/common/ui'
import RegenerateOverlay from './RegenerateOverlay'

/**
 * GFM prose stack. Tables matter here specifically: CLAUDE.md is mostly
 * tables, and rendering it through a code editor exploded every row into
 * unaligned `| Layer | Technology |` lines.
 */
const PROSE_CLASSES = `prose prose-sm prose-invert max-w-none text-text-secondary
  prose-headings:text-text-primary prose-headings:font-semibold
  prose-p:text-sm prose-li:text-sm
  prose-code:text-xs prose-code:bg-surface-overlay prose-code:px-1 prose-code:rounded
  prose-code:before:content-none prose-code:after:content-none
  prose-pre:bg-surface-base prose-pre:border prose-pre:border-border-subtle
  prose-table:text-xs prose-th:text-text-primary prose-th:font-medium
  prose-td:border-border-subtle prose-th:border-border-subtle
  prose-strong:text-text-primary prose-a:text-primary-text`

type ViewMode = 'rendered' | 'source'

const VIEW_MODES = [
  { value: 'rendered' as const, label: 'Rendered' },
  { value: 'source' as const, label: 'Source' }
]

/** Path chip that copies on click and can reveal the file in the OS shell. */
function PathChip({ path }: { path: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  return (
    <span className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded border border-border-default bg-surface-overlay">
      <span className="font-mono text-[11px] text-text-muted truncate max-w-[26rem]" title={path}>
        {path}
      </span>
      <Tooltip content={copied ? 'Copied' : 'Copy path'}>
        <button
          type="button"
          aria-label="Copy path"
          onClick={() => {
            void navigator.clipboard.writeText(path)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
          className="p-0.5 rounded text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-focus"
        >
          {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
        </button>
      </Tooltip>
      <Tooltip content="Reveal in file manager">
        <button
          type="button"
          aria-label="Reveal in file manager"
          onClick={() => void window.api.showItemInFolder(path)}
          className="p-0.5 rounded text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-focus"
        >
          <FolderOpen className="w-3 h-3" />
        </button>
      </Tooltip>
    </span>
  )
}

/**
 * CLAUDE.md tab panel — renders the on-disk file, regenerates it, and shows a
 * real diff of the proposal before anything is written.
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
  const [editingProposal, setEditingProposal] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('rendered')

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
        setEditingProposal(false)
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
      await loadClaudeMd(workspacePath)
    } finally {
      setIsConfirming(false)
    }
  }, [workspacePath, editedContent])

  // ── Diff view (after regeneration) ──
  if (diffData) {
    return (
      <div className="flex flex-col h-full min-h-0">
        {/* Action bar */}
        <div className="flex items-center justify-between gap-3 px-1 py-2 border-b border-border-default shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <ArrowLeftRight size={14} className="text-primary-text shrink-0" />
            <span className="text-sm font-medium text-text-primary">Review CLAUDE.md Changes</span>
            {claudeMdPath && <PathChip path={claudeMdPath} />}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant={editingProposal ? 'primary' : 'ghost'}
              onClick={() => setEditingProposal((v) => !v)}
              aria-pressed={editingProposal}
            >
              <Pencil size={13} />
              Edit proposed
            </Button>
            <Button variant="ghost" onClick={() => setDiffData(null)} disabled={isConfirming}>
              <X size={13} />
              Cancel
            </Button>
            <Button
              data-testid="claude-md-approve"
              variant="success"
              size="md"
              onClick={handleConfirm}
              disabled={isConfirming}
            >
              {isConfirming ? (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  Writing…
                </>
              ) : (
                <>
                  <Check size={13} />
                  Approve &amp; Write
                </>
              )}
            </Button>
          </div>
        </div>

        {/* Diff — highlights what changed instead of asking you to eyeball
            two full editors side by side */}
        <div className="flex-1 min-h-0 overflow-auto">
          {editingProposal ? (
            <CodeEditor
              value={editedContent}
              onChange={setEditedContent}
              language="markdown"
              className="min-h-full !border-0"
            />
          ) : (
            <ReactDiffViewer
              oldValue={diffData.existing ?? ''}
              newValue={editedContent}
              splitView
              useDarkTheme
              compareMethod={DiffMethod.WORDS}
              showDiffOnly={false}
              leftTitle={diffData.existing ? 'Current' : 'No file yet'}
              rightTitle="Proposed"
              styles={codeAtelierDiffStyles}
            />
          )}
        </div>
      </div>
    )
  }

  // ── Main panel (no diff active) ──
  return (
    <div className="relative flex flex-col h-full min-h-0">
      {feedStatus === 'running' && (
        <RegenerateOverlay message={feedMessage} onCancel={cancelFeed} />
      )}

      {/* Header */}
      <div className="flex items-center justify-between gap-3 pb-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <FileText size={14} className="text-text-muted shrink-0" />
          <h3 className="text-sm font-medium text-text-primary">CLAUDE.md</h3>
          {claudeMdPath && <PathChip path={claudeMdPath} />}
          {claudeMdContent && (
            <span className="font-mono text-[11px] tabular-nums text-text-muted shrink-0">
              {claudeMdContent.split('\n').length} lines
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {claudeMdContent && (
            <SegmentedControl
              value={viewMode}
              segments={VIEW_MODES}
              onChange={setViewMode}
              ariaLabel="CLAUDE.md view mode"
            />
          )}
          <Button
            variant="primary"
            size="md"
            onClick={handleRegenerate}
            disabled={feedStatus === 'running' || claudeMdLoading}
          >
            <Sparkles className="w-4 h-4" />
            Regenerate CLAUDE.md
          </Button>
        </div>
      </div>

      {/* Content — one scroll container, not a max-height box nested in the
          page scroll */}
      {claudeMdLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-5 h-5 animate-spin text-text-muted" />
        </div>
      ) : claudeMdContent ? (
        <div className="flex-1 min-h-0 overflow-auto border border-border-default rounded-lg">
          {viewMode === 'rendered' ? (
            <div className={`${PROSE_CLASSES} p-4`}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{claudeMdContent}</ReactMarkdown>
            </div>
          ) : (
            <CodeEditor
              value={claudeMdContent}
              onChange={() => {}}
              language="markdown"
              readOnly
              className="!border-0"
            />
          )}
        </div>
      ) : (
        <div className="text-center py-16 text-text-muted border border-border-default border-dashed rounded-lg">
          <FileText className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p className="text-sm">No CLAUDE.md exists in this workspace</p>
          <p className="text-xs mt-1">
            Click &quot;Regenerate CLAUDE.md&quot; to create one from your memories
          </p>
        </div>
      )}

      {feedStatus === 'error' && (
        <div className="mt-3 px-4 py-2.5 bg-danger-muted border border-danger/30 rounded-md text-xs text-danger shrink-0">
          {useMemoryStore.getState().feedError ?? 'An error occurred'}
        </div>
      )}
    </div>
  )
}
