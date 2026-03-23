import { useState, useEffect } from 'react'
import { Zap, Activity, Clock, Users } from 'lucide-react'
import { useWorkspaceStore } from '@renderer/store'
import type { TokenSummary, AgentSessionRecord } from '../../../../shared/types'

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return tokens.toString()
}

function formatDuration(startedAt: string, endedAt: string | null): string {
  if (!endedAt) return 'Running...'
  const start = new Date(startedAt).getTime()
  const end = new Date(endedAt).getTime()
  const diffMs = end - start

  if (diffMs < 1000) return '<1s'
  if (diffMs < 60_000) return `${Math.round(diffMs / 1000)}s`
  if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)}m`
  return `${(diffMs / 3_600_000).toFixed(1)}h`
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / 86_400_000)

  if (diffDays === 0) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  completed: { bg: 'bg-green-500/20', text: 'text-green-400', label: 'Completed' },
  failed: { bg: 'bg-red-500/20', text: 'text-red-400', label: 'Failed' },
  terminated: { bg: 'bg-yellow-500/20', text: 'text-yellow-400', label: 'Terminated' },
  running: { bg: 'bg-blue-500/20', text: 'text-blue-400', label: 'Running' }
}

export default function TokenUsagePage(): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const [summary, setSummary] = useState<TokenSummary | null>(null)
  const [sessions, setSessions] = useState<AgentSessionRecord[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    if (!activeWorkspace) return

    setIsLoading(true)
    Promise.all([
      window.api.getWorkspaceTokenSummary({ workspaceId: activeWorkspace.id }),
      window.api.getRecentSessions({ workspaceId: activeWorkspace.id, limit: 50 })
    ])
      .then(([sum, sess]) => {
        setSummary(sum)
        setSessions(sess)
      })
      .catch((err) => {
        console.error('Failed to load token data:', err)
      })
      .finally(() => {
        setIsLoading(false)
      })
  }, [activeWorkspace])

  if (!activeWorkspace) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        Select a workspace to view token usage
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        <Activity size={16} className="animate-spin mr-2" />
        Loading token data...
      </div>
    )
  }

  const maxAgentTokens = summary?.byAgent[0]?.totalTokens ?? 1
  const mostActiveAgent = summary?.byAgent[0]?.agentType ?? 'N/A'

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4">
          <div className="flex items-center gap-2 text-gray-500 text-xs uppercase tracking-wider mb-2">
            <Zap size={12} />
            Total Tokens
          </div>
          <div className="text-2xl font-bold text-gray-100">
            {formatTokens(summary?.totalTokens ?? 0)}
          </div>
          <div className="text-xs text-gray-500 mt-1">All-time for this workspace</div>
        </div>

        <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4">
          <div className="flex items-center gap-2 text-gray-500 text-xs uppercase tracking-wider mb-2">
            <Activity size={12} />
            Sessions
          </div>
          <div className="text-2xl font-bold text-gray-100">{summary?.sessionCount ?? 0}</div>
          <div className="text-xs text-gray-500 mt-1">Agent sessions recorded</div>
        </div>

        <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4">
          <div className="flex items-center gap-2 text-gray-500 text-xs uppercase tracking-wider mb-2">
            <Users size={12} />
            Most Active
          </div>
          <div className="text-2xl font-bold text-gray-100 truncate">{mostActiveAgent}</div>
          <div className="text-xs text-gray-500 mt-1">Highest token consumption</div>
        </div>
      </div>

      {/* Per-Agent Breakdown */}
      {summary && summary.byAgent.length > 0 && (
        <div className="mb-8">
          <h3 className="text-xs text-gray-500 uppercase tracking-wider mb-3 font-medium">
            Per-Agent Breakdown
          </h3>
          <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-700/50 text-xs text-gray-500 uppercase tracking-wider">
                  <th className="text-left px-4 py-2.5 font-medium">Agent</th>
                  <th className="text-right px-4 py-2.5 font-medium">Tokens</th>
                  <th className="text-right px-4 py-2.5 font-medium">Sessions</th>
                  <th className="text-right px-4 py-2.5 font-medium">Avg/Session</th>
                  <th className="px-4 py-2.5 font-medium w-32">Usage</th>
                </tr>
              </thead>
              <tbody>
                {summary.byAgent.map((agent) => {
                  const avg =
                    agent.sessionCount > 0 ? Math.round(agent.totalTokens / agent.sessionCount) : 0
                  const pct = maxAgentTokens > 0 ? (agent.totalTokens / maxAgentTokens) * 100 : 0

                  return (
                    <tr
                      key={agent.agentType}
                      className="border-b border-gray-700/30 last:border-b-0 hover:bg-gray-800/30"
                    >
                      <td className="px-4 py-2.5">
                        <span className="text-sm font-medium text-gray-200">{agent.agentType}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <span className="text-sm text-gray-300 font-mono">
                          {formatTokens(agent.totalTokens)}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <span className="text-sm text-gray-400">{agent.sessionCount}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <span className="text-sm text-gray-400 font-mono">{formatTokens(avg)}</span>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="w-full bg-gray-700/30 rounded-full h-2">
                          <div
                            className="bg-indigo-500 h-2 rounded-full transition-all"
                            style={{ width: `${Math.max(pct, 2)}%` }}
                          />
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recent Sessions */}
      <div>
        <h3 className="text-xs text-gray-500 uppercase tracking-wider mb-3 font-medium">
          Recent Sessions
        </h3>
        {sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center bg-gray-800/30 rounded-xl border border-gray-700/30">
            <Clock size={24} className="text-gray-700 mb-2" />
            <p className="text-sm text-gray-500">No sessions recorded yet</p>
            <p className="text-xs text-gray-600 mt-1">
              Token usage will appear here after agent sessions complete
            </p>
          </div>
        ) : (
          <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-700/50 text-xs text-gray-500 uppercase tracking-wider">
                  <th className="text-left px-4 py-2.5 font-medium">Agent</th>
                  <th className="text-left px-4 py-2.5 font-medium">Status</th>
                  <th className="text-right px-4 py-2.5 font-medium">Tokens</th>
                  <th className="text-right px-4 py-2.5 font-medium">Duration</th>
                  <th className="text-right px-4 py-2.5 font-medium">Started</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => {
                  const statusStyle = STATUS_STYLES[session.status] ?? STATUS_STYLES.running
                  return (
                    <tr
                      key={session.id}
                      className="border-b border-gray-700/30 last:border-b-0 hover:bg-gray-800/30"
                    >
                      <td className="px-4 py-2.5">
                        <span className="text-sm font-medium text-gray-200">
                          {session.agentType}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${statusStyle.bg} ${statusStyle.text}`}
                        >
                          {statusStyle.label}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <span className="text-sm text-gray-300 font-mono">
                          {formatTokens(session.tokenUsage)}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <span className="text-sm text-gray-400">
                          {formatDuration(session.startedAt, session.endedAt)}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <span className="text-sm text-gray-500">
                          {formatDate(session.startedAt)}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
