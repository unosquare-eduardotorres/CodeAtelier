import { useEffect, useCallback } from 'react'
import { useCodeChangesStore, useWorkspaceStore } from '@renderer/store'
import { FileEdit, GitCompareArrows, GitMerge, RefreshCw } from 'lucide-react'
import FileChangeList from './FileChangeList'
import FileDiffView from './FileDiffView'
import CommitBar from './CommitBar'
import type { DiffComparisonMode } from '../../../../shared/types'

interface CodeChangesPanelProps {
  conversationId: string
  onNavigateToSettings?: () => void
}

const MODE_CONFIG: Array<{
  mode: DiffComparisonMode
  label: string
  icon: typeof FileEdit
  tooltip: string
}> = [
  {
    mode: 'uncommitted',
    label: 'Uncommitted',
    icon: FileEdit,
    tooltip: 'Changes not yet committed (HEAD vs Working Tree)'
  },
  {
    mode: 'branch-vs-target',
    label: 'Branch → Target',
    icon: GitCompareArrows,
    tooltip: 'Committed changes on your branch since the branch point (what a PR would show)'
  },
  {
    mode: 'all-vs-target',
    label: 'All → Target',
    icon: GitMerge,
    tooltip: 'All changes (committed + uncommitted) since the branch point (what a PR would show)'
  }
]

