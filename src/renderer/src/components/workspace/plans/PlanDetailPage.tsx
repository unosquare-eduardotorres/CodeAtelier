/**
 * PlanDetailPage — full-page detail view for a plan from the Plan Hub.
 *
 * Renders the plan's structured content (summary, phases, risks, files,
 * diagrams, etc.), a status timeline, revision links, and action buttons.
 * Read-only — actions (status change, handoff, copy) are exposed via buttons.
 */

import { useEffect, useMemo } from 'react'
import {
  ArrowLeft,
  MessageSquare,
  Target,
  Scale,
  ExternalLink,
  History,
  GitBranch
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  StructuredPlan
} from '../../../../../shared/types'
import { usePlanStore } from '@renderer/store/plan.store'
import { usePlanActions } from './usePlanActions'
import { useWorkspaceStore } from '@renderer/store'
import {
  SOURCE_CONFIG,
  TYPE_CONFIG,
  STATUS_CONFIG,
  formatRelativeDate,
  buildMetrics
} from './plan-constants'
import PlanStatusTimeline from './PlanStatusTimeline'
import PlanCardActions from './PlanCardActions'
import { buildSectionMap, type SectionKey } from '../../chat/task-plan/TaskPlanSections'

// ── Helpers ──

/** Safely filter an optional array from structured plan data. */
function filterPlanArray<T>(arr: T[] | undefined, predicate?: (item: T) => boolean): T[] {
  if (!Array.isArray(arr)) return []
  return predicate ? arr.filter(predicate) : arr
}

/** Build section map props from a StructuredPlan — showing ALL data (no severity filter). */
function buildDetailSectionProps(plan: StructuredPlan) {
  return {
    structuredPlan: plan,
    visibleFilesChanged: filterPlanArray(
      plan.filesChanged,
      (e) => !!e?.file?.trim() && !!e?.change?.trim()
    ),
    visibleFiles: filterPlanArray(
      plan.files,
      (f): f is string => typeof f === 'string' && f.trim() !== ''
    ),
    // Show ALL risks, not just high/critical (unlike chat card)
    visibleRisks: filterPlanArray(plan.risks, (r) => !!r?.risk?.trim()),
    visibleDeferredItems: filterPlanArray(
      plan.deferredItems,
      (s): s is string => typeof s === 'string' && s.trim() !== ''
    ),
    visibleDiagrams: filterPlanArray(plan.diagrams, (d) => !!d?.mermaid?.trim()),
    visibleSections: filterPlanArray(plan.sections, (s) => !!s?.content?.trim()),
    visibleRootCauses: filterPlanArray(
      plan.rootCauses,
      (rc) => !!rc?.title?.trim() && !!rc?.description?.trim()
    ),
    visibleVerification: filterPlanArray(
      plan.verification,
      (v): v is string => typeof v === 'string' && v.trim() !== ''
    ),
    visiblePhases: filterPlanArray(plan.phases, (p) => !!p?.title?.trim()),
    visibleDecisions: filterPlanArray(plan.decisions, (d) => !!d?.what?.trim() && !!d?.why?.trim()),
    isSimplePlan: !plan.phases?.length
  }
}

/** Section display order for the detail page. */
const SECTION_ORDER: SectionKey[] = [
  'summary',
  'problemAnalysis',
  'rootCauses',
  'currentState',
  'decisions',
  'phases',
  'filesChanged',
  'filesInScope',
  'risks',
  'verification',
  'expectedOutcome',
  'implementationOrder',
  'diagrams',
  'sections',
  'deferredItems'
]

// ── Props ──

interface PlanDetailPageProps {
  onBack: () => void
  onNavigateToChat: () => void
  onNavigateToGoals?: () => void
  onNavigateToCouncil?: () => void
}

// ── Component ──

