/**
 * PlanCard — renders a single plan from the Plan Hub registry.
 *
 * Shows source badge, title, metrics, status, and context-dependent action
 * buttons following the IdeaCard/HealthRunCard patterns.
 */

import type { PlanRecord } from '../../../../../shared/types'
import PlanCardActions from './PlanCardActions'
import {
  SOURCE_CONFIG,
  TYPE_CONFIG,
  STATUS_CONFIG,
  formatRelativeDate,
  buildMetrics
} from './plan-constants'

// ── Props ──

interface PlanCardProps {
  plan: PlanRecord
  onViewDetail: (plan: PlanRecord) => void
  onOpenInChat: (plan: PlanRecord) => void
  onStartGoal: (plan: PlanRecord) => void
  onCouncilReview: (plan: PlanRecord) => void
  onCopyPlan: (plan: PlanRecord) => void
  onArchive: (plan: PlanRecord) => void
  onRestore: (plan: PlanRecord) => void
  onDelete: (plan: PlanRecord) => void
  onOpenConversation: (conversationId: string) => void
}

// ── Component ──

export default function PlanCard({
  plan,
  onViewDetail,
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
    <div
      data-testid="plan-card"
      className="group bg-surface-overlay border border-border-subtle rounded-lg p-4 hover:border-border-default transition-colors shadow-sm cursor-pointer"
      onClick={() => onViewDetail(plan)}
    >
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
        <span
          title={
            plan.completedAt && (plan.status === 'completed' || plan.status === 'archived')
              ? plan.completedAt
              : plan.createdAt
          }
        >
          {plan.completedAt && (plan.status === 'completed' || plan.status === 'archived')
            ? `${plan.status === 'archived' ? 'Archived' : 'Completed'} ${formatRelativeDate(plan.completedAt)}`
            : formatRelativeDate(plan.createdAt)}
        </span>
      </div>

      {/* Status indicator */}
      <div className="flex items-center gap-1.5 ml-[26px] mb-3">
        <span className={`w-1.5 h-1.5 rounded-full ${status.dotColor}`} />
        <span className={`text-[11px] font-medium ${status.textColor}`}>{status.label}</span>
        {plan.status === 'handed_off' && plan.linkedConversationId && (
          <span className="text-[10px] text-text-muted">→ linked conversation</span>
        )}
      </div>

      {/* Action buttons — config-driven (stop click propagation so card onClick isn't triggered) */}
      <div onClick={(e) => e.stopPropagation()}>
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
    </div>
  )
}
