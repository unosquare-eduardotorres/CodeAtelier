import React, { useMemo, useState, type MutableRefObject } from 'react'
import { ClipboardList, ChevronRight } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { remarkStripStrayBackticks } from './remark-plugins'
import type { StructuredPlan, PlanType } from '../../../../shared/types'
import { BuildActionBar } from './task-plan'
import { usePlanMemos } from './task-plan/usePlanMemos'
import { buildSectionMap } from './task-plan/TaskPlanSections'
import type { SectionKey } from './task-plan/TaskPlanSections'

// ── Section sequence config — maps plan type to ordered section keys ──

const SECTION_SEQUENCES: Record<string, SectionKey[]> = {
  bug: [
    'title',
    'summary',
    'problemAnalysis',
    'rootCauses',
    'decisions',
    'filesChanged',
    'filesInScope',
    'diagrams',
    'sections',
    'verification',
    'expectedOutcome',
    'risks',
    'deferredItems',
    'implementationOrder'
  ],
  investigation: [
    'title',
    'summary',
    'problemAnalysis',
    'rootCauses',
    'decisions',
    'filesChanged',
    'filesInScope',
    'diagrams',
    'sections',
    'verification',
    'expectedOutcome',
    'risks',
    'deferredItems',
    'implementationOrder'
  ],
  feature: [
    'title',
    'summary',
    'currentState',
    'decisions',
    'phases',
    'diagrams',
    'sections',
    'risks',
    'expectedOutcome',
    'verification',
    'filesChanged',
    'filesInScope',
    'deferredItems',
    'implementationOrder'
  ],
  refactor: [
    'title',
    'summary',
    'currentState',
    'decisions',
    'phases',
    'filesChanged',
    'filesInScope',
    'diagrams',
    'sections',
    'risks',
    'verification',
    'deferredItems',
    'implementationOrder'
  ],
  audit: [
    'title',
    'summary',
    'currentState',
    'decisions',
    'phases',
    'filesChanged',
    'filesInScope',
    'diagrams',
    'sections',
    'risks',
    'verification',
    'deferredItems',
    'implementationOrder'
  ],
  default: [
    'title',
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
    'diagrams',
    'sections',
    'deferredItems',
    'implementationOrder'
  ]
}

// ── Plan type badge configuration ──

const PLAN_TYPE_CONFIG: Record<
  NonNullable<PlanType>,
  { emoji: string; label: string; badgeClass: string }
> = {
  bug: { emoji: '🐛', label: 'Bug Fix', badgeClass: 'bg-danger-muted text-danger' },
  feature: { emoji: '✨', label: 'Feature', badgeClass: 'bg-info-muted text-info' },
  refactor: { emoji: '♻️', label: 'Refactor', badgeClass: 'bg-warning-muted text-warning' },
  audit: { emoji: '📋', label: 'Audit', badgeClass: 'bg-primary-muted text-primary' },
  investigation: {
    emoji: '🔍',
    label: 'Investigation',
    badgeClass: 'bg-[var(--color-plan-card-phase-bg)] text-[var(--color-plan-card-accent)]'
  }
}

interface TaskPlanCardProps {
  summary: string
  mode: 'plan' | 'build' | 'danger'

  // Inline plan content (from ```plan block in agent output)
  planContent?: string

  // Unified action callbacks
  onBuildNow?: () => void
  onSaveAsIdea?: () => void
  onRefine?: () => void
  onCouncilReview?: () => void

  /** Persisted action from DB — initializes button visibility on mount */
  planActionTaken?: string
  /** Conversation ID for live phase status badges during build execution */
  conversationId?: string
  /** When true, this plan has been superseded by a newer plan in the conversation.
   *  Renders as a collapsed single-line card with click-to-expand. */
  isSuperseded?: boolean
  /** Shared ref for persisting expand state across virtualizer remounts.
   *  Lives in MessageList so the set survives unmount/remount cycles. */
  supersededExpandedIds?: MutableRefObject<Set<string>>
  /** Message ID used as key in supersededExpandedIds */
  messageId?: string
}

// ── Sub-components ──────────────────────────────────────────────────────────