export default function PlanDetailPage({
  onBack,
  onNavigateToChat,
  onNavigateToGoals,
  onNavigateToCouncil
}: PlanDetailPageProps): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const { selectedPlan, statusHistory, isLoadingDetail, selectPlan, selectedPlanId } =
    usePlanStore()

  const workspaceId = activeWorkspace?.id

  const {
    handleOpenInChat,
    handleStartGoal,
    handleCouncilReview,
    handleCopyPlan,
    handleArchive,
    handleRestore,
    handleDelete,
    handleOpenConversation
  } = usePlanActions(workspaceId, {
    onNavigateToChat,
    onNavigateToGoals,
    onNavigateToCouncil
  })

  // Re-fetch plan data on mount
  useEffect(() => {
    if (selectedPlanId) {
      selectPlan(selectedPlanId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Mount-only — selectPlan is already called when the user clicks a card

  // Build section map from the structured plan
  const sectionMap = useMemo(() => {
    if (!selectedPlan?.structuredPlan) return null
    const props = buildDetailSectionProps(selectedPlan.structuredPlan)
    return buildSectionMap(props)
  }, [selectedPlan?.structuredPlan])

  // ── Loading state ──
  if (isLoadingDetail || !selectedPlan) {
    return (
      <div className="p-6 space-y-4">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary transition-colors mb-4"
        >
          <ArrowLeft size={14} />
          Back to Plans
        </button>
        <div className="space-y-3">
          <div className="h-8 w-2/3 rounded bg-surface-overlay animate-pulse" />
          <div className="h-4 w-1/3 rounded bg-surface-overlay animate-pulse" />
          <div className="h-32 rounded-lg bg-surface-overlay animate-pulse" />
          <div className="h-24 rounded-lg bg-surface-overlay animate-pulse" />
        </div>
      </div>
    )
  }

  const plan = selectedPlan
  const source = SOURCE_CONFIG[plan.source]
  const typeConfig = plan.planType ? TYPE_CONFIG[plan.planType] : null
  const status = STATUS_CONFIG[plan.status]
  const metrics = buildMetrics(plan)

  return (
    <div data-testid="plan-detail-page" className="flex flex-col h-full">
      {/* ── Sticky Header ── */}
      <div className="sticky top-0 z-10 bg-surface-primary border-b border-border-subtle px-6 py-4">
        {/* Top row: back + actions */}
        <div className="flex items-center justify-between mb-2">
          <button
            onClick={onBack}
            data-testid="plan-detail-back"
            className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary transition-colors"
          >
            <ArrowLeft size={14} />
            Back to Plans
          </button>
          <div className="flex items-center gap-2">
            <PlanCardActions
              status={plan.status}
              hasLinkedConversation={!!plan.linkedConversationId}
              handlers={{
                onOpenInChat: () => handleOpenInChat(plan),
                onStartGoal: () => handleStartGoal(plan),
                onCouncilReview: () => handleCouncilReview(plan),
                onCopyPlan: () => handleCopyPlan(plan),
                onArchive: () => handleArchive(plan),
                onRestore: () => handleRestore(plan),
                onDelete: () => {
                  handleDelete(plan)
                  onBack()
                },
                onOpenConversation: () =>
                  plan.linkedConversationId &&
                  handleOpenConversation(plan.linkedConversationId)
              }}
            />
          </div>
        </div>

        {/* Title row */}
        <div className="flex items-start gap-2">
          <span className={`text-base ${source.color}`} title={source.label}>
            {source.emoji}
          </span>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-text-primary leading-tight">
              {plan.title}
            </h2>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {/* Source label */}
              <span className="text-[11px] text-text-muted">{source.label}</span>

              {/* Type badge */}
              {typeConfig && (
                <span
                  className={`px-2 py-0.5 text-[10px] font-semibold rounded-full ${typeConfig.classes}`}
                >
                  {typeConfig.label}
                </span>
              )}

              {/* Metrics */}
              {metrics && (
                <>
                  <span className="text-[11px] text-text-muted">·</span>
                  <span className="text-[11px] text-text-muted">{metrics}</span>
                </>
              )}

              {/* Status */}
              <span className="text-[11px] text-text-muted">·</span>
              <div className="flex items-center gap-1">
                <span className={`w-1.5 h-1.5 rounded-full ${status.dotColor}`} />
                <span className={`text-[11px] font-medium ${status.textColor}`}>
                  {status.label}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Scrollable Content ── */}
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
        {/* Revision Banner */}
        {plan.previousPlanId && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-info-muted border border-info/20">
            <GitBranch size={14} className="text-info flex-shrink-0" />
            <span className="text-xs text-info">
              Revision — supersedes a previous version of this plan
            </span>
          </div>
        )}

        {/* ── Summary ── */}
        {plan.summary && (
          <section>
            <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-2">
              Summary
            </h3>
            <div className="text-sm text-text-primary leading-relaxed prose prose-sm prose-invert max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan.summary}</ReactMarkdown>
            </div>
          </section>
        )}

        {/* ── Status Timeline ── */}
        {statusHistory.length > 0 && (
          <section>
            <h3 className="flex items-center gap-1.5 text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">
              <History size={12} />
              Status Timeline
            </h3>
            <PlanStatusTimeline history={statusHistory} />
          </section>
        )}

        {/* ── Structured Plan Sections ── */}
        {sectionMap &&
          SECTION_ORDER.map((key) => {
            const node = sectionMap[key]
            if (!node) return null
            return (
              <section key={key} data-section={key}>
                {node}
              </section>
            )
          })}

        {/* ── Requirement Document ── */}
        {plan.requirementDocument && (
          <section>
            <details className="group">
              <summary className="cursor-pointer text-xs font-semibold text-text-secondary uppercase tracking-wider mb-2 list-none flex items-center gap-1.5">
                <span className="transition-transform group-open:rotate-90">▸</span>
                Requirement Document
              </summary>
              <div className="mt-3 prose prose-sm prose-invert max-w-none text-sm text-text-primary border-l-2 border-border-subtle pl-4">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {plan.requirementDocument}
                </ReactMarkdown>
              </div>
            </details>
          </section>
        )}

        {/* ── Linked Resources ── */}
        {(plan.linkedConversationId ||
          plan.linkedCouncilSessionId ||
          plan.linkedMpaRunId) && (
          <section>
            <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-2">
              Linked Resources
            </h3>
            <div className="space-y-2">
              {plan.linkedConversationId && (
                <button
                  onClick={() => handleOpenConversation(plan.linkedConversationId!)}
                  className="flex items-center gap-2 text-xs text-primary-text hover:text-primary-text/80 transition-colors"
                >
                  <MessageSquare size={12} />
                  <span>Linked conversation</span>
                  <ExternalLink size={10} className="text-text-muted" />
                </button>
              )}
              {plan.linkedMpaRunId && (
                <div className="flex items-center gap-2 text-xs text-text-muted">
                  <Target size={12} />
                  <span>Goal run: {plan.linkedMpaRunId}</span>
                </div>
              )}
              {plan.linkedCouncilSessionId && (
                <div className="flex items-center gap-2 text-xs text-text-muted">
                  <Scale size={12} />
                  <span>Council session: {plan.linkedCouncilSessionId}</span>
                </div>
              )}
            </div>
          </section>
        )}

        {/* ── Footer metadata ── */}
        <div className="pt-4 border-t border-border-subtle text-[11px] text-text-muted">
          <span title={plan.createdAt}>Created {formatRelativeDate(plan.createdAt)}</span>
          <span className="mx-2">·</span>
          <span title={plan.updatedAt}>Updated {formatRelativeDate(plan.updatedAt)}</span>
          {plan.completedAt && (plan.status === 'completed' || plan.status === 'archived') && (
            <>
              <span className="mx-2">·</span>
              <span title={plan.completedAt}>
                {plan.status === 'archived' ? 'Archived' : 'Completed'} {formatRelativeDate(plan.completedAt)}
              </span>
            </>
          )}
          <span className="mx-2">·</span>
          <span className="font-mono text-[10px]">{plan.id.slice(0, 8)}</span>
        </div>
      </div>
    </div>
  )
}
