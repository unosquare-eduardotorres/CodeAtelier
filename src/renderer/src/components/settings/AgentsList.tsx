import { useState } from 'react'
import { ChevronRight, Loader2 } from 'lucide-react'
import { useSettingsStore } from '@renderer/store/settings.store'
import { AGENT_META } from '../../../../shared/constants'
import type { DiscoveredAgent } from '../../../../shared/types'

interface AgentsListProps {
  workspacePath: string
}

export default function AgentsList({ workspacePath }: AgentsListProps): React.JSX.Element {
  const { agents, selectAgent, loadAgents } = useSettingsStore()
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set())

  const handleToggleDeploy = async (agent: DiscoveredAgent): Promise<void> => {
    const id = agent.filename
    setTogglingIds((prev) => new Set(prev).add(id))

    try {
      if (agent.isDeployed) {
        // Undeploy: remove from workspace
        await window.api.writeWorkspaceFile({
          filePath: `__undeploy_agent__:${workspacePath}:${agent.filename}`,
          content: ''
        })
      } else {
        // Deploy: copy to workspace (we use the writeFile endpoint with a special marker,
        // or we just read the master and write to workspace)
        const masterContent = await window.api.readWorkspaceFile({
          filePath: agent.filePath
        }) as string
        const targetPath = `${workspacePath}/.claude/agents/${agent.filename}`
        await window.api.writeWorkspaceFile({
          filePath: targetPath,
          content: masterContent
        })
      }
      // Refresh
      await loadAgents(workspacePath)
    } catch (error) {
      console.error('Failed to toggle agent deployment:', error)
    } finally {
      setTogglingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  // Sort: deployed first, then by name
  const sortedAgents = [...agents].sort((a, b) => {
    if (a.isDeployed !== b.isDeployed) return a.isDeployed ? -1 : 1
    return a.parsed.name.localeCompare(b.parsed.name)
  })

  return (
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
            const isToggling = togglingIds.has(agent.filename)

            return (
              <div
                key={agent.filename}
                className="group bg-gray-800/50 border border-gray-700/50 rounded-xl p-4 hover:border-gray-600/50 transition-colors"
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
                              className="px-1.5 py-0.5 text-[10px] rounded bg-indigo-500/10 text-indigo-400"
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

                  {/* Actions */}
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {/* Deploy toggle */}
                    <button
                      onClick={() => handleToggleDeploy(agent)}
                      disabled={isToggling}
                      className={`relative w-10 h-5 rounded-full transition-colors ${
                        isToggling
                          ? 'bg-gray-600 cursor-wait'
                          : agent.isDeployed
                            ? 'bg-indigo-600 hover:bg-indigo-500'
                            : 'bg-gray-600 hover:bg-gray-500'
                      }`}
                      aria-label={agent.isDeployed ? 'Undeploy agent' : 'Deploy agent'}
                      title={agent.isDeployed ? 'Undeploy from workspace' : 'Deploy to workspace'}
                    >
                      {isToggling ? (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <Loader2 size={12} className="text-white animate-spin" />
                        </div>
                      ) : (
                        <span
                          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
                            agent.isDeployed ? 'translate-x-5' : 'translate-x-0.5'
                          }`}
                        />
                      )}
                    </button>

                    {/* Edit button */}
                    <button
                      onClick={() => selectAgent(agent)}
                      className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition-colors opacity-0 group-hover:opacity-100"
                    >
                      Edit
                      <ChevronRight size={12} />
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
