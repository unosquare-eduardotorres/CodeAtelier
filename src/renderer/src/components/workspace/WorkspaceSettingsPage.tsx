import { useState } from 'react';
import { ArrowLeft, FolderOpen, Plus, Trash2, Check, Settings } from 'lucide-react';
import { useWorkspaceStore } from '@renderer/store';
import { ConfirmDialog } from '@renderer/components/common';
import { AGENT_META } from '../../../../shared/constants';

interface WorkspaceSettingsPageProps {
  onBack: () => void;
}

export default function WorkspaceSettingsPage({
  onBack
}: WorkspaceSettingsPageProps): React.JSX.Element {
  const { workspaces, activeWorkspace, openWorkspace, createWorkspace, deleteWorkspace } =
    useWorkspaceStore();
  const [isAdding, setIsAdding] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [agentConfig, setAgentConfig] = useState<Record<string, { enabled: boolean; systemPrompt?: string }>>({});
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);

  const toggleAgent = (agentId: string): void => {
    setAgentConfig((prev) => ({
      ...prev,
      [agentId]: {
        ...prev[agentId],
        enabled: prev[agentId]?.enabled === false ? true : false
      }
    }));
  };

  const updateAgentPrompt = (agentId: string, prompt: string): void => {
    setAgentConfig((prev) => ({
      ...prev,
      [agentId]: {
        ...prev[agentId],
        enabled: prev[agentId]?.enabled !== false,
        systemPrompt: prompt
      }
    }));
  };

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
  };

  return (
    <>
      <div className="flex-1 flex flex-col bg-gray-900 min-w-0">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-3 border-b border-gray-700 bg-gray-900">
          <button
            onClick={onBack}
            className="p-1.5 rounded-md hover:bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
            aria-label="Back to chat"
            title="Back to chat"
          >
            <ArrowLeft size={16} />
          </button>
          <Settings size={16} className="text-indigo-400" />
          <span className="text-sm font-semibold text-gray-200">Workspace Settings</span>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-6 py-8">
            {/* Active workspace section */}
            {activeWorkspace && (
              <div className="mb-8">
                <h3 className="text-xs text-gray-500 uppercase tracking-wider mb-3 font-medium">
                  Active Workspace
                </h3>
                <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-indigo-600 text-white text-sm font-semibold">
                      {activeWorkspace.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-200">
                        {activeWorkspace.name}
                      </div>
                      <div className="text-xs text-gray-500 truncate mt-0.5">
                        {activeWorkspace.repoPath}
                      </div>
                    </div>
                    <Check size={16} className="text-indigo-400 flex-shrink-0" />
                  </div>
                </div>
              </div>
            )}

            {/* All workspaces section */}
            <div className="mb-8">
              <h3 className="text-xs text-gray-500 uppercase tracking-wider mb-3 font-medium">
                All Workspaces
              </h3>
              <div className="space-y-1">
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
                          : 'hover:bg-gray-800/60 border border-transparent'
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
                        <div className="text-sm font-medium text-gray-200 truncate">
                          {ws.name}
                        </div>
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
            </div>

            {/* Add workspace button */}
            <button
              onClick={handleAddWorkspace}
              disabled={isAdding}
              className="flex items-center gap-2 px-4 py-2.5 w-full justify-center rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 mb-8"
            >
              <Plus size={16} />
              <span>Add Workspace</span>
            </button>

            {/* Agent Configuration section */}
            {activeWorkspace && (
              <div className="mb-8">
                <h3 className="text-xs text-gray-500 uppercase tracking-wider mb-3 font-medium">
                  Agent Configuration
                </h3>
                <div className="space-y-2">
                  {Object.entries(AGENT_META).map(([agentId, meta]) => (
                    <div key={agentId} className="bg-gray-800/50 border border-gray-700/50 rounded-lg p-3">
                      <div className="flex items-center justify-between">
                        <button
                          onClick={() => setExpandedAgent(expandedAgent === agentId ? null : agentId)}
                          className="flex items-center gap-2 hover:opacity-80 transition-opacity"
                        >
                          <span className="text-base">{meta.icon}</span>
                          <span className="text-sm font-medium text-gray-200">{meta.displayName}</span>
                        </button>
                        {/* Toggle switch */}
                        <button
                          onClick={() => toggleAgent(agentId)}
                          className={`relative w-9 h-5 rounded-full transition-colors ${
                            agentConfig[agentId]?.enabled !== false ? 'bg-indigo-600' : 'bg-gray-600'
                          }`}
                          aria-label={`Toggle ${meta.displayName}`}
                        >
                          <span
                            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                              agentConfig[agentId]?.enabled !== false ? 'translate-x-4' : ''
                            }`}
                          />
                        </button>
                      </div>
                      {/* Expandable custom prompt area */}
                      {expandedAgent === agentId && (
                        <div className="mt-3 pt-3 border-t border-gray-700/50">
                          <label className="text-xs text-gray-500 mb-1.5 block">Custom System Prompt</label>
                          <textarea
                            value={agentConfig[agentId]?.systemPrompt ?? ''}
                            onChange={(e) => updateAgentPrompt(agentId, e.target.value)}
                            placeholder={`Custom instructions for ${meta.displayName}...`}
                            className="w-full bg-gray-900/50 border border-gray-700/50 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-600 outline-none focus:border-indigo-500/50 resize-none"
                            rows={3}
                          />
                          <p className="text-xs text-gray-600 mt-1.5">
                            Skill files support coming soon.
                          </p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <p className="text-xs text-gray-600 mt-3">
                  Agent configuration will be saved to this workspace&apos;s settings.
                </p>
              </div>
            )}
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
