import { Bot, RefreshCw, Trash2, Loader2, Power, PowerOff } from 'lucide-react'
import { useSpecialistStore } from '@renderer/store'
import { getAgentMeta } from '@renderer/utils/agentMeta'
import type { DiscoveredAgent } from '../../../../shared/types'

interface AgentListPanelProps {
  agents: DiscoveredAgent[]
  selectedAgent: DiscoveredAgent | null
  syncingIds: Set<string>
  deletingId: string | null
  togglingId: string | null
  onSelect: (agent: DiscoveredAgent) => void
  onSync: (agent: DiscoveredAgent) => void
  onActivateToggle: (agent: DiscoveredAgent) => void
  onDelete: (agent: DiscoveredAgent) => void
}

export default function AgentListPanel({
  agents,
  selectedAgent,
  syncingIds,
  deletingId,
  togglingId,
  onSelect,
  onSync,
  onActivateToggle,
  onDelete
}: AgentListPanelProps): React.JSX.Element {
  const { specialists } = useSpecialistStore()

  return (
    <div className="w-[280px] flex-shrink-0 border-r border-border-subtle overflow-y-auto">
      <div className="p-3">
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">
          Agents ({agents.length})
        </h3>
        <div className="space-y-1">
          {agents.map((agent) => {
            const meta = getAgentMeta(agent.parsed.name, specialists)
            const icon = meta?.icon ?? '🤖'
            const displayName = meta?.displayName ?? agent.parsed.name
            const isSelected = selectedAgent?.filename === agent.filename
            const isSyncing = syncingIds.has(agent.filename)
            const isDeleting = deletingId === agent.filename
            const isToggling = togglingId === agent.filename

            return (
              <div
                key={agent.filename}
                onClick={() => onSelect(agent)}
                className={`group flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                  isSelected
                    ? 'bg-primary-muted border border-primary/20'
                    : 'hover:bg-surface-overlay border border-transparent'
                }`}
              >
                <span className="text-base flex-shrink-0">{icon}</span>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium text-text-primary truncate">
                      {displayName}
                    </span>
                    <span
                      className={`w-2 h-2 rounded-full flex-shrink-0 ${
                        agent.isActive ? 'bg-success' : 'bg-surface-overlay'
                      }`}
                      title={agent.isActive ? 'Active' : 'Inactive'}
                    />
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span
                      className={`text-xs ${
                        agent.isDeployed ? 'text-success' : 'text-text-muted'
                      }`}
                    >
                      {agent.isDeployed ? 'Deployed' : 'Not deployed'}
                    </span>
                  </div>
                </div>

                {/* Inline actions */}
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onSync(agent)
                    }}
                    disabled={isSyncing}
                    className="p-1 rounded hover:bg-primary-muted text-text-muted hover:text-primary-text transition-colors disabled:opacity-50"
                    title="Sync agent to workspace"
                  >
                    {isSyncing ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <RefreshCw size={12} />
                    )}
                  </button>

                  {agent.isDeployed && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onActivateToggle(agent)
                      }}
                      disabled={isToggling}
                      className={`p-1 rounded transition-colors disabled:opacity-50 ${
                        agent.isActive
                          ? 'hover:bg-warning-muted text-success hover:text-mode-build-text'
                          : 'hover:bg-success-muted text-text-muted hover:text-success'
                      }`}
                      title={agent.isActive ? 'Deactivate' : 'Activate'}
                    >
                      {isToggling ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : agent.isActive ? (
                        <PowerOff size={12} />
                      ) : (
                        <Power size={12} />
                      )}
                    </button>
                  )}

                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onDelete(agent)
                    }}
                    disabled={isDeleting}
                    className="p-1 rounded hover:bg-danger-muted text-text-muted hover:text-danger transition-colors disabled:opacity-50"
                    title="Delete agent from workspace"
                  >
                    {isDeleting ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Trash2 size={12} />
                    )}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
