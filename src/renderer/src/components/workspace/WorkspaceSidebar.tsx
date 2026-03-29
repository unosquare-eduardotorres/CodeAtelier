import { useState } from 'react'
import { Plus, FolderOpen, ChevronLeft, ChevronRight } from 'lucide-react'
import { useWorkspaceStore } from '@renderer/store'
import { WorkspaceItem } from '@renderer/components/workspace'
import { ConfirmDialog } from '@renderer/components/common'

interface WorkspaceSidebarProps {
  isCollapsed?: boolean
  onToggleCollapse?: () => void
}

export default function WorkspaceSidebar({
  isCollapsed: externalCollapsed,
  onToggleCollapse
}: WorkspaceSidebarProps): React.JSX.Element {
  const { workspaces, activeWorkspace, openWorkspace, createWorkspace, deleteWorkspace } =
    useWorkspaceStore()
  const [internalCollapsed, setInternalCollapsed] = useState(false)
  const [isAdding, setIsAdding] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  const isCollapsed = externalCollapsed ?? internalCollapsed
  const toggleCollapse = onToggleCollapse ?? (() => setInternalCollapsed((c) => !c))

  const handleAddWorkspace = async (): Promise<void> => {
    setIsAdding(true)
    try {
      const dirPath = await window.api.selectDirectory()
      if (dirPath) {
        // Use the folder name as workspace name
        const name = dirPath.split('/').pop() || dirPath.split('\\').pop() || 'Untitled'
        await createWorkspace(name, dirPath)
      }
    } catch (error) {
      console.error('Failed to add workspace:', error)
    } finally {
      setIsAdding(false)
    }
  }

  const handleDeleteRequest = (id: string): void => {
    setDeleteTarget(id)
  }

  const handleDeleteConfirm = async (): Promise<void> => {
    if (deleteTarget) {
      await deleteWorkspace(deleteTarget)
      setDeleteTarget(null)
    }
  }

  const sortedWorkspaces = [...workspaces].sort(
    (a, b) => new Date(b.lastOpenedAt).getTime() - new Date(a.lastOpenedAt).getTime()
  )

  if (isCollapsed) {
    return (
      <div className="flex flex-col items-center w-12 bg-surface-base border-r border-border-subtle py-3 gap-2">
        <button
          onClick={toggleCollapse}
          className="p-2 rounded-lg hover:bg-surface-raised text-text-muted hover:text-text-primary transition-colors"
          aria-label="Expand sidebar"
          title="Expand sidebar"
        >
          <ChevronRight size={16} />
        </button>
        <div className="w-8 h-px bg-border-subtle my-1" />
        {sortedWorkspaces.map((ws) => (
          <button
            key={ws.id}
            onClick={() => openWorkspace(ws.id)}
            className={`flex items-center justify-center w-8 h-8 rounded-lg text-xs font-semibold transition-colors ${
              activeWorkspace?.id === ws.id
                ? 'bg-primary text-primary-text'
                : 'bg-surface-raised text-text-muted hover:bg-surface-overlay'
            }`}
            title={ws.name}
            aria-label={`Open workspace: ${ws.name}`}
          >
            {ws.name.charAt(0).toUpperCase()}
          </button>
        ))}
        <button
          onClick={handleAddWorkspace}
          className="flex items-center justify-center w-8 h-8 rounded-lg bg-surface-raised text-text-muted hover:bg-surface-overlay hover:text-text-primary transition-colors mt-1"
          aria-label="Add workspace"
          title="Add workspace"
          disabled={isAdding}
        >
          <Plus size={14} />
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col w-60 bg-surface-base border-r border-border-subtle">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
        <div className="flex items-center gap-2">
          <FolderOpen size={16} className="text-primary-text" />
          <span className="text-sm font-semibold text-text-primary">Workspaces</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleAddWorkspace}
            disabled={isAdding}
            className="p-1.5 rounded-md hover:bg-surface-raised text-text-muted hover:text-primary-text transition-colors disabled:opacity-50"
            aria-label="Add workspace"
            title="Add workspace"
          >
            <Plus size={16} />
          </button>
          <button
            onClick={toggleCollapse}
            className="p-1.5 rounded-md hover:bg-surface-raised text-text-muted hover:text-text-primary transition-colors"
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
          >
            <ChevronLeft size={16} />
          </button>
        </div>
      </div>

      {/* Workspace list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {sortedWorkspaces.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
            <FolderOpen size={32} className="text-border-default mb-3" />
            <p className="text-sm text-text-muted mb-1">No workspaces yet</p>
            <p className="text-xs text-text-secondary">Click + to add a project</p>
          </div>
        ) : (
          sortedWorkspaces.map((ws) => (
            <WorkspaceItem
              key={ws.id}
              workspace={ws}
              isActive={activeWorkspace?.id === ws.id}
              onSelect={openWorkspace}
              onDelete={handleDeleteRequest}
            />
          ))
        )}
      </div>

      {/* Confirm delete dialog */}
      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title="Remove Workspace"
        message="Remove this workspace? The project files will not be deleted."
        confirmLabel="Remove"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
