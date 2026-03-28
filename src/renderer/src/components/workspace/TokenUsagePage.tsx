import { useState, useEffect } from 'react'
import { Zap, Activity, Clock, Users, DollarSign, ShieldCheck } from 'lucide-react'
import { useWorkspaceStore } from '@renderer/store'
import { Skeleton } from '@renderer/components/common'
import type { TokenSummary, AgentSessionRecord } from '../../../../shared/types'

interface CostSummary {
  totalCostCents: number
  totalTokens: number
  sessionCount: number
  byAgent: { agentType: string; costCents: number; tokens: number; sessions: number }[]
}

interface BudgetStatus {
  currentCostCents: number
  dailyBudgetCents: number
  sessionBudgetCents: number
  dailyPercentUsed: number
  dailyWarning: boolean
  dailyExceeded: boolean
}

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
  const [costSummary, setCostSummary] = useState<CostSummary | null>(null)
  const [budgetStatus, setBudgetStatus] = useState<BudgetStatus | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    if (!activeWorkspace) return

    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true)
    Promise.all([
      window.api.getWorkspaceTokenSummary({ workspaceId: activeWorkspace.id }),
      window.api.getRecentSessions({ workspaceId: activeWorkspace.id, limit: 50 }),
      window.api.getCostSummary({ workspaceId: activeWorkspace.id }),
      window.api.checkBudget({ workspaceId: activeWorkspace.id })
    ])
      .then(([sum, sess, cost, budget]) => {
        if (cancelled) return
        setSummary(sum)
        setSessions(sess)
        setCostSummary(cost)
        setBudgetStatus(budget)
      })
      .catch((err) => {
        console.error('Failed to load token data:', err)
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [activeWorkspace])

  if (!activeWorkspace) {
    return (
      <div className="flex items-center justify-center h-full text-text-secondary text-sm">
        Select a workspace to view token usage
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        {/* Skeleton stat cards */}
        <div className="grid grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-surface-overlay border border-border-subtle rounded-xl p-4">
              <Skeleton className="h-3 w-20 mb-3" />
              <Skeleton className="h-6 w-24 mb-2" />
              <Skeleton className="h-3 w-16" />
            </div>
          ))}
        </div>
        {/* Skeleton table rows */}
        <div className="bg-surface-overlay border border-border-subtle rounded-xl p-4 space-y-3">
          <Skeleton className="h-4 w-32 mb-4" />
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 flex-1" />
              <Skeleton className="h-3 w-16" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  const maxAgentTokens = summary?.byAgent[0]?.totalTokens ?? 1
  const mostActiveAgent = summary?.byAgent[0]?.agentType ?? 'N/A'

  // Color palette for per-agent bars
  const barColors = [
    'bg-primary',
    'bg-emerald-500',
    'bg-amber-500',
    'bg-purple-500',
    'bg-cyan-500',
    'bg-rose-500',
    'bg-blue-500',
    'bg-orange-500'
  ]

  // Build a cost lookup by agent type
  const agentCostMap = new Map((costSummary?.byAgent ?? []).map((a) => [a.agentType, a]))

  // Budget badge logic
  const budgetHasDailyLimit = (budgetStatus?.dailyBudgetCents ?? 0) > 0
  const budgetPct = budgetStatus?.dailyPercentUsed ?? 0
  const budgetBadge = budgetStatus?.dailyExceeded
    ? { bg: 'bg-red-500/15', text: 'text-red-400', label: 'Exceeded' }
    : budgetStatus?.dailyWarning
      ? { bg: 'bg-yellow-500/15', text: 'text-yellow-400', label: `${Math.round(budgetPct)}% used` }
      : { bg: 'bg-green-500/15', text: 'text-green-400', label: 'On track' }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      {/* Cost Summary Row */}
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div className="bg-surface-overlay border border-border-subtle rounded-xl p-4 shadow-sm">
          <div className="flex items-center gap-2 text-text-secondary text-xs uppercase tracking-wider mb-2">
            <DollarSign size={12} />
            Estimated Cost
          </div>
          <div className="text-2xl font-bold text-text-primary">
            ${((costSummary?.totalCostCents ?? 0) / 100).toFixed(2)}
          </div>
          <div className="text-xs text-text-secondary mt-1">Based on model pricing</div>
        </div>

        <div className="bg-surface-overlay border border-border-subtle rounded-xl p-4 shadow-sm">
          <div className="flex items-center gap-2 text-text-secondary text-xs uppercase tracking-wider mb-2">
            <ShieldCheck size={12} />
            Budget Status
          </div>
          {budgetHasDailyLimit ? (
            <>
              <div className="flex items-center gap-2">
                <span className="text-2xl font-bold text-text-primary">
                  ${((budgetStatus?.currentCostCents ?? 0) / 100).toFixed(2)}
                </span>
                <span className="text-sm text-text-secondary">
                  / ${((budgetStatus?.dailyBudgetCents ?? 0) / 100).toFixed(2)}
                </span>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${budgetBadge.bg} ${budgetBadge.text}`}
                >
                  {budgetBadge.label}
                </span>
              </div>
              <div className="w-full bg-surface-base rounded-full h-1.5 mt-2">
                <div
                  className={`h-1.5 rounded-full transition-all ${
                    budgetStatus?.dailyExceeded
                      ? 'bg-red-500'
                      : budgetStatus?.dailyWarning
                        ? 'bg-yellow-500'
                        : 'bg-green-500'
                  }`}
                  style={{ width: `${Math.min(budgetPct, 100)}%` }}
                />
              </div>
            </>
          ) : (
            <>
              <div className="text-2xl font-bold text-text-primary">No limit</div>
              <div className="text-xs text-text-secondary mt-1">
                Set a daily budget in Models settings
              </div>
            </>
          )}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="bg-surface-overlay border border-border-subtle rounded-xl p-4 shadow-sm">
          <div className="flex items-center gap-2 text-text-secondary text-xs uppercase tracking-wider mb-2">
            <Zap size={12} />
            Total Tokens
          </div>
          <div className="text-2xl font-bold text-text-primary">
            {formatTokens(summary?.totalTokens ?? 0)}
          </div>
          <div className="text-xs text-text-secondary mt-1">All-time for this workspace</div>
        </div>

        <div className="bg-surface-overlay border border-border-subtle rounded-xl p-4 shadow-sm">
          <div className="flex items-center gap-2 text-text-secondary text-xs uppercase tracking-wider mb-2">
            <Activity size={12} />
            Sessions
          </div>
          <div className="text-2xl font-bold text-text-primary">{summary?.sessionCount ?? 0}</div>
          <div className="text-xs text-text-secondary mt-1">Agent sessions recorded</div>
        </div>

        <div className="bg-surface-overlay border border-border-subtle rounded-xl p-4 shadow-sm">
          <div className="flex items-center gap-2 text-text-secondary text-xs uppercase tracking-wider mb-2">
            <Users size={12} />
            Most Active
          </div>
          <div className="text-2xl font-bold text-text-primary truncate">{mostActiveAgent}</div>
          <div className="text-xs text-text-secondary mt-1">Highest token consumption</div>
        </div>
      </div>

      {/* Per-Agent Breakdown */}
      {summary && summary.byAgent.length > 0 && (
        <div className="mb-8">
          <h3 className="text-xs text-text-secondary uppercase tracking-wider mb-3 font-medium">
            Per-Agent Breakdown
          </h3>
          <div className="bg-surface-overlay border border-border-subtle rounded-xl overflow-hidden shadow-sm">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border-subtle text-xs text-text-secondary uppercase tracking-wider">
                  <th className="text-left px-4 py-2.5 font-medium">Agent</th>
                  <th className="text-right px-4 py-2.5 font-medium">Tokens</th>
                  <th className="text-right px-4 py-2.5 font-medium">Sessions</th>
                  <th className="text-right px-4 py-2.5 font-medium">Avg/Session</th>
                  <th className="text-right px-4 py-2.5 font-medium">Est. Cost</th>
                  <th className="px-4 py-2.5 font-medium w-32">Usage</th>
                </tr>
              </thead>
              <tbody>
                {summary.byAgent.map((agent, idx) => {
                  const avg =
                    agent.sessionCount > 0 ? Math.round(agent.totalTokens / agent.sessionCount) : 0
                  const pct = maxAgentTokens > 0 ? (agent.totalTokens / maxAgentTokens) * 100 : 0
                  const barColor = barColors[idx % barColors.length]

                  return (
                    <tr
                      key={agent.agentType}
                      className="border-b border-border-subtle/50 last:border-b-0 hover:bg-surface-overlay/50"
                    >
                      <td className="px-4 py-2.5">
                        <span className="text-sm font-medium text-text-primary">
                          {agent.agentType}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <span className="text-sm text-text-body font-mono">
                          {formatTokens(agent.totalTokens)}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <span className="text-sm text-text-secondary">{agent.sessionCount}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <span className="text-sm text-text-secondary font-mono">
                          {formatTokens(avg)}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <span className="text-sm text-text-body font-mono">
                          ${((agentCostMap.get(agent.agentType)?.costCents ?? 0) / 100).toFixed(2)}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="w-full bg-surface-base rounded-full h-3">
                          <div
                            className={`${barColor} h-3 rounded-full transition-all`}
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
        <h3 className="text-xs text-text-secondary uppercase tracking-wider mb-3 font-medium">
          Recent Sessions
        </h3>
        {sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center bg-surface-overlay/30 rounded-xl border border-border-subtle">
            <Clock size={24} className="text-border-default mb-2" />
            <p className="text-sm text-text-secondary">No sessions recorded yet</p>
            <p className="text-xs text-text-muted mt-1">
              Token usage will appear here after agent sessions complete
            </p>
          </div>
        ) : (
          <div className="bg-surface-overlay border border-border-subtle rounded-xl overflow-hidden shadow-sm">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border-subtle text-xs text-text-secondary uppercase tracking-wider">
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
                      className="border-b border-border-subtle/50 last:border-b-0 hover:bg-surface-overlay/50"
                    >
                      <td className="px-4 py-2.5">
                        <span className="text-sm font-medium text-text-primary">
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
                        <span className="text-sm text-text-body font-mono">
                          {formatTokens(session.tokenUsage)}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <span className="text-sm text-text-secondary">
                          {formatDuration(session.startedAt, session.endedAt)}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <span className="text-sm text-text-muted">
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