export default function CodeChangesPanel({
  conversationId,
  onNavigateToSettings
}: CodeChangesPanelProps): React.JSX.Element {
  const repoInfo = useWorkspaceStore((s) => s.repoInfo)
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const files = useCodeChangesStore((s) => s.files)
  const selectedFile = useCodeChangesStore((s) => s.selectedFile)
  const checkedFiles = useCodeChangesStore((s) => s.checkedFiles)
  const isLoadingFiles = useCodeChangesStore((s) => s.isLoadingFiles)
  const currentDiff = useCodeChangesStore((s) => s.currentDiff)
  const isLoadingDiff = useCodeChangesStore((s) => s.isLoadingDiff)
  const comparisonMode = useCodeChangesStore((s) => s.comparisonMode)
  const targetBranch = useCodeChangesStore((s) => s.targetBranch)
  const availableBranches = useCodeChangesStore((s) => s.availableBranches)
  const isFetching = useCodeChangesStore((s) => s.isFetching)

  const {
    loadFiles,
    selectFile,
    toggleCheck,
    selectAll,
    deselectAll,
    refreshPushStatus,
    setComparisonMode,
    setTargetBranch,
    loadBranches,
    fetchAndRefresh
  } = useCodeChangesStore.getState()

  // Load files, push status, and branches on mount
  useEffect(() => {
    void loadFiles(conversationId)
    void refreshPushStatus(conversationId)
    if (activeWorkspace?.id) {
      void loadBranches(activeWorkspace.id)
    }
  }, [conversationId, activeWorkspace?.id, loadFiles, refreshPushStatus, loadBranches])

  const handleSelectFile = useCallback(
    (filePath: string): void => {
      void selectFile(conversationId, filePath)
    },
    [conversationId, selectFile]
  )

  const handleModeChange = useCallback(
    (mode: DiffComparisonMode): void => {
      setComparisonMode(mode, conversationId)
    },
    [conversationId, setComparisonMode]
  )

  const handleTargetChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>): void => {
      setTargetBranch(e.target.value, conversationId)
    },
    [conversationId, setTargetBranch]
  )

  const handleFetchRemote = useCallback((): void => {
    if (activeWorkspace?.id) {
      void fetchAndRefresh(conversationId, activeWorkspace.id)
    }
  }, [activeWorkspace?.id, conversationId, fetchAndRefresh])

  const hasRemote = repoInfo?.hasRemote ?? false
  const currentBranch = repoInfo?.currentBranch ?? ''
  const displayBranch = currentBranch === 'HEAD' ? 'detached HEAD' : currentBranch

  // Determine diff viewer labels based on mode
  let leftLabel: string
  let rightLabel: string
  switch (comparisonMode) {
    case 'branch-vs-target':
      leftLabel = `${targetBranch} (branch point)`
      rightLabel = `HEAD (${displayBranch})`
      break
    case 'all-vs-target':
      leftLabel = `${targetBranch} (branch point)`
      rightLabel = `Working Tree (${displayBranch})`
      break
    default:
      leftLabel = 'Previous (HEAD)'
      rightLabel = 'Current (Working Tree)'
  }

  return (
    <div data-testid="code-changes-panel" className="flex-1 flex flex-col min-h-0">
      {/* Comparison mode toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border-subtle bg-surface-overlay/30 shrink-0">
        {/* Mode selector — segmented button group */}
        <div className="flex rounded-md border border-border-default overflow-hidden">
          {MODE_CONFIG.map(({ mode, label, icon: Icon, tooltip }) => {
            const isActive = comparisonMode === mode
            const isDisabled = mode !== 'uncommitted' && !hasRemote

            return (
              <button
                key={mode}
                type="button"
                onClick={() => handleModeChange(mode)}
                disabled={isDisabled}
                title={isDisabled ? 'No remote configured' : tooltip}
                className={`
                  inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors
                  ${isActive ? 'bg-primary text-white' : 'bg-surface-float text-text-secondary hover:bg-surface-overlay hover:text-text-primary'}
                  ${isDisabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
                  ${mode !== 'uncommitted' ? 'border-l border-border-default' : ''}
                `}
              >
                <Icon size={12} />
                {label}
              </button>
            )
          })}
        </div>

        {/* Target branch selector — visible when mode ≠ uncommitted */}
        {comparisonMode !== 'uncommitted' && (
          <div className="flex items-center gap-1.5 text-xs text-text-secondary">
            <span className="text-text-muted">vs</span>
            <select
              value={targetBranch}
              onChange={handleTargetChange}
              className="px-2 py-1 rounded border border-border-default bg-surface-base text-text-body text-xs outline-none focus:border-primary/50 cursor-pointer"
            >
              {/* Values are fully-qualified refs so a local branch is a valid target. */}
              {availableBranches.remote.length === 0 && availableBranches.local.length === 0 && (
                <option value={targetBranch}>{targetBranch}</option>
              )}
              {availableBranches.remote.length > 0 && (
                <optgroup label="Remote">
                  {availableBranches.remote.map((b) => (
                    <option key={`remote-${b}`} value={`origin/${b}`}>
                      origin/{b}
                    </option>
                  ))}
                </optgroup>
              )}
              {availableBranches.local.length > 0 && (
                <optgroup label="Local">
                  {availableBranches.local.map((b) => (
                    <option key={`local-${b}`} value={b}>
                      {b}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>

            {/* Fetch button to refresh remote refs */}
            <button
              type="button"
              onClick={handleFetchRemote}
              disabled={isFetching}
              title="Fetch latest from origin"
              className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors disabled:opacity-50"
            >
              <RefreshCw size={12} className={isFetching ? 'animate-spin' : ''} />
            </button>
          </div>
        )}
      </div>

      {/* Master-detail layout */}
      <div className="flex-1 flex min-h-0">
        {/* Left: File list */}
        <FileChangeList
          files={files}
          selectedFile={selectedFile}
          checkedFiles={checkedFiles}
          onSelectFile={handleSelectFile}
          onToggleCheck={toggleCheck}
          onSelectAll={selectAll}
          onDeselectAll={deselectAll}
          isLoading={isLoadingFiles}
          isGitConfigured={repoInfo?.isRepo ?? false}
          onNavigateToSettings={onNavigateToSettings}
          comparisonMode={comparisonMode}
          currentBranch={displayBranch}
          targetBranch={targetBranch}
        />

        {/* Right: Diff view */}
        <FileDiffView
          filePath={selectedFile}
          diff={currentDiff}
          isLoading={isLoadingDiff}
          leftLabel={leftLabel}
          rightLabel={rightLabel}
        />
      </div>

      {/* Bottom: Commit bar */}
      <CommitBar
        conversationId={conversationId}
        comparisonMode={comparisonMode}
        currentBranch={displayBranch}
        targetBranch={targetBranch}
        fileCount={files.length}
      />
    </div>
  )
}
