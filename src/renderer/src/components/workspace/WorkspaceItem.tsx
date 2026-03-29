import { Settings, Trash2 } from 'lucide-react'
import type { Workspace } from '../../../../shared/types'

interface WorkspaceItemProps {
  workspace: Workspace
  isActive: boolean
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

export default function WorkspaceItem({
  workspace,
  isActive,
  onSelect,
  onDelete
}: WorkspaceItemProps): React.JSX.Element {
  return (
    <div
      className={`group flex items-center gap-3 px-3 py-2.5 cursor-pointer rounded-lg transition-colors ${
        isActive
          ? 'bg-primary-muted border border-primary/30'
          : 'hover:bg-surface-raised/60 border border-transparent'
      }`}
      onClick={() => onSelect(workspace.id)}
      role="button"
      tabIndex={0}
      aria-label={`Open workspace: ${workspace.name}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(workspace.id)
        }
      }}
    >
      <div
        className={`flex items-center justify-center w-9 h-9 rounded-lg text-sm font-semibold ${
          isActive ? 'bg-primary text-primary-text' : 'bg-surface-raised text-text-muted'
        }`}
      >
        {workspace.name.charAt(0).toUpperCase()}
      </div>

      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-text-primary truncate">{workspace.name}</div>
        <div className="text-xs text-text-muted truncate">{workspace.repoPath}</div>
      </div>

      <div className="flex items-center gap-1">
        <span className="text-[10px] text-text-secondary group-hover:hidden">
          {formatRelativeTime(workspace.lastOpenedAt)}
        </span>

        {/* #14 - Settings placeholder (Phase 2) */}
        {isActive && (
          <button
            className="hidden group-hover:flex items-center justify-center w-7 h-7 rounded-md hover:bg-surface-overlay/50 text-text-muted hover:text-text-secondary transition-colors"
            onClick={(e) => {
              e.stopPropagation()
              // Settings coming in Phase 2
            }}
            aria-label="Workspace settings (coming soon)"
            title="Settings (Phase 2)"
          >
            <Settings size={14} />
          </button>
        )}

        <button
          className="hidden group-hover:flex items-center justify-center w-7 h-7 rounded-md hover:bg-danger-muted text-text-muted hover:text-danger transition-colors"
          onClick={(e) => {
            e.stopPropagation()
            onDelete(workspace.id)
          }}
          aria-label={`Remove workspace: ${workspace.name}`}
          title="Remove workspace"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  )
}
