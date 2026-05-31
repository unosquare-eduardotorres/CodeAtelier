import React, { useMemo, useState } from 'react'
import { ClipboardList } from 'lucide-react'
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
    'title', 'summary', 'problemAnalysis', 'rootCauses', 'decisions',
    'filesChanged', 'filesInScope', 'diagrams', 'sections', 'verification',
    'expectedOutcome', 'risks', 'deferredItems', 'implementationOrder'
  ],
  investigation: [
    'title', 'summary', 'problemAnalysis', 'rootCauses', 'decisions',
    'filesChanged', 'filesInScope', 'diagrams', 'sections', 'verification',
    'expectedOutcome', 'risks', 'deferredItems', 'implementationOrder'
  ],
  feature: [
    'title', 'summary', 'currentState', 'decisions', 'phases', 'diagrams',
    'sections', 'risks', 'expectedOutcome', 'verification', 'filesChanged',
    'filesInScope', 'deferredItems', 'implementationOrder'
  ],
  refactor: [
    'title', 'summary', 'currentState', 'decisions', 'phases', 'filesChanged',
    'filesInScope', 'diagrams', 'sections', 'risks', 'verification',
    'deferredItems', 'implementationOrder'
  ],
  audit: [
    'title', 'summary', 'currentState', 'decisions', 'phases', 'filesChanged',
    'filesInScope', 'diagrams', 'sections', 'risks', 'verification',
    'deferredItems', 'implementationOrder'
  ],
  default: [
    'title', 'summary', 'problemAnalysis', 'rootCauses', 'currentState',
    'decisions', 'phases', 'filesChanged', 'filesInScope', 'risks',
    'verification', 'expectedOutcome', 'diagrams', 'sections',
    'deferredItems', 'implementationOrder'
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

  // Inline plan content (from ```plan block in generalist output)
  planContent?: string

  // Unified action callbacks
  onBuildNow?: () => void
  onSaveAsIdea?: () => void
  onRefine?: () => void
  onCouncilReview?: () => void
}

export default function TaskPlanCard({
  summary,
  mode,
  planContent,
  onBuildNow,
  onSaveAsIdea,
  onRefine,
  onCouncilReview
}: TaskPlanCardProps): React.JSX.Element {
  // ── Content type detection ──
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

  // ── Defensive filters (extracted hook) ──
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

  // Simple plan: ≤2 low-risk, low-complexity phases → flat layout, no accordion
  const isSimplePlan =
    visiblePhases.length > 0 &&
    visiblePhases.length <= 2 &&
    visiblePhases.every((p) => p.risk !== 'high' && p.complexity <= 5)

  const [userClicked, setUserClicked] = useState(false)
  const hasUserChosen = userClicked

  // Header styling varies by content type
  const headerBg = isInlinePlan
    ? 'border-[var(--color-plan-card-border)] bg-[var(--color-plan-card-muted)]'
    : 'border-border-subtle bg-surface-raised'
  const headerIconBg = isInlinePlan ? 'bg-[var(--color-plan-card-muted)]' : 'bg-primary-muted'
  const headerIconColor = isInlinePlan ? 'text-[var(--color-plan-card)]' : 'text-primary-text'
  const headerTitle = isInlinePlan ? 'Implementation Plan' : 'Task Plan'

  // Plan type badge
  const planTypeConfig = structuredPlan?.type ? PLAN_TYPE_CONFIG[structuredPlan.type] : null

  // ── Section renderers (extracted to TaskPlanSections) ──
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
    isSimplePlan
  })

  function renderSectionsForType(): React.ReactNode {
    const planType = structuredPlan?.type ?? 'default'
    const sequence = SECTION_SEQUENCES[planType] ?? SECTION_SEQUENCES.default
    return <>{sequence.map((key) => <React.Fragment key={key}>{sectionMap[key]}</React.Fragment>)}</>
  }

  return (
    <div
      data-testid="task-plan-card"
      className={`my-3 rounded border ${isInlinePlan ? 'border-[var(--color-plan-card-border)]' : 'border-border-subtle'} bg-surface-overlay overflow-hidden`}
    >
      {/* Header */}
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

      {/* ── Inline plan content (from ```plan block) ── */}
      {isInlinePlan && structuredPlan && (
        <div className="px-5 py-4 space-y-4">{renderSectionsForType()}</div>
      )}
      {isInlinePlan && !structuredPlan && (
        <div className="px-5 py-4 prose prose-sm prose-invert max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkStripStrayBackticks]}>
            {planContent!}
          </ReactMarkdown>
        </div>
      )}

      {/* ── Unified action buttons ── */}
      {!hasUserChosen && (onBuildNow || onSaveAsIdea || onRefine || onCouncilReview) && (
        <BuildActionBar
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
