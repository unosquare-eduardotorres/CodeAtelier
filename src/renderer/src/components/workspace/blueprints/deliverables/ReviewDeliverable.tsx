/**
 * ReviewDeliverable — renders cross-artifact review analysis.
 *
 * Shows recommendation banner, findings severity chart, coverage stats,
 * and full review narrative.
 */

import { type JSX } from 'react'
import { CheckCircle2, AlertTriangle, XCircle } from 'lucide-react'
import type { BlueprintPhase } from '../../../../../../shared/blueprint-types'
import { PHASE_ICONS } from '../phase-icons'
import { DeliverableHeader, MetricTile, DiscoveriesSection, CappedMarkdownBlock } from './shared'
import { findArtifact, extractDiscoveries } from './artifact-helpers'

// ── Helpers ──

function getRecommendationDisplay(recommendation: string): {
  label: string
  icon: typeof CheckCircle2
  bgClass: string
  textClass: string
} {
  switch (recommendation) {
    case 'approve':
    case 'proceed':
      return {
        label: 'Approved — Proceed to Build',
        icon: CheckCircle2,
        bgClass: 'bg-success/10 border-success/20',
        textClass: 'text-success'
      }
    case 'fix_critical':
      return {
        label: 'Fix Critical Issues Before Proceeding',
        icon: AlertTriangle,
        bgClass: 'bg-warning/10 border-warning/20',
        textClass: 'text-warning'
      }
    case 're_specify':
    case 'reject':
      return {
        label: 'Re-specify — Significant Issues Found',
        icon: XCircle,
        bgClass: 'bg-danger/10 border-danger/20',
        textClass: 'text-danger'
      }
    default:
      return {
        label: recommendation,
        icon: CheckCircle2,
        bgClass: 'bg-surface-overlay border-border-subtle',
        textClass: 'text-text-primary'
      }
  }
}

// ── Findings Bar ──

function FindingsBar({
  severity,
  count,
  maxCount
}: {
  severity: string
  count: number
  maxCount: number
}): JSX.Element {
  const barWidth = maxCount > 0 ? Math.max(8, (count / maxCount) * 100) : 0
  const colorMap: Record<string, string> = {
    critical: 'bg-danger',
    high: 'bg-warning',
    medium: 'bg-info',
    low: 'bg-text-muted'
  }
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs font-medium text-text-secondary w-16 text-right uppercase">
        {severity}
      </span>
      <div className="flex-1 h-5 flex items-center">
        {count > 0 && (
          <div
            className={`h-4 rounded-sm ${colorMap[severity] ?? 'bg-text-muted'} transition-all`}
            style={{ width: `${barWidth}%` }}
          />
        )}
      </div>
      <span className="text-xs font-mono text-text-muted tabular-nums w-8">{count}</span>
    </div>
  )
}

// ── Component ──

export function ReviewDeliverable({
  phase,
  duration
}: {
  phase: BlueprintPhase
  duration: number | null
}): JSX.Element {
  const config = PHASE_ICONS.review
  const review = findArtifact(phase.artifactsJson, 'review', 'blueprint-review')
  const json = review?.contentJson as Record<string, unknown> | undefined

  const recommendation =
    (json?.recommendation as string) ?? (phase.status === 'complete' ? 'approve' : 'unknown')
  const findings = json?.findings as Record<string, number> | undefined
  const coveragePercent = json?.coveragePercent as number | undefined
  const requirementsWithTasks = (json?.requirementsWithTasks as number) ?? 0
  const totalRequirements = (json?.totalRequirements as number) ?? 0
  const unmappedTasks = (json?.unmappedTasks as number) ?? 0
  const constitutionViolations = (json?.constitutionViolations as number) ?? 0
  const discoveries = extractDiscoveries(phase.artifactsJson)

  const display = getRecommendationDisplay(recommendation)
  const DisplayIcon = display.icon

  // Coverage variant
  const coverageVariant =
    coveragePercent != null
      ? coveragePercent >= 90
        ? ('success' as const)
        : coveragePercent >= 70
          ? ('warning' as const)
          : ('danger' as const)
      : ('default' as const)

  // Findings max for bar chart
  const findingValues = findings ? Object.values(findings) : []
  const maxFindings = Math.max(...findingValues, 1)

  // Fallback to markdown
  if (!json && review?.contentMd) {
    return (
      <div>
        <DeliverableHeader config={config} summary="Review completed" duration={duration} />
        <CappedMarkdownBlock content={review.contentMd} label="Review Details" className="" />
      </div>
    )
  }

  if (!json && !review?.contentMd) {
    return (
      <div>
        <DeliverableHeader config={config} summary="No review artifact found" duration={duration} />
        <p className="text-xs text-text-muted italic">
          The review artifact was not produced by this phase.
        </p>
      </div>
    )
  }

  return (
    <div>
      <DeliverableHeader config={config} summary={display.label} duration={duration} />

      {/* Recommendation banner */}
      <div
        className={`flex items-center gap-3 px-4 py-3 rounded-xl border ${display.bgClass} mb-6`}
      >
        <DisplayIcon size={20} className={display.textClass} />
        <span className={`text-sm font-semibold ${display.textClass}`}>{display.label}</span>
      </div>

      {/* Metrics */}
      {(() => {
        const visibleMetrics = [
          coveragePercent != null,
          totalRequirements > 0,
          true, // unmapped always shows
          true // violations always shows
        ].filter(Boolean).length

        const gridCols =
          visibleMetrics >= 4 ? 'grid-cols-4' : visibleMetrics === 3 ? 'grid-cols-3' : 'grid-cols-2'

        return (
          <div className={`grid ${gridCols} gap-3 mb-6`}>
            {coveragePercent != null && (
              <MetricTile
                label="Coverage"
                value={`${coveragePercent}%`}
                variant={coverageVariant}
              />
            )}
            {totalRequirements > 0 && (
              <MetricTile
                label="Req / Tasks"
                value={`${requirementsWithTasks}/${totalRequirements}`}
              />
            )}
            <MetricTile
              label="Unmapped"
              value={`${unmappedTasks} task${unmappedTasks !== 1 ? 's' : ''}`}
              variant={unmappedTasks > 0 ? 'warning' : 'default'}
            />
            <MetricTile
              label="Violations"
              value={constitutionViolations}
              variant={constitutionViolations > 0 ? 'danger' : 'success'}
            />
          </div>
        )
      })()}

      {/* Findings severity chart */}
      {findings && Object.keys(findings).length > 0 && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
            Findings
          </h3>
          <div className="rounded-xl border border-border-subtle bg-surface-overlay p-4 space-y-2">
            {(['critical', 'high', 'medium', 'low'] as const).map((severity) => (
              <FindingsBar
                key={severity}
                severity={severity}
                count={(findings as Record<string, number>)[severity] ?? 0}
                maxCount={maxFindings}
              />
            ))}
          </div>
        </div>
      )}

      {/* Review narrative */}
      {review?.contentMd && (
        <CappedMarkdownBlock
          content={review.contentMd}
          label="Review Narrative"
          maxH="max-h-[500px]"
        />
      )}

      {/* Discoveries */}
      <DiscoveriesSection discoveries={discoveries} />
    </div>
  )
}