function PlanHeader({
  isInlinePlan,
  structuredPlan,
  summary,
  mode
}: {
  isInlinePlan: boolean
  structuredPlan: StructuredPlan | null
  summary: string
  mode: 'plan' | 'build' | 'danger'
}): React.JSX.Element {
  const headerBg = isInlinePlan
    ? 'border-[var(--color-plan-card-border)] bg-[var(--color-plan-card-muted)]'
    : 'border-border-subtle bg-surface-raised'
  const headerIconBg = isInlinePlan ? 'bg-[var(--color-plan-card-muted)]' : 'bg-primary-muted'
  const headerIconColor = isInlinePlan ? 'text-[var(--color-plan-card)]' : 'text-primary-text'
  const headerTitle = isInlinePlan ? 'Implementation Plan' : 'Task Plan'
  const planTypeConfig = structuredPlan?.type ? PLAN_TYPE_CONFIG[structuredPlan.type] : null

  return (
    <div className={`flex items-center gap-3 px-5 py-4 border-b ${headerBg}`}>
      <div className={`w-8 h-8 rounded flex items-center justify-center ${headerIconBg}`}>
        <ClipboardList size={16} className={headerIconColor} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-text-primary">{headerTitle}</p>
        <p className="text-xs text-text-secondary truncate">{structuredPlan?.title ?? summary}</p>
      </div>
      <div className="flex items-center gap-1.5">
        {planTypeConfig && (
          <span className={`text-[10px] px-2 py-0.5 rounded ${planTypeConfig.badgeClass}`}>
            {planTypeConfig.emoji} {planTypeConfig.label}
          </span>
        )}
        <span
          className={`text-[10px] px-2 py-0.5 rounded ${
            mode === 'build'
              ? 'bg-mode-build-muted text-mode-build-text'
              : 'bg-mode-plan-muted text-mode-plan-text'
          }`}
        >
          {mode}
        </span>
      </div>
    </div>
  )
}

function PlanBody({
  isInlinePlan,
  structuredPlan,
  planContent,
  sectionMap
}: {
  isInlinePlan: boolean
  structuredPlan: StructuredPlan | null
  planContent: string | undefined
  sectionMap: Record<SectionKey, React.ReactNode>
}): React.JSX.Element | null {
  if (!isInlinePlan) return null

  if (structuredPlan) {
    const planType = structuredPlan.type ?? 'default'
    const sequence = SECTION_SEQUENCES[planType] ?? SECTION_SEQUENCES.default
    return (
      <div data-testid="task-plan-sections" className="px-5 py-4 space-y-4">
        {sequence.map((key) => (
          <React.Fragment key={key}>{sectionMap[key]}</React.Fragment>
        ))}
      </div>
    )
  }

  return (
    <div className="px-5 py-4 prose prose-sm prose-invert max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkStripStrayBackticks]}>
        {planContent!}
      </ReactMarkdown>
    </div>
  )
}

function PlanActionButtons({
  hasUserChosen,
  onBuildNow,
  onSaveAsIdea,
  onRefine,
  onCouncilReview,
  onUserClicked
}: {
  hasUserChosen: boolean
  onBuildNow?: () => void
  onSaveAsIdea?: () => void
  onRefine?: () => void
  onCouncilReview?: () => void
  onUserClicked: () => void
}): React.JSX.Element | null {
  if (hasUserChosen) return null
  if (!onBuildNow && !onSaveAsIdea && !onRefine && !onCouncilReview) return null

  return (
    <BuildActionBar
      onBuildNow={onBuildNow}
      onSaveAsIdea={onSaveAsIdea}
      onRefine={onRefine}
      onCouncilReview={onCouncilReview}
      onUserClicked={onUserClicked}
      savedToPlans
    />
  )
}

// ── Main component ──────────────────────────────────────────────────────────

