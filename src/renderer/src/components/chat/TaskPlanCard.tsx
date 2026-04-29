import { useMemo, useState } from 'react'
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

// ── Complexity badge color ──

function complexityColor(score: number): string {
  if (score <= 3) return 'text-success bg-success-muted'
  if (score <= 6) return 'text-warning bg-warning-muted'
  return 'text-danger bg-danger-muted'
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

  const titleSection = structuredPlan && (
    <div className="border-l-4 border-[var(--color-plan-card)] pl-4">
      <h3 className="text-base font-bold text-[var(--color-plan-card-text)] flex items-center gap-2">
        <ClipboardList size={16} className="text-[var(--color-plan-card)]" />
        {structuredPlan.title}
      </h3>
    </div>
  )

  const summarySection = structuredPlan?.summary && (
    <div className="text-sm text-text-body bg-[var(--color-plan-card-muted)] rounded-lg px-4 py-3 border border-[var(--color-plan-card-border)]">
      {structuredPlan.summary}
    </div>
  )

  const problemAnalysisSection = structuredPlan?.problemSummary && (
    <div className="rounded-lg border border-[var(--color-plan-card-border)] bg-[var(--color-plan-card-section-bg)] p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-[var(--color-plan-card-text)] mb-2">
        <Search size={14} className="text-[var(--color-plan-card)]" />
        Problem Analysis
      </div>
      <div className="text-sm text-text-body prose prose-sm prose-invert max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{structuredPlan.problemSummary}</ReactMarkdown>
      </div>
      {structuredPlan.rootCause && (
        <div className="mt-3 pt-3 border-t border-[var(--color-plan-card-border)]">
          <div className="text-xs font-semibold uppercase tracking-wide text-text-secondary mb-1">
            Root Cause
          </div>
          <div className="text-sm text-text-body prose prose-sm prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{structuredPlan.rootCause}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  )

  const rootCausesSection = visibleRootCauses.length > 0 && (
    <RootCausesList rootCauses={visibleRootCauses} />
  )

  const currentStateSection = structuredPlan?.currentState && (
    <div className="rounded-lg border border-[var(--color-plan-card-border)] bg-[var(--color-plan-card-section-bg)] p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-[var(--color-plan-card-text)] mb-2">
        <ClipboardList size={14} className="text-[var(--color-plan-card)]" />
        Current State
      </div>
      <div className="text-sm text-text-body prose prose-sm prose-invert max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{structuredPlan.currentState}</ReactMarkdown>
      </div>
    </div>
  )

  const decisionsSection = visibleDecisions.length > 0 && (
    <div className="rounded-lg border border-border-subtle bg-surface-base/40 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-text-primary mb-3">
        <Lightbulb size={14} className="text-[var(--color-plan-card)]" />
        Key Decisions
      </div>
      <div className="space-y-2">
        {visibleDecisions.map((d, i) => (
          <div key={`decision-${i}`} className="flex items-start gap-2 text-sm">
            <ArrowRight size={12} className="text-[var(--color-plan-card)] mt-1 shrink-0" />
            <div>
              <span className="text-text-primary font-medium">{d.what}</span>
              <span className="text-text-secondary"> — {d.why}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )

  const phasesSection = visiblePhases.length > 0 && <PhasesList phases={visiblePhases} />

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
                  <span className="inline-flex items-center gap-1 text-[var(--color-plan-card)] hover:text-[var(--color-plan-card-text)] cursor-pointer font-mono text-xs bg-[var(--color-plan-card-muted)] px-1.5 py-0.5 rounded">
                    <FileCode size={12} />
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
            className="inline-flex items-center gap-1 text-[var(--color-plan-card)] hover:text-[var(--color-plan-card-text)] cursor-pointer font-mono text-xs bg-[var(--color-plan-card-muted)] px-1.5 py-0.5 rounded"
          >
            <FileCode size={12} />
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
              className="rounded-lg border border-border-subtle bg-surface-base/40 p-3"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide ${severityClass}`}
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
    <div className="rounded-lg bg-[var(--color-plan-card-phase-bg)] border border-[var(--color-plan-card-phase-border)] p-4">
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
      <div className="rounded-lg bg-success-muted border border-success/20 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-success mb-2">
          <CheckCircle2 size={14} />
          Expected Outcome
        </div>
        <div className="text-sm text-text-body">{structuredPlan.expectedOutcome}</div>
      </div>
    )

  const implementationOrderSection = structuredPlan?.implementationOrder &&
    structuredPlan.implementationOrder.length > 0 &&
    visiblePhases.length > 0 && (
      <div className="rounded-lg border border-border-subtle bg-surface-base/40 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-text-primary mb-3">
          <ArrowRight size={14} className="text-[var(--color-plan-card)]" />
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
    <div className="rounded-lg border border-border-subtle bg-surface-base/40 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-text-primary mb-2">
        <Clock size={14} className="text-text-secondary" />
        Deferred Items
      </div>
      <ul className="list-disc pl-5 space-y-1 text-sm text-text-body">
        {visibleDeferredItems.map((item, index) => (
          <li key={`deferred-${index}`}>{item}</li>
        ))}
      </ul>
    </div>
  )

  const diagramsSection = visibleDiagrams.length > 0 && (
    <div className="space-y-3">
      {visibleDiagrams.map((diagram, index) => (
        <div
          key={`diagram-${index}`}
          className="rounded-lg border border-border-subtle bg-surface-base p-3"
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
          className="rounded-lg border border-mode-plan-border bg-mode-plan-muted overflow-hidden"
        >
          <div className="px-4 py-3">
            {section.icon && <span className="text-base mr-2">{section.icon}</span>}
            <span className="text-sm font-semibold text-mode-plan-text">{section.heading}</span>
          </div>
          <div className="px-4 pb-4 prose prose-sm prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{section.content}</ReactMarkdown>
          </div>
          {section.mermaid && (
            <div className="px-4 pb-4">
              <div className="rounded-lg border border-border-subtle bg-surface-base p-3">
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
          {implementationOrderSection}
          {filesChangedSection}
          {filesInScopeSection}
          {deferredItemsSection}
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
          {implementationOrderSection}
          {deferredItemsSection}
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
        {implementationOrderSection}
        {diagramsSection}
        {sectionsBlock}
        {deferredItemsSection}
      </>
    )
  }

  return (
    <div
      data-testid="task-plan-card"
      className={`my-3 rounded-xl border ${isInlinePlan ? 'border-[var(--color-plan-card-border)]' : 'border-border-subtle'} bg-surface-overlay overflow-hidden`}
    >
      {/* Header */}
      <div className={`flex items-center gap-3 px-4 py-3 border-b ${headerBg}`}>
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${headerIconBg}`}>
          <ClipboardList size={16} className={headerIconColor} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-text-primary">{headerTitle}</p>
          <p className="text-xs text-text-secondary truncate">{summary}</p>
        </div>
        <div className="flex items-center gap-1.5">
          {planTypeConfig && (
            <span className={`text-[10px] px-2 py-0.5 rounded-full ${planTypeConfig.badgeClass}`}>
              {planTypeConfig.emoji} {planTypeConfig.label}
            </span>
          )}
          <span
            className={`text-[10px] px-2 py-0.5 rounded-full ${
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
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{planContent!}</ReactMarkdown>
        </div>
      )}

      {/* ── Unified action buttons ── */}
      {!hasUserChosen && (onBuildNow || onSaveAsIdea || onRefine) && (
        <div className="flex items-center gap-2 px-4 py-3 border-t border-border-subtle bg-surface-base/50">
          {onBuildNow && (
            <button
              onClick={() => {
                setUserClicked(true)
                onBuildNow()
              }}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-mode-build hover:brightness-110 text-white rounded-lg text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-mode-build/50 press-scale"
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
              className="flex items-center gap-1.5 px-4 py-1.5 bg-surface-overlay hover:bg-surface-float text-text-body rounded-lg text-sm font-medium transition-colors press-scale"
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
              className="flex items-center gap-1.5 px-4 py-1.5 bg-surface-overlay hover:bg-surface-float text-text-body rounded-lg text-sm font-medium transition-colors press-scale"
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
          className="rounded-lg border-l-4 border-danger bg-surface-base/40 p-4"
        >
          <div className="text-sm font-semibold text-text-primary mb-1">
            Root Cause {rc.id} — {rc.title}
          </div>
          <div className="text-sm text-text-body prose prose-sm prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{rc.description}</ReactMarkdown>
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

function PhasesList({ phases }: { phases: PlanPhase[] }): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  const toggle = (id: number): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <ClipboardList size={14} className="text-[var(--color-plan-card)]" />
        Implementation Phases
      </div>
      <div className="space-y-2">
        {phases.map((phase) => {
          const isOpen = expanded.has(phase.id)
          return (
            <div
              key={`phase-${phase.id}`}
              className="rounded-lg border border-[var(--color-plan-card-phase-border)] bg-[var(--color-plan-card-phase-bg)] overflow-hidden"
            >
              <button
                type="button"
                onClick={() => toggle(phase.id)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[var(--color-plan-card-section-bg)] transition-colors"
              >
                {isOpen ? (
                  <ChevronDown size={14} className="text-text-secondary shrink-0" />
                ) : (
                  <ChevronRight size={14} className="text-text-secondary shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-text-primary">
                    Phase {phase.id}: {phase.title}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-full font-mono ${complexityColor(phase.complexity)}`}
                  >
                    {phase.complexity}/10
                  </span>
                  {phase.fileCount != null && (
                    <span className="text-[10px] text-text-secondary">
                      ~{phase.fileCount} files
                    </span>
                  )}
                  <span className={`text-[10px] capitalize ${riskColor(phase.risk)}`}>
                    {phase.risk}
                  </span>
                </div>
              </button>
              {isOpen && (
                <div className="px-4 pb-4 border-t border-[var(--color-plan-card-phase-border)]">
                  <div className="pt-3 text-sm text-text-body prose prose-sm prose-invert max-w-none">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{phase.description}</ReactMarkdown>
                  </div>
                  {phase.files && phase.files.length > 0 && (
                    <div className="mt-3 space-y-1">
                      <div className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
                        Files
                      </div>
                      {phase.files.map((f, fi) => (
                        <div key={`phase-file-${fi}`} className="flex items-start gap-2 text-xs">
                          <span className="inline-flex items-center gap-1 text-[var(--color-plan-card)] font-mono bg-[var(--color-plan-card-muted)] px-1.5 py-0.5 rounded shrink-0">
                            <FileCode size={10} />
                            {shortenPath(f.file)}
                          </span>
                          <span className="text-text-secondary">— {f.change}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
