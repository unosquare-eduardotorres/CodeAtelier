import { useState } from 'react';
import { X, FolderOpen, Plus, Trash2, Check } from 'lucide-react';
import { useWorkspaceStore } from '@renderer/store';
import { ConfirmDialog } from '@renderer/components/common';

interface WorkspaceConfigModalProps {
  onClose: () => void;
}

export default function WorkspaceConfigModal({
  onClose
}: WorkspaceConfigModalProps): React.JSX.Element {
  const { workspaces, activeWorkspace, openWorkspace, createWorkspace, deleteWorkspace } =
    useWorkspaceStore();
  const [isAdding, setIsAdding] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const sortedWorkspaces = [...workspaces].sort(
    (a, b) => new Date(b.lastOpenedAt).getTime() - new Date(a.lastOpenedAt).getTime()
  );

  const handleAddWorkspace = async (): Promise<void> => {
    setIsAdding(true);
    try {
      const dirPath = await window.api.selectDirectory();
      if (dirPath) {
        const name = dirPath.split('/').pop() || dirPath.split('\\').pop() || 'Untitled';
        await createWorkspace(name, dirPath);
      }
    } catch (error) {
      console.error('Failed to add workspace:', error);
    } finally {
      setIsAdding(false);
    }
  };

  const handleDeleteConfirm = async (): Promise<void> => {
    if (deleteTarget) {
      await deleteWorkspace(deleteTarget);
      setDeleteTarget(null);
    }
  };

  const handleSwitchWorkspace = async (id: string): Promise<void> => {
    await openWorkspace(id);
    onClose();
  };

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-config-title"
      >
        {/* Backdrop */}
        <div
          className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          onClick={onClose}
        />

        {/* Modal */}
        <div className="relative bg-gray-800 border border-gray-700 rounded-xl w-[480px] max-h-[600px] shadow-2xl flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
            <div className="flex items-center gap-2">
              <FolderOpen size={18} className="text-indigo-400" />
              <h2 id="workspace-config-title" className="text-base font-semibold text-gray-100">
                Workspace Settings
              </h2>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md hover:bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>

          {/* Current workspace info */}
          {activeWorkspace && (
            <div className="px-6 py-3 border-b border-gray-700/50 bg-gray-800/50">
              <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">
                Active Workspace
              </div>
              <div className="text-sm font-medium text-gray-200">{activeWorkspace.name}</div>
              <div className="text-xs text-gray-500 truncate mt-0.5">
                {activeWorkspace.repoPath}
              </div>
            </div>
          )}

          {/* Workspace list */}
          <div className="flex-1 overflow-y-auto p-4 space-y-1">
            {sortedWorkspaces.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <FolderOpen size={32} className="text-gray-700 mb-3" />
                <p className="text-sm text-gray-500 mb-1">No workspaces yet</p>
                <p className="text-xs text-gray-600">Add a project folder to get started</p>
              </div>
            ) : (
              sortedWorkspaces.map((ws) => (
                <div
                  key={ws.id}
                  className={`group flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors cursor-pointer ${
                    activeWorkspace?.id === ws.id
                      ? 'bg-indigo-600/20 border border-indigo-500/30'
                      : 'hover:bg-gray-700/50 border border-transparent'
                  }`}
                  onClick={() => handleSwitchWorkspace(ws.id)}
                >
                  <div
                    className={`flex items-center justify-center w-9 h-9 rounded-lg text-sm font-semibold ${
                      activeWorkspace?.id === ws.id
                        ? 'bg-indigo-600 text-white'
                        : 'bg-gray-700 text-gray-400'
                    }`}
                  >
                    {ws.name.charAt(0).toUpperCase()}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-200 truncate">{ws.name}</div>
                    <div className="text-xs text-gray-500 truncate">{ws.repoPath}</div>
                  </div>

                  <div className="flex items-center gap-1">
                    {activeWorkspace?.id === ws.id && (
                      <Check size={14} className="text-indigo-400 mr-1" />
                    )}
                    <button
                      className="hidden group-hover:flex items-center justify-center w-7 h-7 rounded-md hover:bg-red-500/20 text-gray-500 hover:text-red-400 transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(ws.id);
                      }}
                      aria-label={`Remove workspace: ${ws.name}`}
                      title="Remove workspace"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-gray-700">
            <button
              onClick={handleAddWorkspace}
              disabled={isAdding}
              className="flex items-center gap-2 px-4 py-2 w-full justify-center rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              <Plus size={16} />
              <span>Add Workspace</span>
            </button>
          </div>
        </div>
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
    </>
  );
}