export default function TaskPlanCard({
  summary,
  mode,
  planContent,
  onBuildNow,
  onSaveAsIdea,
  onRefine,
  onCouncilReview,
  planActionTaken,
  conversationId,
  isSuperseded,
  supersededExpandedIds,
  messageId
}: TaskPlanCardProps): React.JSX.Element {
  const isInlinePlan = !!planContent

  // Try to parse planContent as structured plan JSON
  const structuredPlan = useMemo<StructuredPlan | null>(() => {
    if (!planContent) return null
    try {
      const parsed = JSON.parse(planContent)
      if (parsed && typeof parsed === 'object' && typeof parsed.title === 'string') {
        return parsed as StructuredPlan
      }
      return null
    } catch {
      return null
    }
  }, [planContent])

  const {
    visibleFilesChanged,
    visibleFiles,
    visibleRisks,
    visibleDeferredItems,
    visibleDiagrams,
    visibleSections,
    visibleRootCauses,
    visibleVerification,
    visiblePhases,
    visibleDecisions
  } = usePlanMemos(structuredPlan)

  const isSimplePlan =
    visiblePhases.length > 0 &&
    visiblePhases.length <= 2 &&
    visiblePhases.every((p) => p.risk !== 'high' && p.complexity <= 5)

  const [userClicked, setUserClicked] = useState(!!planActionTaken)

  // Superseded expand state — read from shared ref (survives virtualizer remounts)
  // with a local useState to trigger re-renders.
  const [supersededExpanded, setSupersededExpandedLocal] = useState(
    () => !!(messageId && supersededExpandedIds?.current?.has(messageId))
  )
  const setSupersededExpanded = (expanded: boolean): void => {
    setSupersededExpandedLocal(expanded)
    if (messageId && supersededExpandedIds?.current) {
      if (expanded) {
        supersededExpandedIds.current.add(messageId)
      } else {
        supersededExpandedIds.current.delete(messageId)
      }
    }
  }

  // ── Superseded plan card — collapsed single-line with animated expand/collapse ──
  if (isSuperseded) {
    const planTitle = structuredPlan?.title ?? summary ?? 'Implementation Plan'
    const planTypeConfig = structuredPlan?.type ? PLAN_TYPE_CONFIG[structuredPlan.type] : null

    // When collapsed, skip building sectionMap entirely (perf)
    const expandedSectionMap = supersededExpanded
      ? buildSectionMap({
          structuredPlan,
          visibleFilesChanged,
          visibleFiles,
          visibleRisks,
          visibleDeferredItems,
          visibleDiagrams,
          visibleSections,
          visibleRootCauses,
          visibleVerification,
          visiblePhases,
          visibleDecisions,
          isSimplePlan,
          conversationId: undefined
        })
      : null

    return (
      <div
        data-testid={supersededExpanded ? 'task-plan-card' : 'task-plan-card-superseded'}
        className="my-3 rounded border border-border-subtle bg-surface-overlay/60 overflow-hidden"
      >
        {/* Always-visible summary row — click to toggle */}
        <button
          type="button"
          onClick={() => setSupersededExpanded(!supersededExpanded)}
          className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-raised/50 transition-colors group"
        >
          <span className="shrink-0 transition-transform duration-200" style={{ transform: supersededExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
            <ChevronRight size={14} className="text-text-muted" />
          </span>
          <div className="w-6 h-6 rounded flex items-center justify-center bg-surface-base">
            <ClipboardList size={12} className="text-text-muted" />
          </div>
          <span className="text-sm text-text-secondary truncate flex-1">{planTitle}</span>
          <div className="flex items-center gap-1.5">
            {planTypeConfig && (
              <span className={`text-[10px] px-2 py-0.5 rounded opacity-60 ${planTypeConfig.badgeClass}`}>
                {planTypeConfig.emoji} {planTypeConfig.label}
              </span>
            )}
            <span className="text-[10px] px-2 py-0.5 rounded bg-surface-base text-text-muted">
              superseded
            </span>
          </div>
        </button>

        {/* Expandable body — uses CSS grid-rows for smooth height transition */}
        <div
          className="grid transition-[grid-template-rows] duration-200 ease-in-out"
          style={{ gridTemplateRows: supersededExpanded ? '1fr' : '0fr' }}
        >
          <div className="overflow-hidden">
            {supersededExpanded && expandedSectionMap && (
              <>
                <PlanHeader
                  isInlinePlan={!!planContent}
                  structuredPlan={structuredPlan}
                  summary={summary}
                  mode={mode}
                />
                <PlanBody
                  isInlinePlan={!!planContent}
                  structuredPlan={structuredPlan}
                  planContent={planContent}
                  sectionMap={expandedSectionMap}
                />
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  const sectionMap = buildSectionMap({
    structuredPlan,
    visibleFilesChanged,
    visibleFiles,
    visibleRisks,
    visibleDeferredItems,
    visibleDiagrams,
    visibleSections,
    visibleRootCauses,
    visibleVerification,
    visiblePhases,
    visibleDecisions,
    isSimplePlan,
    // Superseded plans don't subscribe to live execution state —
    // only the latest plan card shows execution badges to avoid N×1 duplication.
    conversationId: isSuperseded ? undefined : conversationId
  })

  return (
    <div
      data-testid="task-plan-card"
      className={`my-3 rounded border ${isInlinePlan ? 'border-[var(--color-plan-card-border)]' : 'border-border-subtle'} bg-surface-overlay overflow-hidden`}
    >
      <PlanHeader
        isInlinePlan={isInlinePlan}
        structuredPlan={structuredPlan}
        summary={summary}
        mode={mode}
      />
      <PlanBody
        isInlinePlan={isInlinePlan}
        structuredPlan={structuredPlan}
        planContent={planContent}
        sectionMap={sectionMap}
      />
      {/* Superseded plans never show action buttons — only the latest plan is actionable */}
      {!isSuperseded && (
        <PlanActionButtons
          hasUserChosen={userClicked}
          onBuildNow={onBuildNow}
          onSaveAsIdea={onSaveAsIdea}
          onRefine={onRefine}
          onCouncilReview={onCouncilReview}
          onUserClicked={() => setUserClicked(true)}
        />
      )}
    </div>
  )
}
