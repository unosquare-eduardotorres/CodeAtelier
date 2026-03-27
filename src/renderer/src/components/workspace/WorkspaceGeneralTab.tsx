import { useState, useEffect } from 'react'
import { FolderOpen, Plus, Trash2, Check, Coins, Scale, Rocket } from 'lucide-react'
import type { CostPreference } from '../../../../shared/types'
import { useWorkspaceStore } from '@renderer/store'
import { ConfirmDialog } from '@renderer/components/common'

const COST_PREF_ICON: Record<CostPreference, React.ReactNode> = {
  economy: <Coins size={16} />,
  balanced: <Scale size={16} />,
  power: <Rocket size={16} />
}

export default function WorkspaceGeneralTab(): React.JSX.Element {
  const { workspaces, activeWorkspace, openWorkspace, createWorkspace, deleteWorkspace } =
    useWorkspaceStore()
  const [isAdding, setIsAdding] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [costPreference, setCostPreference] = useState<CostPreference>('balanced')

  useEffect(() => {
    if (activeWorkspace) {
      window.api.getWorkspaceSettings({ workspaceId: activeWorkspace.id }).then((settings) => {
        setCostPreference((settings.costPreference as CostPreference) || 'balanced')
      })
    }
  }, [activeWorkspace])

  const handleCostPreferenceChange = async (pref: CostPreference): Promise<void> => {
    setCostPreference(pref)
    if (activeWorkspace) {
      const settings = await window.api.getWorkspaceSettings({ workspaceId: activeWorkspace.id })
      await window.api.updateWorkspaceSettings({
        workspaceId: activeWorkspace.id,
        settings: { ...settings, costPreference: pref }
      })
    }
  }

  const sortedWorkspaces = [...workspaces].sort(
    (a, b) => new Date(b.lastOpenedAt).getTime() - new Date(a.lastOpenedAt).getTime()
  )

  const handleAddWorkspace = async (): Promise<void> => {
    setIsAdding(true)
    try {
      const dirPath = await window.api.selectDirectory()
      if (dirPath) {
        const name = dirPath.split('/').pop() || dirPath.split('\\').pop() || 'Untitled'
        await createWorkspace(name, dirPath)
      }
    } catch (error) {
      console.error('Failed to add workspace:', error)
    } finally {
      setIsAdding(false)
    }
  }

  const handleDeleteConfirm = async (): Promise<void> => {
    if (deleteTarget) {
      await deleteWorkspace(deleteTarget)
      setDeleteTarget(null)
    }
  }

  const handleSwitchWorkspace = async (id: string): Promise<void> => {
    await openWorkspace(id)
  }

  return (
    <>
      <div className="max-w-2xl mx-auto px-6 py-8">
        {/* Active workspace section */}
        {activeWorkspace && (
          <div className="mb-8">
            <h3 className="text-xs text-text-secondary uppercase tracking-wider mb-3 font-medium">
              Active Workspace
            </h3>
            <div className="bg-surface-overlay border border-border-subtle rounded-xl p-4 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-primary text-white text-sm font-semibold">
                  {activeWorkspace.name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-text-primary">
                    {activeWorkspace.name}
                  </div>
                  <div className="text-xs text-text-secondary truncate mt-0.5">
                    {activeWorkspace.repoPath}
                  </div>
                </div>
                <Check size={16} className="text-primary-text flex-shrink-0" />
              </div>
            </div>
          </div>
        )}

        {/* Model Routing section — only show when a workspace is active */}
        {activeWorkspace && (
          <div className="mb-8">
            <h3 className="text-xs text-text-secondary uppercase tracking-wider mb-3 font-medium">
              Model Routing
            </h3>
            <div className="bg-surface-overlay border border-border-subtle rounded-xl p-4 shadow-sm">
              <div className="mb-3">
                <h4 className="text-sm font-medium text-text-primary">Cost Preference</h4>
                <p className="text-xs text-text-muted mt-0.5">
                  Controls which AI model is used for specialist tasks based on task complexity.
                </p>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {(['economy', 'balanced', 'power'] as const).map((pref) => (
                  <button
                    key={pref}
                    onClick={() => handleCostPreferenceChange(pref)}
                    className={`flex flex-col items-center gap-1.5 px-3 py-3 rounded-lg border text-xs font-medium transition-colors ${
                      costPreference === pref
                        ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300'
                        : 'border-border-subtle hover:bg-surface-overlay text-text-secondary'
                    }`}
                  >
                    <span className="text-base">{COST_PREF_ICON[pref]}</span>
                    <span className="capitalize">{pref}</span>
                    <span className="text-[10px] text-text-muted">
                      {pref === 'economy'
                        ? 'Always Haiku'
                        : pref === 'balanced'
                          ? 'Auto-route'
                          : 'Always Opus'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* All workspaces section */}
        <div className="mb-8">
          <h3 className="text-xs text-text-secondary uppercase tracking-wider mb-3 font-medium">
            All Workspaces
          </h3>
          <div className="space-y-1">
            {sortedWorkspaces.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <FolderOpen size={32} className="text-border-default mb-3" />
                <p className="text-sm text-text-secondary mb-1">No workspaces yet</p>
                <p className="text-xs text-text-muted">Add a project folder to get started</p>
              </div>
            ) : (
              sortedWorkspaces.map((ws) => (
                <div
                  key={ws.id}
                  className={`group flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors cursor-pointer ${
                    activeWorkspace?.id === ws.id
                      ? 'bg-primary-muted border border-primary/20'
                      : 'hover:bg-surface-overlay border border-transparent'
                  }`}
                  onClick={() => handleSwitchWorkspace(ws.id)}
                >
                  <div
                    className={`flex items-center justify-center w-9 h-9 rounded-lg text-sm font-semibold ${
                      activeWorkspace?.id === ws.id
                        ? 'bg-primary text-white'
                        : 'bg-surface-overlay text-text-secondary'
                    }`}
                  >
                    {ws.name.charAt(0).toUpperCase()}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-text-primary truncate">{ws.name}</div>
                    <div className="text-xs text-text-secondary truncate">{ws.repoPath}</div>
                  </div>

                  <div className="flex items-center gap-1">
                    {activeWorkspace?.id === ws.id && (
                      <Check size={14} className="text-primary-text mr-1" />
                    )}
                    <button
                      className="hidden group-hover:flex items-center justify-center w-7 h-7 rounded-md hover:bg-danger-muted text-text-muted hover:text-red-400 transition-colors"
                      onClick={(e) => {
                        e.stopPropagation()
                        setDeleteTarget(ws.id)
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
          className="flex items-center gap-2 px-4 py-2.5 w-full justify-center rounded-lg bg-primary hover:bg-primary-hover text-white text-sm font-medium transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary press-scale"
        >
          <Plus size={16} />
          <span>Add Workspace</span>
        </button>
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
  )
}
