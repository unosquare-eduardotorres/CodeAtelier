import { useEffect } from 'react'
import { useCodeChangesStore, useWorkspaceStore } from '@renderer/store'
import FileChangeList from './FileChangeList'
import FileDiffView from './FileDiffView'
import CommitBar from './CommitBar'

interface CodeChangesPanelProps {
  conversationId: string
  onNavigateToSettings?: () => void
}

export default function CodeChangesPanel({
  conversationId,
  onNavigateToSettings
}: CodeChangesPanelProps): React.JSX.Element {
  const repoInfo = useWorkspaceStore((s) => s.repoInfo)
  const files = useCodeChangesStore((s) => s.files)
  const selectedFile = useCodeChangesStore((s) => s.selectedFile)
  const checkedFiles = useCodeChangesStore((s) => s.checkedFiles)
  const isLoadingFiles = useCodeChangesStore((s) => s.isLoadingFiles)
  const currentDiff = useCodeChangesStore((s) => s.currentDiff)
  const isLoadingDiff = useCodeChangesStore((s) => s.isLoadingDiff)

  const { loadFiles, selectFile, toggleCheck, selectAll, deselectAll, refreshPushStatus } =
    useCodeChangesStore.getState()

  // Load files and push status on mount
  useEffect(() => {
    void loadFiles(conversationId)
    void refreshPushStatus(conversationId)
  }, [conversationId, loadFiles, refreshPushStatus])

  const handleSelectFile = (filePath: string): void => {
    void selectFile(conversationId, filePath)
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
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
        />

        {/* Right: Diff view */}
        <FileDiffView filePath={selectedFile} diff={currentDiff} isLoading={isLoadingDiff} />
      </div>

      {/* Bottom: Commit bar */}
      <CommitBar conversationId={conversationId} />
    </div>
  )
}
