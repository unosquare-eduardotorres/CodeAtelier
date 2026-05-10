import React, { useMemo, useState } from 'react'
import {
  Hammer,
  RefreshCw,
  ClipboardList,
  Lightbulb,
  FileCode,
  AlertCircle,
  CheckCircle2,
  Clock,
  ChevronDown,
  ChevronRight,
  Search,
  ArrowRight
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { remarkStripStrayBackticks } from './remark-plugins'
import type { StructuredPlan, PlanType, PlanRootCause, PlanPhase } from '../../../../shared/types'
import { MermaidDiagram } from '@renderer/components/common'

function shortenPath(filePath: string): string {
  const parts = filePath.split('/')
  return parts.length > 2 ? parts.slice(-2).join('/') : filePath
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

function riskColor(risk: 'low' | 'medium' | 'high'): string {
  if (risk === 'low') return 'text-success'
  if (risk === 'medium') return 'text-warning'
  return 'text-danger'
}

interface TaskPlanCardProps {
  summary: string
  mode: 'plan' | 'build'

  // Inline plan content (from ```plan block in generalist output)
  planContent?: string

  // Unified action callbacks
  onBuildNow?: () => void
  onSaveAsIdea?: () => void
  onRefine?: () => void
}

export default function TaskPlanCard({
  summary,
  mode,
  planContent,
  onBuildNow,
  onSaveAsIdea,
  onRefine
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

  // ── Defensive filters — guard against empty/blank entries that produce
  //    blank trailing rows in the rendered card. Each filtered array drives
  //    BOTH the section's visibility AND its iteration, so an empty result
  //    hides the header completely (no "header above zero items").
  const visibleFilesChanged = useMemo(
    () =>
      Array.isArray(structuredPlan?.filesChanged)
        ? structuredPlan.filesChanged.filter(
            (entry) => entry?.file?.trim() && entry?.change?.trim()
          )
        : [],
    [structuredPlan]
  )

  const visibleFiles = useMemo(
    () =>
      Array.isArray(structuredPlan?.files)
        ? structuredPlan.files.filter((f): f is string => typeof f === 'string' && f.trim() !== '')
        : [],
    [structuredPlan]
  )

  const visibleRisks = useMemo(() => {
    const risks = structuredPlan?.risks
    if (!Array.isArray(risks)) return []
    return risks.filter((r) => {
      const sev = typeof r === 'string' ? 'medium' : r?.severity
      return sev === 'high' || sev === 'critical'
    })
  }, [structuredPlan])

  const visibleDeferredItems = useMemo(
    () =>
      Array.isArray(structuredPlan?.deferredItems)
        ? structuredPlan.deferredItems.filter(
            (s): s is string => typeof s === 'string' && s.trim() !== ''
          )
        : [],
    [structuredPlan]
  )

  const visibleDiagrams = useMemo(
    () =>
      Array.isArray(structuredPlan?.diagrams)
        ? structuredPlan.diagrams.filter((d) => d?.mermaid?.trim())
        : [],
    [structuredPlan]
  )

  const visibleSections = useMemo(
    () =>
      Array.isArray(structuredPlan?.sections)
        ? structuredPlan.sections.filter((s) => s?.content?.trim())
        : [],
    [structuredPlan]
  )

  const visibleRootCauses = useMemo(
    () =>
      Array.isArray(structuredPlan?.rootCauses)
        ? structuredPlan.rootCauses.filter((rc) => rc?.title?.trim() && rc?.description?.trim())
        : [],
    [structuredPlan]
  )

  const visibleVerification = useMemo(
    () =>
      Array.isArray(structuredPlan?.verification)
        ? structuredPlan.verification.filter(
            (v): v is string => typeof v === 'string' && v.trim() !== ''
          )
        : [],
    [structuredPlan]
  )

  const visiblePhases = useMemo(
    () =>
      Array.isArray(structuredPlan?.phases)
        ? structuredPlan.phases.filter((p) => p?.title?.trim())
        : [],
    [structuredPlan]
  )

  const visibleDecisions = useMemo(
    () =>
      Array.isArray(structuredPlan?.decisions)
        ? structuredPlan.decisions.filter((d) => d?.what?.trim() && d?.why?.trim())
        : [],
    [structuredPlan]
  )

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

  // ── Section renderers (extracted for layout composition) ──

  // Title is already shown in the card header — only render the summary here
  const titleSection = structuredPlan?.summary ? (
    <div className="border-l-4 border-[var(--color-plan-card)] pl-4 bg-surface-overlay rounded-r">
      <p className="text-sm text-text-body leading-relaxed">{structuredPlan.summary}</p>
    </div>
  ) : null

  // Summary is now rendered inline with titleSection — this is kept as a no-op for backward compat
  const summarySection = false

  const problemAnalysisSection = structuredPlan?.problemSummary && (
    <div className="rounded border border-[var(--color-plan-card-border)] bg-surface-base/30 p-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-[var(--color-plan-card-text)] mb-2">
        <Search size={14} className="text-[var(--color-plan-card)]" />
        Problem Analysis
      </div>
      <div className="text-sm text-text-body prose prose-sm prose-invert max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkStripStrayBackticks]}>{structuredPlan.problemSummary}</ReactMarkdown>
      </div>
      {structuredPlan.rootCause && (
        <div className="mt-3 pt-3 border-t border-[var(--color-plan-card-border)]">
          <div className="text-xs font-semibold uppercase tracking-wide text-text-secondary mb-1">
            Root Cause
          </div>
          <div className="text-sm text-text-body prose prose-sm prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkStripStrayBackticks]}>{structuredPlan.rootCause}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  )

  const rootCausesSection = visibleRootCauses.length > 0 && (
    <RootCausesList rootCauses={visibleRootCauses} />
  )

  const currentStateSection = structuredPlan?.currentState && (
    <div className="pt-3 border-t border-border-subtle">
      <div className="flex items-center gap-2 text-sm font-semibold text-text-secondary mb-2">
        <ClipboardList size={14} className="text-text-secondary" />
        Current State
      </div>
      <div className="text-sm text-text-body prose prose-sm prose-invert max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkStripStrayBackticks]}>{structuredPlan.currentState}</ReactMarkdown>
      </div>
    </div>
  )

  const decisionsSection = visibleDecisions.length > 0 && (
    <div className="rounded border-l-3 border-[var(--color-plan-card-accent)] bg-surface-base/30 pl-4 pr-3 py-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-text-primary mb-3">
        <Lightbulb size={14} className="text-warning" />
        Key Decisions
      </div>
      <div className="space-y-2.5">
        {visibleDecisions.map((d, i) => (
          <div key={`decision-${i}`} className="flex items-start gap-2 text-sm">
            <ArrowRight size={12} className="text-warning mt-1 shrink-0" />
            <div>
              <span className="text-text-primary font-semibold">{d.what}</span>
              <span className="text-text-secondary"> — {d.why}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )

  const phasesSection = visiblePhases.length > 0 && (
    <PhasesList phases={visiblePhases} simple={isSimplePlan} />
  )

  const filesChangedSection = visibleFilesChanged.length > 0 && (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <FileCode size={14} className="text-[var(--color-plan-card)]" />
        Files Changed
      </div>
      <div className="prose prose-sm prose-invert max-w-none prose-table:border-collapse prose-th:border prose-th:border-border-subtle prose-th:bg-surface-raised prose-th:px-3 prose-th:py-1.5 prose-td:border prose-td:border-border-subtle prose-td:px-3 prose-td:py-1.5">
        <table>
          <thead>
            <tr>
              <th>File</th>
              <th>Change</th>
            </tr>
          </thead>
          <tbody>
            {visibleFilesChanged.map((entry, index) => (
              <tr key={`file-change-${index}`}>
                <td>
                  <span className="text-[var(--color-plan-card)] font-mono text-xs bg-[var(--color-plan-card-muted)] px-1.5 py-0.5 rounded">
                    {shortenPath(entry.file)}
                  </span>
                </td>
                <td>{entry.change}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )

  const filesInScopeSection = visibleFiles.length > 0 && visibleFilesChanged.length === 0 && (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <FileCode size={14} className="text-[var(--color-plan-card)]" />
        Files in Scope
      </div>
      <div className="flex flex-wrap gap-1.5">
        {visibleFiles.map((file, index) => (
          <span
            key={`scope-file-${index}`}
            className="text-[var(--color-plan-card)] font-mono text-xs bg-[var(--color-plan-card-muted)] px-1.5 py-0.5 rounded"
          >
            {shortenPath(file)}
          </span>
        ))}
      </div>
    </div>
  )

  const risksSection = visibleRisks.length > 0 && (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <AlertCircle size={14} className="text-danger" />
        Risks
      </div>
      <div className="space-y-2">
        {visibleRisks.map((riskItem, index) => {
          const risk = typeof riskItem === 'string' ? riskItem : riskItem.risk
          const severity = typeof riskItem === 'string' ? 'medium' : riskItem.severity
          const mitigation = typeof riskItem === 'string' ? undefined : riskItem.mitigation
          const severityClass =
            severity === 'critical'
              ? 'text-danger bg-danger-muted ring-1 ring-danger/50'
              : severity === 'high'
                ? 'text-danger bg-danger-muted'
                : severity === 'low'
                  ? 'text-success bg-success-muted'
                  : 'text-warning bg-warning-muted'
          return (
            <div
              key={`risk-${index}`}
              className="rounded border border-border-subtle bg-surface-base/40 p-3"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`px-2 py-0.5 rounded text-[10px] uppercase tracking-wide ${severityClass}`}
                >
                  {severity}
                </span>
                <p className="text-sm text-text-body">{risk}</p>
              </div>
              {mitigation && (
                <p className="mt-2 text-xs text-text-secondary">
                  <strong>Mitigation:</strong> {mitigation}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )

  const verificationSection = visibleVerification.length > 0 && (
    <div className="pt-3 border-t border-border-subtle">
      <div className="flex items-center gap-2 text-sm font-semibold text-[var(--color-plan-card-accent)] mb-3">
        <CheckCircle2 size={14} />
        Verification
      </div>
      <ol className="list-decimal pl-5 space-y-1.5 text-sm text-text-body">
        {visibleVerification.map((item, index) => (
          <li key={`verify-${index}`}>{item}</li>
        ))}
      </ol>
    </div>
  )

  const expectedOutcomeSection = structuredPlan &&
    'expectedOutcome' in structuredPlan &&
    typeof structuredPlan.expectedOutcome === 'string' &&
    structuredPlan.expectedOutcome.trim() && (
      <div className="pt-3 border-t border-border-subtle">
        <div className="flex items-center gap-2 text-sm font-semibold text-success mb-2">
          <CheckCircle2 size={14} />
          Expected Outcome
        </div>
        <div className="text-sm text-text-body">{structuredPlan.expectedOutcome}</div>
      </div>
    )

  const implementationOrderSection = !isSimplePlan &&
    structuredPlan?.implementationOrder &&
    structuredPlan.implementationOrder.length > 0 &&
    visiblePhases.length > 0 && (
      <div className="rounded border-l-3 border-info bg-surface-base/20 pl-4 pr-3 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-text-primary mb-3">
          <ArrowRight size={14} className="text-info" />
          Recommended Implementation Order
        </div>
        <div className="flex items-center gap-1.5 flex-wrap text-sm">
          {structuredPlan.implementationOrder.map((phaseId, i) => {
            const phase = visiblePhases.find((p) => p.id === phaseId)
            return (
              <span key={`order-${phaseId}`} className="flex items-center gap-1.5">
                {i > 0 && <ArrowRight size={12} className="text-text-secondary shrink-0" />}
                <span className="px-2 py-0.5 rounded bg-[var(--color-plan-card-muted)] text-[var(--color-plan-card)] text-xs font-mono">
                  {phase ? `Phase ${phaseId}` : `#${phaseId}`}
                </span>
              </span>
            )
          })}
        </div>
      </div>
    )

  const deferredItemsSection = visibleDeferredItems.length > 0 && (
    <details className="pt-3 border-t border-border-subtle group">
      <summary className="flex items-center gap-2 text-xs font-semibold text-text-muted cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={12}
          className="text-text-muted transition-transform group-open:rotate-90"
        />
        <Clock size={12} className="text-text-muted" />
        Deferred Items ({visibleDeferredItems.length})
      </summary>
      <ul className="list-disc pl-7 space-y-1 text-xs text-text-body mt-2">
        {visibleDeferredItems.map((item, index) => (
          <li key={`deferred-${index}`}>{item}</li>
        ))}
      </ul>
    </details>
  )

  const diagramsSection = visibleDiagrams.length > 0 && (
    <div className="space-y-3">
      {visibleDiagrams.map((diagram, index) => (
        <div
          key={`diagram-${index}`}
          className="rounded border border-border-subtle bg-surface-base p-3"
        >
          <div className="text-xs font-semibold uppercase tracking-wide text-text-secondary mb-2">
            {diagram.title}
          </div>
          <MermaidDiagram definition={diagram.mermaid} />
        </div>
      ))}
    </div>
  )

  const sectionsBlock = visibleSections.length > 0 && (
    <div className="space-y-3">
      {visibleSections.map((section, index) => (
        <div
          key={`${section.heading}-${index}`}
          className="rounded border border-mode-plan-border bg-mode-plan-muted overflow-hidden"
        >
          <div className="px-4 py-3">
            {section.icon && <span className="text-base mr-2">{section.icon}</span>}
            <span className="text-sm font-semibold text-mode-plan-text">{section.heading}</span>
          </div>
          <div className="px-4 pb-4 prose prose-sm prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkStripStrayBackticks]}>{section.content}</ReactMarkdown>
          </div>
          {section.mermaid && (
            <div className="px-4 pb-4">
              <div className="rounded border border-border-subtle bg-surface-base p-3">
                <MermaidDiagram definition={section.mermaid} />
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )

  // ── Type-driven section ordering ──
  // Bug/Investigation: Title → Summary → Problem Analysis → Root Causes → Files Changed → Diagrams → Verification → Deferred Items
  // Feature:           Title → Summary → Current State → Phases → Diagrams → Risks → Expected Outcome → Implementation Order → Deferred Items
  // Refactor/Audit:    Title → Summary → Current State → Phases → Files Changed → Diagrams → Risks → Implementation Order → Deferred Items
  // Default:           Title → Summary → [all sections in declaration order, skipping empty]

  function renderSectionsForType(): React.ReactNode {
    const planType = structuredPlan?.type

    if (planType === 'bug' || planType === 'investigation') {
      return (
        <>
          {titleSection}
          {summarySection}
          {problemAnalysisSection}
          {rootCausesSection}
          {decisionsSection}
          {filesChangedSection}
          {filesInScopeSection}
          {diagramsSection}
          {sectionsBlock}
          {verificationSection}
          {expectedOutcomeSection}
          {risksSection}
          {deferredItemsSection}
          {implementationOrderSection}
        </>
      )
    }

    if (planType === 'feature') {
      return (
        <>
          {titleSection}
          {summarySection}
          {currentStateSection}
          {decisionsSection}
          {phasesSection}
          {diagramsSection}
          {sectionsBlock}
          {risksSection}
          {expectedOutcomeSection}
          {verificationSection}
          {filesChangedSection}
          {filesInScopeSection}
          {deferredItemsSection}
          {implementationOrderSection}
        </>
      )
    }

    if (planType === 'refactor' || planType === 'audit') {
      return (
        <>
          {titleSection}
          {summarySection}
          {currentStateSection}
          {decisionsSection}
          {phasesSection}
          {filesChangedSection}
          {filesInScopeSection}
          {diagramsSection}
          {sectionsBlock}
          {risksSection}
          {verificationSection}
          {deferredItemsSection}
          {implementationOrderSection}
        </>
      )
    }

    // Default: all sections in declaration order
    return (
      <>
        {titleSection}
        {summarySection}
        {problemAnalysisSection}
        {rootCausesSection}
        {currentStateSection}
        {decisionsSection}
        {phasesSection}
        {filesChangedSection}
        {filesInScopeSection}
        {risksSection}
        {verificationSection}
        {expectedOutcomeSection}
        {diagramsSection}
        {sectionsBlock}
        {deferredItemsSection}
        {implementationOrderSection}
      </>
    )
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
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkStripStrayBackticks]}>{planContent!}</ReactMarkdown>
        </div>
      )}

      {/* ── Unified action buttons ── */}
      {!hasUserChosen && (onBuildNow || onSaveAsIdea || onRefine) && (
        <div className="sticky bottom-0 flex items-center gap-2 px-5 py-3 border-t border-border-subtle bg-surface-overlay/95 backdrop-blur-sm">
          {onBuildNow && (
            <button
              onClick={() => {
                setUserClicked(true)
                onBuildNow()
              }}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-mode-build hover:brightness-110 text-white rounded text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-mode-build/50 press-scale"
            >
              <Hammer size={14} />
              Build Now
            </button>
          )}
          {onSaveAsIdea && (
            <button
              onClick={() => {
                setUserClicked(true)
                onSaveAsIdea()
              }}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-surface-overlay hover:bg-surface-float text-text-body rounded text-sm font-medium transition-colors press-scale"
            >
              <Lightbulb size={14} />
              Save as Idea
            </button>
          )}
          {onRefine && (
            <button
              onClick={() => {
                setUserClicked(true)
                onRefine()
              }}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-surface-overlay hover:bg-surface-float text-text-body rounded text-sm font-medium transition-colors press-scale"
            >
              <RefreshCw size={14} />
              Refine Plan
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Sub-components ──

function RootCausesList({ rootCauses }: { rootCauses: PlanRootCause[] }): React.JSX.Element {
  return (
    <div className="space-y-3">
      {rootCauses.map((rc) => (
        <div
          key={`root-cause-${rc.id}`}
          className="rounded border-l-4 border-danger bg-surface-base/40 p-4"
        >
          <div className="text-sm font-semibold text-text-primary mb-1">
            Root Cause {rc.id} — {rc.title}
          </div>
          <div className="text-sm text-text-body prose prose-sm prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkStripStrayBackticks]}>{rc.description}</ReactMarkdown>
          </div>
          {rc.symptom && (
            <div className="mt-2 text-xs text-text-secondary">
              <span className="font-semibold text-warning">Symptom:</span> {rc.symptom}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function ComplexityIndicator({ score }: { score: number }): React.JSX.Element {
  // Compact 5-bar version — maps 1-10 score to 5 filled segments
  const filled = Math.ceil(score / 2)
  return (
    <div className="flex items-center gap-1" title={`Complexity: ${score}/10`}>
      <span className="text-xs text-text-secondary mr-0.5">{score}</span>
      <div className="flex gap-px">
        {Array.from({ length: 5 }, (_, i) => (
          <div
            key={i}
            className={`w-1 h-2.5 rounded-sm ${
              i < filled
                ? score <= 3
                  ? 'bg-success'
                  : score <= 6
                    ? 'bg-warning'
                    : 'bg-danger'
                : 'bg-surface-base/60'
            }`}
          />
        ))}
      </div>
    </div>
  )
}

function RiskDot({ risk }: { risk: 'low' | 'medium' | 'high' }): React.JSX.Element {
  const dotColor = risk === 'low' ? 'bg-success' : risk === 'medium' ? 'bg-warning' : 'bg-danger'
  return (
    <span className="flex items-center gap-1 text-xs">
      <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
      <span className={`capitalize ${riskColor(risk)}`}>{risk}</span>
    </span>
  )
}

function PhasesList({
  phases,
  simple = false
}: {
  phases: PlanPhase[]
  simple?: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  const toggle = (id: number): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Risk-colored left border per phase
  const riskBorderColor = (risk: 'low' | 'medium' | 'high'): string =>
    risk === 'low' ? 'border-l-success' : risk === 'medium' ? 'border-l-warning' : 'border-l-danger'

  // Shared phase content (description + files)
  const renderPhaseContent = (phase: PlanPhase): React.JSX.Element => (
    <div className="px-4 pb-4 border-t border-[var(--color-plan-card-phase-border)]">
      <div className="pt-3 text-sm text-text-body prose prose-sm prose-invert max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkStripStrayBackticks]}>
          {phase.description}
        </ReactMarkdown>
      </div>
      {phase.files && phase.files.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-1.5">
            Files
          </div>
          <div className="space-y-1">
            {phase.files.map((f, fi) => (
              <div key={`phase-file-${fi}`} className="flex items-baseline gap-2 text-xs py-0.5">
                <span className="text-[var(--color-plan-card)] font-mono shrink-0 bg-[var(--color-plan-card-muted)] px-1.5 py-0.5 rounded">
                  {shortenPath(f.file)}
                </span>
                <span className="text-text-secondary">{f.change}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )

  return (
    <div className="space-y-2">
      {/* Header — hidden in simple mode */}
      {!simple && (
        <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <ClipboardList size={14} className="text-[var(--color-plan-card-accent)]" />
          Implementation Phases
        </div>
      )}
      <div className="space-y-2">
        {phases.map((phase) => {
          const isOpen = simple || expanded.has(phase.id)
          return (
            <div
              key={`phase-${phase.id}`}
              className={`rounded border border-[var(--color-plan-card-phase-border)] ${riskBorderColor(phase.risk)} border-l-4 bg-[var(--color-plan-card-phase-bg)] overflow-hidden`}
            >
              {/* Title row — inline in simple mode, accordion button otherwise */}
              {simple ? (
                <div className="flex items-center gap-2 w-full px-4 py-3">
                  <span className="w-5 h-5 rounded bg-[var(--color-plan-card-muted)] text-[var(--color-plan-card)] text-xs flex items-center justify-center font-mono shrink-0">
                    {phase.id}
                  </span>
                  <span className="text-sm font-medium text-text-primary truncate flex-1">
                    {phase.title}
                  </span>
                  <div className="flex items-center gap-3 shrink-0 text-xs">
                    <ComplexityIndicator score={phase.complexity} />
                    {phase.fileCount != null && (
                      <span className="text-text-secondary">~{phase.fileCount} files</span>
                    )}
                    <RiskDot risk={phase.risk} />
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => toggle(phase.id)}
                  className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-[var(--color-plan-card-section-bg)] transition-colors"
                >
                  {isOpen ? (
                    <ChevronDown size={14} className="text-text-secondary shrink-0" />
                  ) : (
                    <ChevronRight size={14} className="text-text-secondary shrink-0" />
                  )}
                  <span className="w-5 h-5 rounded bg-[var(--color-plan-card-muted)] text-[var(--color-plan-card)] text-xs flex items-center justify-center font-mono shrink-0">
                    {phase.id}
                  </span>
                  <span className="text-sm font-medium text-text-primary truncate flex-1">
                    {phase.title}
                  </span>
                  {/* Right-aligned inline metadata */}
                  <div className="flex items-center gap-3 shrink-0 text-xs">
                    <ComplexityIndicator score={phase.complexity} />
                    {phase.fileCount != null && (
                      <span className="text-text-secondary">~{phase.fileCount} files</span>
                    )}
                    <RiskDot risk={phase.risk} />
                  </div>
                </button>
              )}
              {isOpen && renderPhaseContent(phase)}
            </div>
          )
        })}
      </div>
    </div>
  )
}
