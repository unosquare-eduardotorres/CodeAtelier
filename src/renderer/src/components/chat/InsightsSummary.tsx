import { MessageSquare, FileText, Clock, Coins, Zap } from 'lucide-react'

interface ConversationInsights {
  messageCount: { user: number; assistant: number }
  tokenSummary: { inputTokens: number; outputTokens: number }
  costCents: number
  durationMs: number
}

interface InsightsSummaryProps {
  insights: ConversationInsights | null
  loading?: boolean
  /** Number of tracked file changes — fetched separately by caller */
  filesChanged?: number
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

function formatCost(cents: number): string {
  if (cents === 0) return '$0'
  if (cents < 1) return `<$0.01`
  return `$${(cents / 100).toFixed(2)}`
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '—'
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes < 1) return '<1 min'
  if (totalMinutes < 60) return `${totalMinutes} min`
  const hours = Math.floor(totalMinutes / 60)
  const mins = totalMinutes % 60
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
}

function StatPill({
  icon: Icon,
  value,
  label
}: {
  icon: typeof MessageSquare
  value: string
  label: string
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-0.5 bg-surface-base rounded-lg px-3 py-2 min-w-[4.5rem]">
      <Icon size={14} className="text-text-secondary" />
      <span className="text-sm font-semibold text-text-primary">{value}</span>
      <span className="text-[10px] text-text-secondary uppercase tracking-wide">{label}</span>
    </div>
  )
}

export default function InsightsSummary({
  insights,
  loading,
  filesChanged
}: InsightsSummaryProps): React.JSX.Element | null {
  if (loading) {
    return (
      <div
        data-testid="insights-loading"
        className="mb-4 p-3 bg-surface-base rounded-lg border border-border-subtle animate-pulse"
      >
        <div className="flex items-center gap-2 mb-2">
          <div className="w-4 h-4 bg-surface-overlay rounded" />
          <div className="w-24 h-4 bg-surface-overlay rounded" />
        </div>
        <div className="flex gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="w-[4.5rem] h-14 bg-surface-overlay rounded-lg" />
          ))}
        </div>
      </div>
    )
  }

  if (!insights) return null

  const totalTokens = insights.tokenSummary.inputTokens + insights.tokenSummary.outputTokens

  return (
    <div
      data-testid="insights-summary"
      className="mb-4 p-3 bg-surface-base rounded-lg border border-border-subtle"
    >
      <div className="flex items-center gap-2 mb-2">
        <Zap size={14} className="text-primary-text" />
        <span className="text-xs font-medium text-text-secondary uppercase tracking-wide">
          Session Insights
        </span>
      </div>
      <div className="flex gap-2 flex-wrap">
        <StatPill icon={MessageSquare} value={String(insights.messageCount.user)} label="turns" />
        <StatPill icon={FileText} value={formatTokens(totalTokens)} label="tokens" />
        {filesChanged !== undefined && (
          <StatPill icon={FileText} value={String(filesChanged)} label="files" />
        )}
        <StatPill icon={Coins} value={formatCost(insights.costCents)} label="cost" />
        <StatPill icon={Clock} value={formatDuration(insights.durationMs)} label="duration" />
      </div>
    </div>
  )
}

export type { ConversationInsights }
