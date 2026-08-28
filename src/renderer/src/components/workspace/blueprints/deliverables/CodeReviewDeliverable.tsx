/**
 * CodeReviewDeliverable — renders the adversarial code-review phase output (M9.3).
 *
 * Shows the verdict banner, findings list (file/severity/summary/suggested
 * fix), fix-task linkage (R-tasks created from findings), and the full review
 * narrative when present.
 */

import { type JSX } from 'react'
import { CheckCircle2, AlertTriangle, Wrench, FileWarning } from 'lucide-react'
import type { BlueprintPhase, BlueprintTask } from '../../../../../../shared/blueprint-types'
import { PHASE_ICONS } from '../phase-icons'
import { DeliverableHeader, MetricTile, CappedMarkdownBlock } from './shared'
import { findArtifact } from './artifact-helpers'

// ── Types ──

interface CodeReviewFinding {
  file: string
  line?: number
  severity: 'critical' | 'high' | 'medium' | 'low'
  summary: string
  suggestedFix?: string
}

type CodeReviewVerdict = 'approve' | 'fix_required' | 'concerns_noted'

// ── Verdict banner ──

function verdictConfig(verdict: CodeReviewVerdict): {
  label: string
  icon: typeof CheckCircle2
  cls: string
} {
  switch (verdict) {
    case 'approve':
      return {
        label: 'Approved — diff is sound',
        icon: CheckCircle2,
        cls: 'border-success/20 bg-success/5 text-success'
      }
    case 'fix_required':
      return {
        label: 'Fix required — critical/high findings',
        icon: AlertTriangle,
        cls: 'border-warning/20 bg-warning/5 text-warning'
      }
    default:
      return {
        label: 'Concerns noted — recorded, not blocking',
        icon: FileWarning,
        cls: 'border-info/20 bg-info/5 text-info'
      }
  }
}

const SEVERITY_STYLE: Record<CodeReviewFinding['severity'], string> = {
  critical: 'text-danger bg-danger/10',
  high: 'text-warning bg-warning/10',
  medium: 'text-info bg-info/10',
  low: 'text-text-muted bg-surface-inset'
}

// ── Component ──

export function CodeReviewDeliverable({
  phase,
  duration,
  tasks
}: {
  phase: BlueprintPhase
  duration: number | null
  /** All blueprint tasks — used to link findings to their R-prefixed fix tasks. */
  tasks: BlueprintTask[]
}): JSX.Element {
  const config = PHASE_ICONS['code-review']
  const artifact = findArtifact(phase.artifactsJson, 'code-review')
  const json = artifact?.contentJson as
    | { findings?: CodeReviewFinding[]; verdict?: CodeReviewVerdict; note?: string }
    | undefined

  const findings = json?.findings ?? []
  const verdict = json?.verdict ?? 'concerns_noted'
  const vc = verdictConfig(verdict)

  const counts = {
    critical: findings.filter((f) => f.severity === 'critical').length,
    high: findings.filter((f) => f.severity === 'high').length,
    medium: findings.filter((f) => f.severity === 'medium').length,
    low: findings.filter((f) => f.severity === 'low').length
  }

  // Fix-task linkage: R-tasks created by the code-review fix round carry
  // "[code-review fix] <severity>: <summary>" in their description.
  const fixTasks = tasks.filter(
    (t) => t.taskId.startsWith('R') && t.description.includes('[code-review fix]')
  )

  if (!artifact) {
    return (
      <div>
        <DeliverableHeader config={config} summary="No review data found" duration={duration} />
        <p className="text-xs text-text-muted italic">
          The code-review artifact was not produced by this phase
          {phase.status === 'skipped' ? ' — the layer was off for this run.' : '.'}
        </p>
      </div>
    )
  }

  return (
    <div>
      <DeliverableHeader
        config={config}
        summary={`${findings.length} finding${findings.length === 1 ? '' : 's'}`}
        duration={duration}
      />

      {/* Verdict banner */}
      <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border mb-6 ${vc.cls}`}>
        <vc.icon size={16} className="flex-shrink-0" />
        <span className="text-sm font-medium">{vc.label}</span>
        {json?.note && <span className="text-xs opacity-70 ml-auto">{json.note}</span>}
      </div>

      {/* Severity metrics */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        <MetricTile label="Critical" value={String(counts.critical)} variant={counts.critical > 0 ? 'danger' : 'default'} />
        <MetricTile label="High" value={String(counts.high)} variant={counts.high > 0 ? 'warning' : 'default'} />
        <MetricTile label="Medium" value={String(counts.medium)} />
        <MetricTile label="Low" value={String(counts.low)} />
      </div>

      {/* Findings list */}
      {findings.length > 0 && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
            Findings ({findings.length})
          </h3>
          <div className="space-y-2">
            {findings.map((f, i) => (
              <div
                key={i}
                className="rounded-lg border border-border-subtle bg-surface-inset/30 px-3 py-2"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase ${SEVERITY_STYLE[f.severity] ?? SEVERITY_STYLE.low}`}
                  >
                    {f.severity}
                  </span>
                  <span className="text-xs font-mono text-text-secondary">
                    {f.file}
                    {f.line ? `:${f.line}` : ''}
                  </span>
                </div>
                <p className="text-sm text-text-secondary mt-1 leading-relaxed">{f.summary}</p>
                {f.suggestedFix && (
                  <p className="text-xs text-text-muted mt-1 leading-relaxed">
                    <span className="font-semibold">Suggested fix:</span> {f.suggestedFix}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Fix-task linkage */}
      {fixTasks.length > 0 && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
            <Wrench size={12} className="inline mr-1" />
            Fix Tasks ({fixTasks.length})
          </h3>
          <div className="space-y-1.5">
            {fixTasks.map((t) => (
              <div
                key={t.taskId}
                className="flex items-center gap-2 rounded-lg border border-border-subtle px-3 py-1.5"
              >
                <span className="text-xs font-mono text-text-muted">{t.taskId}</span>
                <span className="text-xs text-text-secondary flex-1 truncate" title={t.description}>
                  {t.description.split('\n')[0].replace('[code-review fix] ', '')}
                </span>
                <span className="text-[10px] text-text-muted uppercase">{t.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Full narrative */}
      {artifact.contentMd && (
        <CappedMarkdownBlock content={artifact.contentMd} label="Review Narrative" />
      )}
    </div>
  )
}
