/**
 * PlanCard — renders a single plan from the Plan Hub registry.
 *
 * Shows source badge, title, metrics, status, and context-dependent action
 * buttons following the IdeaCard/HealthRunCard patterns.
 */

import type { PlanRecord, PlanSource, PlanStatus } from '../../../../../shared/types'
import PlanCardActions from './PlanCardActions'

// ── Source badge config ──

const SOURCE_CONFIG: Record<PlanSource, { emoji: string; label: string; color: string }> = {
  chat: { emoji: '💬', label: 'Chat', color: 'text-primary-text' },
  grill: { emoji: '🔥', label: 'Grill', color: 'text-accent' },
  audit: { emoji: '🔍', label: 'Audit', color: 'text-success' },
  council: { emoji: '🏛️', label: 'Council', color: 'text-indigo-400' },
  mpa: { emoji: '🎯', label: 'Goals', color: 'text-cyan-400' },
  blueprint: { emoji: '📘', label: 'Blueprint', color: 'text-info' }
}

// ── Plan type badge config ──

const TYPE_CONFIG: Record<string, { label: string; classes: string }> = {
  feature: { label: 'Feature', classes: 'bg-info-muted text-info' },
  refactor: { label: 'Refactor', classes: 'bg-warning-muted text-warning' },
  bug: { label: 'Bug Fix', classes: 'bg-danger-muted text-danger' },
  audit: { label: 'Audit', classes: 'bg-primary-muted text-primary-text' },
  investigation: { label: 'Investigation', classes: 'bg-surface-overlay text-text-secondary' }
}

// ── Status config ──

const STATUS_CONFIG: Record<PlanStatus, { label: string; dotColor: string; textColor: string }> = {
  saved: { label: 'Saved', dotColor: 'bg-info', textColor: 'text-info' },
  handed_off: { label: 'Handed off', dotColor: 'bg-warning', textColor: 'text-warning' },
  in_progress: {
    label: 'In Progress',
    dotColor: 'bg-success animate-pulse',
    textColor: 'text-success'
  },
  completed: { label: 'Completed', dotColor: 'bg-success', textColor: 'text-success' },
  archived: { label: 'Archived', dotColor: 'bg-text-muted', textColor: 'text-text-muted' }
}

// ── Props ──

interface PlanCardProps {
  plan: PlanRecord
  onOpenInChat: (plan: PlanRecord) => void
  onStartGoal: (plan: PlanRecord) => void
  onCouncilReview: (plan: PlanRecord) => void
  onCopyPlan: (plan: PlanRecord) => void
  onArchive: (plan: PlanRecord) => void
  onRestore: (plan: PlanRecord) => void
  onDelete: (plan: PlanRecord) => void
  onOpenConversation: (conversationId: string) => void
}

// ── Formatters ──

function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function buildMetrics(plan: PlanRecord): string {
  const parts: string[] = []
  if (plan.phaseCount > 0) parts.push(`${plan.phaseCount} phase${plan.phaseCount !== 1 ? 's' : ''}`)
  if (plan.riskCount > 0) parts.push(`${plan.riskCount} risk${plan.riskCount !== 1 ? 's' : ''}`)
  if (plan.fileCount > 0) parts.push(`${plan.fileCount} file${plan.fileCount !== 1 ? 's' : ''}`)
  return parts.join(' · ')
}

// ── Component ──

export default function PlanCard({
  plan,
  onOpenInChat,
  onStartGoal,
  onCouncilReview,
  onCopyPlan,
  onArchive,
  onRestore,
  onDelete,
  onOpenConversation
}: PlanCardProps): React.JSX.Element {
  const source = SOURCE_CONFIG[plan.source]
  const typeConfig = plan.planType ? TYPE_CONFIG[plan.planType] : null
  const status = STATUS_CONFIG[plan.status]
  const metrics = buildMetrics(plan)

  return (
    <div data-testid="plan-card" className="group bg-surface-overlay border border-border-subtle rounded-lg p-4 hover:border-border-default transition-colors shadow-sm">
      {/* Header: source badge + title + type badge */}
      <div className="flex items-start justify-between gap-3 mb-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-sm ${source.color}`} title={source.label}>
            {source.emoji}
          </span>
          <span className="text-sm font-medium text-text-primary truncate">{plan.title}</span>
        </div>
        {typeConfig && (
          <span
            className={`flex-shrink-0 px-2 py-0.5 text-[10px] font-semibold rounded-full ${typeConfig.classes}`}
          >
            {typeConfig.label}
          </span>
        )}
      </div>

      {/* Metadata row */}
      <div className="flex items-center gap-2 ml-[26px] text-[11px] text-text-muted mb-2">
        <span>{source.label}</span>
        {metrics && (
          <>
            <span>·</span>
            <span>{metrics}</span>
          </>
        )}
        <span>·</span>
        <span>{formatRelativeDate(plan.createdAt)}</span>
      </div>

      {/* Status indicator */}
      <div className="flex items-center gap-1.5 ml-[26px] mb-3">
        <span className={`w-1.5 h-1.5 rounded-full ${status.dotColor}`} />
        <span className={`text-[11px] font-medium ${status.textColor}`}>{status.label}</span>
        {plan.status === 'handed_off' && plan.linkedConversationId && (
          <span className="text-[10px] text-text-muted">→ linked conversation</span>
        )}
      </div>

      {/* Action buttons — config-driven */}
      <PlanCardActions
        status={plan.status}
        hasLinkedConversation={!!plan.linkedConversationId}
        handlers={{
          onOpenInChat: () => onOpenInChat(plan),
          onStartGoal: () => onStartGoal(plan),
          onCouncilReview: () => onCouncilReview(plan),
          onCopyPlan: () => onCopyPlan(plan),
          onArchive: () => onArchive(plan),
          onRestore: () => onRestore(plan),
          onDelete: () => onDelete(plan),
          onOpenConversation: () =>
            plan.linkedConversationId && onOpenConversation(plan.linkedConversationId)
        }}
      />
    </div>
  )
}
