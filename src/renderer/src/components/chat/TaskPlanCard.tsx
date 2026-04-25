import { useMemo, useState } from 'react'
import {
  Hammer,
  RefreshCw,
  ClipboardList,
  Lightbulb,
  FileCode,
  AlertCircle,
  CheckCircle2,
  Clock
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { StructuredPlan } from '../../../../shared/types'
import { MermaidDiagram } from '@renderer/components/common'

function shortenPath(filePath: string): string {
  const parts = filePath.split('/')
  return parts.length > 2 ? parts.slice(-2).join('/') : filePath
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

  const [userClicked, setUserClicked] = useState(false)
  const hasUserChosen = userClicked

  // Header styling varies by content type
  const headerBg = isInlinePlan
    ? 'border-[var(--color-plan-card-border)] bg-[var(--color-plan-card-muted)]'
    : 'border-border-subtle bg-surface-raised'
  const headerIconBg = isInlinePlan ? 'bg-[rgba(14,165,233,0.2)]' : 'bg-primary-muted'
  const headerIconColor = isInlinePlan ? 'text-sky-400' : 'text-primary-text'
  const headerTitle = isInlinePlan ? 'Implementation Plan' : 'Task Plan'

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

      {/* ── Inline plan content (from ```plan block) ── */}
      {isInlinePlan && structuredPlan && (
        <div className="px-5 py-4 space-y-4">
          <div className="border-l-4 border-sky-500 pl-4">
            <h3 className="text-base font-bold text-[var(--color-plan-card-text)] flex items-center gap-2">
              <ClipboardList size={16} className="text-[var(--color-plan-card)]" />
              {structuredPlan.title}
            </h3>
          </div>

          {structuredPlan.summary && (
            <div className="text-sm text-text-body bg-[var(--color-plan-card-muted)] rounded-lg px-4 py-3 border border-[var(--color-plan-card-border)]">
              {structuredPlan.summary}
            </div>
          )}

          {/* Problem Summary + Decisions intentionally removed —
              see plan: redundant with summary + steps. */}

          {visibleFilesChanged.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                <FileCode size={14} className="text-sky-400" />
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
                          <span className="inline-flex items-center gap-1 text-sky-400 hover:text-sky-300 cursor-pointer font-mono text-xs bg-sky-400/10 px-1.5 py-0.5 rounded">
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
          )}

          {visibleFiles.length > 0 && visibleFilesChanged.length === 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                <FileCode size={14} className="text-sky-400" />
                Files in Scope
              </div>
              <div className="flex flex-wrap gap-1.5">
                {visibleFiles.map((file, index) => (
                  <span
                    key={`scope-file-${index}`}
                    className="inline-flex items-center gap-1 text-sky-400 hover:text-sky-300 cursor-pointer font-mono text-xs bg-sky-400/10 px-1.5 py-0.5 rounded"
                  >
                    <FileCode size={12} />
                    {shortenPath(file)}
                  </span>
                ))}
              </div>
            </div>
          )}

          {visibleRisks.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                <AlertCircle size={14} className="text-rose-400" />
                Risks
              </div>
              <div className="space-y-2">
                {visibleRisks.map((riskItem, index) => {
                  const risk = typeof riskItem === 'string' ? riskItem : riskItem.risk
                  const severity = typeof riskItem === 'string' ? 'medium' : riskItem.severity
                  const mitigation =
                    typeof riskItem === 'string' ? undefined : riskItem.mitigation
                  const severityClass =
                    severity === 'critical'
                      ? 'text-red-100 bg-red-700/40 ring-1 ring-red-500/50'
                      : severity === 'high'
                        ? 'text-red-300 bg-red-500/20'
                        : severity === 'low'
                          ? 'text-emerald-300 bg-emerald-500/20'
                          : 'text-amber-300 bg-amber-500/20'
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
          )}

          {'expectedOutcome' in structuredPlan &&
            typeof structuredPlan.expectedOutcome === 'string' &&
            structuredPlan.expectedOutcome.trim() && (
              <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-emerald-300 mb-2">
                  <CheckCircle2 size={14} />
                  Expected Outcome
                </div>
                <div className="text-sm text-text-body">{structuredPlan.expectedOutcome}</div>
              </div>
            )}

          {visibleDeferredItems.length > 0 && (
            <div className="rounded-lg border border-border-subtle bg-surface-base/40 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-text-primary mb-2">
                <Clock size={14} className="text-slate-300" />
                Deferred Items
              </div>
              <ul className="list-disc pl-5 space-y-1 text-sm text-text-body">
                {visibleDeferredItems.map((item, index) => (
                  <li key={`deferred-${index}`}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          {visibleDiagrams.length > 0 && (
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
          )}

          {/* Legacy sections for backward compatibility — only renders when
              there's at least one section with non-empty content. */}
          {visibleSections.length > 0 && (
            <div className="space-y-3">
              {visibleSections.map((section, index) => (
                <div
                  key={`${section.heading}-${index}`}
                  className="rounded-lg border border-mode-plan-border bg-mode-plan-muted overflow-hidden"
                >
                  <div className="px-4 py-3">
                    {section.icon && <span className="text-base mr-2">{section.icon}</span>}
                    <span className="text-sm font-semibold text-mode-plan-text">
                      {section.heading}
                    </span>
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
          )}
        </div>
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
