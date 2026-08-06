/**
 * PlanDeliverable — renders the implementation plan.
 *
 * Shows plan summary, tech stack, item table (reuses BlueprintPlanCard),
 * Mermaid dependency diagram, and risks.
 */

import { useMemo, type JSX } from 'react'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import type { BlueprintPhase } from '../../../../../../shared/blueprint-types'
import { PHASE_ICONS } from '../phase-icons'
import { BlueprintPlanCard } from '../BlueprintPlanCard'
import MermaidDiagram from '@renderer/components/common/MermaidDiagram'
import { DeliverableHeader, MetricTile, DiscoveriesSection, CappedMarkdownBlock } from './shared'
import { findArtifact, extractDiscoveries } from './artifact-helpers'

// ── Types ──

interface PlanItem {
  id?: string
  title?: string
  description?: string
  files?: string[]
  dependsOn?: string[]
  [key: string]: unknown
}

// ── Helpers ──

function buildDependencyDiagram(items: PlanItem[]): string | null {
  const hasDeps = items.some((item) => item.dependsOn && item.dependsOn.length > 0)
  if (!hasDeps) return null

  const lines = ['graph LR']
  for (const item of items) {
    const id = item.id ?? `P${items.indexOf(item) + 1}`
    const label = (item.title ?? item.description ?? id).slice(0, 40).replace(/["<>&[\]]/g, ' ')
    lines.push(`  ${id}["${id}: ${label}"]`)
    for (const dep of item.dependsOn ?? []) {
      lines.push(`  ${dep} --> ${id}`)
    }
  }
  return lines.join('\n')
}

// ── Component ──

export function PlanDeliverable({
  phase,
  duration
}: {
  phase: BlueprintPhase
  duration: number | null
}): JSX.Element {
  const config = PHASE_ICONS.plan
  const plan = findArtifact(phase.artifactsJson, 'plan', 'blueprint-plan')
  const json = plan?.contentJson as Record<string, unknown> | undefined

  const items = useMemo(
    () => (json?.items ?? json?.phases ?? json?.steps ?? []) as PlanItem[],
    [json]
  )

  const totalFiles = useMemo(
    () => items.reduce((sum, item) => sum + (item.files?.length ?? 0), 0),
    [items]
  )

  const risks = (json?.risks as string[]) ?? []
  const summary = (json?.summary as string) ?? null
  const techStack = json?.techStack as Record<string, string> | undefined
  const discoveries = extractDiscoveries(phase.artifactsJson)
  const violations = (json?.constitutionViolations as number) ?? 0
  const recommendation = (json?.recommendation as string) ?? null

  const diagram = useMemo(() => buildDependencyDiagram(items), [items])

  // Fallback to markdown if no structured data
  if (!json && plan?.contentMd) {
    return (
      <div>
        <DeliverableHeader
          config={config}
          summary="Implementation plan drafted"
          duration={duration}
        />
        <CappedMarkdownBlock content={plan.contentMd} label="Plan Details" className="" />
      </div>
    )
  }

  if (!json) {
    return (
      <div>
        <DeliverableHeader config={config} summary="No plan artifact found" duration={duration} />
        <p className="text-xs text-text-muted italic">
          The plan artifact was not produced by this phase.
        </p>
      </div>
    )
  }

  return (
    <div>
      <DeliverableHeader
        config={config}
        summary={`${items.length} items · ${totalFiles} files`}
        duration={duration}
      />

      {/* Recommendation banner */}
      {recommendation && (
        <div
          className={`flex items-center gap-3 px-4 py-3 rounded-xl border mb-6 ${
            recommendation === 'proceed'
              ? 'bg-success/10 border-success/20'
              : 'bg-warning/10 border-warning/20'
          }`}
        >
          {recommendation === 'proceed' ? (
            <CheckCircle2 size={16} className="text-success" />
          ) : (
            <AlertTriangle size={16} className="text-warning" />
          )}
          <span
            className={`text-sm font-semibold ${
              recommendation === 'proceed' ? 'text-success' : 'text-warning'
            }`}
          >
            {recommendation === 'proceed' ? 'Ready to Proceed' : recommendation.replace(/_/g, ' ')}
          </span>
        </div>
      )}

      {/* Metrics */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        <MetricTile label="Plan Items" value={items.length} />
        <MetricTile label="Total Files" value={totalFiles} />
        <MetricTile
          label="Risks"
          value={risks.length}
          variant={risks.length > 0 ? 'warning' : 'default'}
        />
        <MetricTile
          label="Violations"
          value={violations}
          variant={violations > 0 ? 'danger' : 'success'}
        />
      </div>

      {/* Summary */}
      {summary && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">
            Summary
          </h3>
          <p className="text-sm text-text-secondary leading-relaxed border-l-2 border-accent/30 pl-4 italic">
            {summary}
          </p>
        </div>
      )}

      {/* Tech Stack */}
      {techStack && Object.keys(techStack).length > 0 && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
            Tech Stack
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {Object.entries(techStack).map(([key, value]) => (
              <div
                key={key}
                className="rounded-lg border border-border-subtle bg-surface-overlay px-3 py-2"
              >
                <div className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">
                  {key}
                </div>
                <div className="text-sm text-text-primary font-medium mt-0.5">{value}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Plan table (reused component) */}
      <div className="mb-6">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
          Implementation Plan
        </h3>
        <BlueprintPlanCard plan={json} />
      </div>

      {/* Dependency diagram */}
      {diagram && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
            Dependency Flow
          </h3>
          <div className="rounded-xl border border-border-subtle bg-surface-overlay p-4 overflow-hidden">
            <MermaidDiagram definition={diagram} id="plan-deps" />
          </div>
        </div>
      )}

      {/* Risks */}
      {risks.length > 0 && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
            Risks
          </h3>
          <div className="space-y-2">
            {risks.map((risk, i) => (
              <div
                key={i}
                className="flex items-start gap-2 px-3 py-2 rounded-lg bg-warning/5 border border-warning/10"
              >
                <AlertTriangle size={14} className="text-warning mt-0.5 flex-shrink-0" />
                <span className="text-sm text-text-secondary">{risk}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Discoveries */}
      <DiscoveriesSection discoveries={discoveries} />
    </div>
  )
}
