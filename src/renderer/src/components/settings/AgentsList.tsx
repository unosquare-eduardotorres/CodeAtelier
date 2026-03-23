import { useState } from 'react'
import { ChevronRight, RefreshCw, Trash2, Loader2 } from 'lucide-react'
import { useSettingsStore } from '@renderer/store/settings.store'
import { ConfirmDialog } from '@renderer/components/common'
import { AGENT_META } from '../../../../shared/constants'
import type { DiscoveredAgent } from '../../../../shared/types'

interface AgentsListProps {
  workspacePath: string
}

export default function AgentsList({ workspacePath }: AgentsListProps): React.JSX.Element {
  const { agents, selectAgent, loadAgents } = useSettingsStore()
  const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set())
  const [deleteTarget, setDeleteTarget] = useState<DiscoveredAgent | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const handleSync = async (agent: DiscoveredAgent): Promise<void> => {
    const id = agent.filename
    setSyncingIds((prev) => new Set(prev).add(id))

    try {
      await window.api.syncAgentToWorkspace({
        workspacePath,
        filename: agent.filename
      })
      await loadAgents(workspacePath)
    } catch (error) {
      console.error('Failed to sync agent:', error)
    } finally {
      setSyncingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  const handleDeleteConfirm = async (): Promise<void> => {
    if (!deleteTarget) return
    setDeletingId(deleteTarget.filename)

    try {
      await window.api.deleteAgentFromWorkspace({
        workspacePath,
        filename: deleteTarget.filename
      })
      await loadAgents(workspacePath)
    } catch (error) {
      console.error('Failed to delete agent:', error)
    } finally {
      setDeleteTarget(null)
      setDeletingId(null)
    }
  }

  // Sort: deployed first, then by name
  const sortedAgents = [...agents].sort((a, b) => {
    if (a.isDeployed !== b.isDeployed) return a.isDeployed ? -1 : 1
    return a.parsed.name.localeCompare(b.parsed.name)
  })

  return (
    <>
      <div className="space-y-4">
        {/* Section header */}
        <div>
          <h3 className="text-sm font-semibold text-gray-200">Agents</h3>
          <p className="text-xs text-gray-500 mt-1">
            Manage specialist agents deployed to this workspace
          </p>
        </div>

        {/* Agents list */}
        {sortedAgents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-sm text-gray-500 mb-1">No agents found</p>
            <p className="text-xs text-gray-600">
              Use &ldquo;Activate Agents &amp; Skills&rdquo; to set up agents
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {sortedAgents.map((agent) => {
              const meta = AGENT_META[agent.parsed.name]
              const icon = meta?.icon ?? '🤖'
              const color = meta?.color ?? '#6366F1'
              const displayName = meta?.displayName ?? agent.parsed.name
              const isSyncing = syncingIds.has(agent.filename)
              const isDeleting = deletingId === agent.filename

              return (
                <div
                  key={agent.filename}
                  className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4 hover:border-gray-600/50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    {/* Icon */}
                    <div
                      className="flex items-center justify-center w-10 h-10 rounded-lg text-lg flex-shrink-0"
                      style={{ backgroundColor: `${color}20` }}
                    >
                      {icon}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-200">{displayName}</span>
                        <span
                          className={`px-1.5 py-0.5 text-[10px] rounded-full font-medium ${
                            agent.isDeployed
                              ? 'bg-green-500/10 text-green-400'
                              : 'bg-gray-600/30 text-gray-500'
                          }`}
                        >
                          {agent.isDeployed ? 'Deployed' : 'Not deployed'}
                        </span>
                      </div>

                      {agent.parsed.description && (
                        <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">
                          {agent.parsed.description}
                        </p>
                      )}

                      <div className="flex items-center gap-2 mt-1.5">
                        {agent.parsed.skills.length > 0 && (
                          <div className="flex items-center gap-1">
                            {agent.parsed.skills.map((skill) => (
                              <span
                                key={skill}
                                className="px-1.5 py-0.5 text-[10px] rounded-full bg-indigo-500/10 text-indigo-400 font-medium"
                              >
                                {skill}
                              </span>
                            ))}
                          </div>
                        )}
                        <span className="text-[10px] text-gray-600">
                          model: {agent.parsed.model}
                        </span>
                      </div>
                    </div>

                    {/* Actions — always visible */}
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {/* Sync button */}
                      <button
                        onClick={() => handleSync(agent)}
                        disabled={isSyncing}
                        className="p-1.5 rounded-md hover:bg-indigo-500/20 text-gray-400 hover:text-indigo-400 transition-colors disabled:opacity-50 disabled:cursor-wait"
                        aria-label={`Sync ${displayName}`}
                        title="Sync agent to workspace & CLAUDE.md"
                      >
                        {isSyncing ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <RefreshCw size={14} />
                        )}
                      </button>

                      {/* View/Edit button */}
                      <button
                        onClick={() => selectAgent(agent)}
                        className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition-colors"
                      >
                        View
                        <ChevronRight size={12} />
                      </button>

                      {/* Delete button */}
                      <button
                        onClick={() => setDeleteTarget(agent)}
                        disabled={isDeleting}
                        className="p-1.5 rounded-md hover:bg-red-500/20 text-gray-500 hover:text-red-400 transition-colors disabled:opacity-50"
                        aria-label={`Delete ${displayName}`}
                        title="Delete agent from workspace & CLAUDE.md"
                      >
                        {isDeleting ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Trash2 size={14} />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Delete confirmation */}
      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title="Delete Agent"
        message={`Remove "${deleteTarget?.parsed.name ?? ''}" from this workspace? This will delete the agent YAML from .claude/agents/ and remove references from CLAUDE.md.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  )
}
