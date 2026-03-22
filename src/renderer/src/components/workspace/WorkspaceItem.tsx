import { Settings, Trash2 } from 'lucide-react';
import type { Workspace } from '../../../../shared/types';

interface WorkspaceItemProps {
  workspace: Workspace;
  isActive: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
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
          ? 'bg-indigo-600/20 border border-indigo-500/30'
          : 'hover:bg-gray-800/60 border border-transparent'
      }`}
      onClick={() => onSelect(workspace.id)}
      role="button"
      tabIndex={0}
      aria-label={`Open workspace: ${workspace.name}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(workspace.id);
        }
      }}
    >
      <div
        className={`flex items-center justify-center w-9 h-9 rounded-lg text-sm font-semibold ${
          isActive ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-400'
        }`}
      >
        {workspace.name.charAt(0).toUpperCase()}
      </div>

      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-200 truncate">{workspace.name}</div>
        <div className="text-xs text-gray-500 truncate">{workspace.repoPath}</div>
      </div>

      <div className="flex items-center gap-1">
        <span className="text-[10px] text-gray-600 group-hover:hidden">
          {formatRelativeTime(workspace.lastOpenedAt)}
        </span>

        {/* #14 - Settings placeholder (Phase 2) */}
        {isActive && (
          <button
            className="hidden group-hover:flex items-center justify-center w-7 h-7 rounded-md hover:bg-gray-700/50 text-gray-500 hover:text-gray-300 transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              // Settings coming in Phase 2
            }}
            aria-label="Workspace settings (coming soon)"
            title="Settings (Phase 2)"
          >
            <Settings size={14} />
          </button>
        )}

        <button
          className="hidden group-hover:flex items-center justify-center w-7 h-7 rounded-md hover:bg-red-500/20 text-gray-500 hover:text-red-400 transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(workspace.id);
          }}
          aria-label={`Remove workspace: ${workspace.name}`}
          title="Remove workspace"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}
