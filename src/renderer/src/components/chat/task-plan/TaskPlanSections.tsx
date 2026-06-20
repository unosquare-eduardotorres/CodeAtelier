/**
 * TaskPlanSections — individual section renderers for the structured plan card.
 *
 * Extracted from TaskPlanCard to reduce its line count and make each section
 * independently readable. The parent passes in pre-filtered visible data from
 * usePlanMemos and the structured plan.
 */

import React from 'react'
import {
  ClipboardList,
  FileCode,
  AlertCircle,
  CheckCircle2,
  Clock,
  ChevronRight,
  Search,
  ArrowRight,
  Lightbulb
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { remarkStripStrayBackticks } from '../remark-plugins'
import type { StructuredPlan, PlanRootCause, PlanPhase } from '../../../../../shared/types'
import { MermaidDiagram } from '@renderer/components/common'
import { RootCausesList, PhasesList, SectionCard } from './PlanHelpers'

// ── Helpers ──

function shortenPath(filePath: string): string {
  const parts = filePath.split('/')
  return parts.length > 2 ? parts.slice(-2).join('/') : filePath
}

// ── Risk helpers ──

type RiskItem = string | { risk: string; severity: string; mitigation?: string }

const SEVERITY_CLASS: Record<string, string> = {
  critical: 'text-danger bg-danger-muted ring-1 ring-danger/50',
  high: 'text-danger bg-danger-muted',
  low: 'text-success bg-success-muted'
}

function getSeverityClass(severity: string): string {
  return SEVERITY_CLASS[severity] ?? 'text-warning bg-warning-muted'
}

function parseRiskItem(item: RiskItem): { risk: string; severity: string; mitigation?: string } {
  if (typeof item === 'string') return { risk: item, severity: 'medium' }
  return item
}

// ── Section builders ──

function buildRisksSection(visibleRisks: RiskItem[]): React.ReactNode {
  if (visibleRisks.length === 0) return false
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <AlertCircle size={14} className="text-danger" />
        Risks
      </div>
      <div className="space-y-2">
        {visibleRisks.map((riskItem, index) => {
          const { risk, severity, mitigation } = parseRiskItem(riskItem)
          return (
            <div
              key={`risk-${index}`}
              className="rounded border border-border-subtle bg-surface-base/40 p-3"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`px-2 py-0.5 rounded text-[10px] uppercase tracking-wide ${getSeverityClass(severity)}`}
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
}

function buildExpectedOutcomeSection(structuredPlan: StructuredPlan | null): React.ReactNode {
  if (
    !structuredPlan ||
    !('expectedOutcome' in structuredPlan) ||
    typeof structuredPlan.expectedOutcome !== 'string' ||
    !structuredPlan.expectedOutcome.trim()
  ) {
    return false
  }
  return (
    <SectionCard
      icon={CheckCircle2}
      iconColor="text-success"
      label="Expected Outcome"
      labelColor="text-success"
    >
      <div className="text-sm text-text-body">{structuredPlan.expectedOutcome}</div>
    </SectionCard>
  )
}

function buildImplementationOrderSection(
  structuredPlan: StructuredPlan | null,
  visiblePhases: PlanPhase[],
  isSimplePlan: boolean
): React.ReactNode {
  if (
    isSimplePlan ||
    !structuredPlan?.implementationOrder ||
    structuredPlan.implementationOrder.length === 0 ||
    visiblePhases.length === 0
  ) {
    return false
  }

  const isNaturalOrder =
    structuredPlan.implementationOrder.length === visiblePhases.length &&
    structuredPlan.implementationOrder.every((phaseId, i) => phaseId === visiblePhases[i].id)

  if (isNaturalOrder) return false

  return (
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
}

// ── Section key type ──

export type SectionKey =
  | 'title'
  | 'summary'
  | 'problemAnalysis'
  | 'rootCauses'
  | 'currentState'
  | 'decisions'
  | 'phases'
  | 'filesChanged'
  | 'filesInScope'
  | 'diagrams'
  | 'sections'
  | 'verification'
  | 'expectedOutcome'
  | 'risks'
  | 'deferredItems'
  | 'implementationOrder'

// ── Props ──

export interface TaskPlanSectionsProps {
  structuredPlan: StructuredPlan | null
  visibleFilesChanged: Array<{ file: string; change: string }>
  visibleFiles: string[]
  visibleRisks: Array<string | { risk: string; severity: string; mitigation?: string }>
  visibleDeferredItems: string[]
  visibleDiagrams: Array<{ title: string; mermaid: string }>
  visibleSections: Array<{ heading: string; content: string; icon?: string; mermaid?: string }>
  visibleRootCauses: PlanRootCause[]
  visibleVerification: string[]
  visiblePhases: PlanPhase[]
  visibleDecisions: Array<{ what: string; why: string }>
  isSimplePlan: boolean
}

/**
 * Build the section map for type-driven rendering in TaskPlanCard.
 *
 * Returns a Record<SectionKey, ReactNode> where each value is a rendered section
 * (or `false`/`null` if the section has no data to display).
 */
export function buildSectionMap(props: TaskPlanSectionsProps): Record<SectionKey, React.ReactNode> {
  const {
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
  } = props

  const titleSection = structuredPlan?.summary ? (
    <div className="border-l-4 border-[var(--color-plan-card)] pl-4 bg-surface-overlay rounded-r">
      <p className="text-sm text-text-body leading-relaxed">{structuredPlan.summary}</p>
    </div>
  ) : null

  const summarySection = false

  const problemAnalysisSection = structuredPlan?.problemSummary && (
    <div className="rounded border border-[var(--color-plan-card-border)] bg-surface-base/30 p-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-[var(--color-plan-card-text)] mb-2">
        <Search size={14} className="text-[var(--color-plan-card)]" />
        Problem Analysis
      </div>
      <div className="text-sm text-text-body prose prose-sm prose-invert max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkStripStrayBackticks]}>
          {structuredPlan.problemSummary}
        </ReactMarkdown>
      </div>
      {structuredPlan.rootCause && (
        <div className="mt-3 pt-3 border-t border-[var(--color-plan-card-border)]">
          <div className="text-xs font-semibold uppercase tracking-wide text-text-secondary mb-1">
            Root Cause
          </div>
          <div className="text-sm text-text-body prose prose-sm prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkStripStrayBackticks]}>
              {structuredPlan.rootCause}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  )

  const rootCausesSection = visibleRootCauses.length > 0 && (
    <RootCausesList rootCauses={visibleRootCauses} />
  )

  const currentStateSection = structuredPlan?.currentState && (
    <SectionCard icon={ClipboardList} iconColor="text-text-secondary" label="Current State">
      <div className="text-sm text-text-body prose prose-sm prose-invert max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkStripStrayBackticks]}>
          {structuredPlan.currentState}
        </ReactMarkdown>
      </div>
    </SectionCard>
  )

  const decisionsSection = visibleDecisions.length > 0 && (
    <SectionCard
      icon={Lightbulb}
      iconColor="text-warning"
      label="Key Decisions"
      labelColor="text-text-primary"
      className="rounded border-l-3 border-[var(--color-plan-card-accent)] bg-surface-base/30 pl-4 pr-3 py-3"
    >
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
    </SectionCard>
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

  const risksSection = buildRisksSection(visibleRisks)

  const verificationSection = visibleVerification.length > 0 && (
    <SectionCard
      icon={CheckCircle2}
      iconColor="text-[var(--color-plan-card-accent)]"
      label="Verification"
      labelColor="text-[var(--color-plan-card-accent)]"
    >
      <ol className="list-decimal pl-5 space-y-1.5 text-sm text-text-body">
        {visibleVerification.map((item, index) => (
          <li key={`verify-${index}`}>{item}</li>
        ))}
      </ol>
    </SectionCard>
  )

  const expectedOutcomeSection = buildExpectedOutcomeSection(structuredPlan)

  const implementationOrderSection = buildImplementationOrderSection(
    structuredPlan,
    visiblePhases,
    isSimplePlan
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
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkStripStrayBackticks]}>
              {section.content}
            </ReactMarkdown>
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

  return {
    title: titleSection,
    summary: summarySection,
    problemAnalysis: problemAnalysisSection,
    rootCauses: rootCausesSection,
    currentState: currentStateSection,
    decisions: decisionsSection,
    phases: phasesSection,
    filesChanged: filesChangedSection,
    filesInScope: filesInScopeSection,
    diagrams: diagramsSection,
    sections: sectionsBlock,
    verification: verificationSection,
    expectedOutcome: expectedOutcomeSection,
    risks: risksSection,
    deferredItems: deferredItemsSection,
    implementationOrder: implementationOrderSection
  }
}
