/**
 * VerifyDeliverable — renders quality & gap detection results.
 *
 * Shows overall status banner, quality gates grid, artifact verification bar,
 * remediation tasks, human verification items, and full report.
 */

import { type JSX } from 'react'
import {
  ShieldCheck,
  AlertTriangle,
  UserCheck,
  CheckCircle2,
  XCircle
} from 'lucide-react'
import type { BlueprintPhase } from '../../../../../../shared/blueprint-types'
import { PHASE_ICONS } from '../phase-icons'
import { DeliverableHeader, MetricTile, DiscoveriesSection, CappedMarkdownBlock } from './shared'
import { findArtifact, extractDiscoveries } from './artifact-helpers'

// ── Types ──

interface QualityGate {
  name: string
  status: 'pass' | 'fail' | 'warn' | string
  value?: string | number
}

interface RemediationTask {
  taskId: string
  description: string
  status?: string
}

// ── Helpers ──

function humanizeRecommendation(rec: string): string {
  switch (rec) {
    case 'ship': return 'Ready to ship'
    case 'fix_gaps': return 'Fix identified gaps before shipping'
    case 'manual_review': return 'Manual review needed before shipping'
    default: return rec
  }
}

function getStatusDisplay(
  status: string,
  hasRemediationTasks?: boolean
): {
  label: string
  icon: typeof ShieldCheck
  bgClass: string
  textClass: string
} {
  switch (status) {
    case 'passed':
      return { label: 'Verification Passed — Ready to Ship', icon: ShieldCheck, bgClass: 'bg-success/10 border-success/20', textClass: 'text-success' }
    case 'gaps_found':
      return {
        label: hasRemediationTasks ? 'Gaps Found — Remediation Applied' : 'Gaps Found — Manual Review Needed',
        icon: AlertTriangle,
        bgClass: 'bg-warning/10 border-warning/20',
        textClass: 'text-warning'
      }
    case 'human_needed':
      return { label: 'Human Review Needed', icon: UserCheck, bgClass: 'bg-info/10 border-info/20', textClass: 'text-info' }
    default:
      return { label: status || 'Unknown', icon: ShieldCheck, bgClass: 'bg-surface-overlay border-border-subtle', textClass: 'text-text-primary' }
  }
}

// ── Stacked Bar ──

function ArtifactVerificationBar({
  verified,
  hollow,
  stub,
  missing
}: {
  verified: number
  hollow: number
  stub: number
  missing: number
}): JSX.Element {
  const total = verified + hollow + stub + missing
  if (total === 0) return <></>

  const segments = [
    { count: verified, color: 'bg-success', label: 'Verified' },
    { count: hollow, color: 'bg-warning', label: 'Hollow' },
    { count: stub, color: 'bg-info', label: 'Stub' },
    { count: missing, color: 'bg-danger', label: 'Missing' }
  ].filter((s) => s.count > 0)

  return (
    <div>
      <div className="flex items-center gap-2 mb-2 text-xs text-text-muted">
        {segments.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1">
            <span className={`inline-block w-2.5 h-2.5 rounded-sm ${s.color}`} />
            {s.label}: {s.count}
          </span>
        ))}
      </div>
      <div className="flex h-4 rounded-full overflow-hidden bg-surface-inset">
        {segments.map((s) => (
          <div
            key={s.label}
            className={`${s.color} transition-all`}
            style={{ width: `${(s.count / total) * 100}%` }}
          />
        ))}
      </div>
    </div>
  )
}

// ── Component ──

export function VerifyDeliverable({
  phase,
  duration
}: {
  phase: BlueprintPhase
  duration: number | null
}): JSX.Element {
  const config = PHASE_ICONS.verify
  const verify = findArtifact(phase.artifactsJson, 'verify', 'verification')
  const json = verify?.contentJson as Record<string, unknown> | undefined

  const overallStatus = (json?.overallStatus as string) ?? 'unknown'
  const artifacts = json?.artifacts as Record<string, number> | undefined
  const keyLinks = json?.keyLinks as Record<string, number> | undefined
  const antiPatterns = (json?.antiPatterns as string[]) ?? []
  const requirementsCovered = (json?.requirementsCovered as number) ?? 0
  const totalRequirements = (json?.totalRequirements as number) ?? 0
  const qualityGates = (json?.qualityGates as QualityGate[]) ?? []
  const recommendation = (json?.recommendation as string) ?? null
  const humanVerification = (json?.humanVerificationNeeded as string[]) ?? []
  const discoveries = extractDiscoveries(phase.artifactsJson)

  // Remediation tasks
  const tasks = (json?.tasks as Array<Record<string, unknown>>) ?? []
  const remediationTasks: RemediationTask[] = tasks
    .filter((t) => String(t.taskId ?? '').startsWith('R'))
    .map((t) => ({
      taskId: String(t.taskId ?? ''),
      description: String(t.description ?? ''),
      status: t.status as string | undefined
    }))

  const display = getStatusDisplay(overallStatus, remediationTasks.length > 0)
  const DisplayIcon = display.icon

  // Coverage percentage
  const coveragePct = totalRequirements > 0
    ? Math.round((requirementsCovered / totalRequirements) * 100)
    : null
  const coverageVariant = coveragePct != null
    ? coveragePct >= 90 ? 'success' as const : coveragePct >= 70 ? 'warning' as const : 'danger' as const
    : 'default' as const

  // Fallback
  if (!json && verify?.contentMd) {
    return (
      <div>
        <DeliverableHeader config={config} summary="Verification completed" duration={duration} />
        <CappedMarkdownBlock content={verify.contentMd} label="Verification Report" className="" />
      </div>
    )
  }

  if (!json && !verify?.contentMd) {
    return (
      <div>
        <DeliverableHeader config={config} summary="No verification data found" duration={duration} />
        <p className="text-xs text-text-muted italic">The verification artifact was not produced by this phase.</p>
      </div>
    )
  }

  return (
    <div>
      <DeliverableHeader config={config} summary={display.label} duration={duration} />

      {/* Status banner */}
      <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border ${display.bgClass} mb-6`}>
        <DisplayIcon size={20} className={display.textClass} />
        <span className={`text-sm font-semibold ${display.textClass}`}>{display.label}</span>
      </div>

      {/* Recommendation */}
      {recommendation && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">Recommendation</h3>
          <p className="text-sm text-text-secondary leading-relaxed border-l-2 border-accent/30 pl-4 italic">
            {humanizeRecommendation(recommendation)}
          </p>
        </div>
      )}

      {/* Quality gates */}
      {qualityGates.length > 0 && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Quality Gates</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {qualityGates.map((gate) => (
              <MetricTile
                key={gate.name}
                label={gate.name}
                value={gate.value != null ? String(gate.value) : gate.status === 'pass' ? '✓ Pass' : gate.status === 'fail' ? '✗ Fail' : gate.status === 'warn' ? '⚠ Warning' : gate.status.replace(/_/g, ' ')}
                variant={gate.status === 'pass' ? 'success' : gate.status === 'fail' ? 'danger' : gate.status === 'warn' ? 'warning' : 'default'}
              />
            ))}
          </div>
        </div>
      )}

      {/* Artifact verification */}
      {artifacts && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Artifact Verification</h3>
          <div className="rounded-xl border border-border-subtle bg-surface-overlay p-4">
            <ArtifactVerificationBar
              verified={artifacts.verified ?? 0}
              hollow={artifacts.hollow ?? 0}
              stub={artifacts.stub ?? 0}
              missing={artifacts.missing ?? 0}
            />
          </div>
        </div>
      )}

      {/* Key links */}
      {keyLinks && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Key Links</h3>
          <div className="grid grid-cols-2 gap-3">
            <MetricTile label="Verified" value={keyLinks.verified ?? 0} variant="success" />
            <MetricTile label="Broken" value={keyLinks.broken ?? 0} variant={(keyLinks.broken ?? 0) > 0 ? 'danger' : 'success'} />
          </div>
        </div>
      )}

      {/* Requirements coverage */}
      {totalRequirements > 0 && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Requirements Coverage</h3>
          <div className="rounded-xl border border-border-subtle bg-surface-overlay p-4">
            <div className="flex items-center gap-3 mb-2">
              <span className="text-sm text-text-secondary">
                {requirementsCovered}/{totalRequirements} requirements covered
              </span>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex-1 h-3 bg-surface-inset rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    coverageVariant === 'success' ? 'bg-success' : coverageVariant === 'warning' ? 'bg-warning' : 'bg-danger'
                  }`}
                  style={{ width: `${coveragePct ?? 0}%` }}
                />
              </div>
              <span className="text-sm font-mono text-text-muted tabular-nums">{coveragePct ?? 0}%</span>
            </div>
          </div>
        </div>
      )}

      {/* Remediation tasks */}
      {remediationTasks.length > 0 && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
            Remediation Tasks ({remediationTasks.length})
          </h3>
          <div className="rounded-xl border border-border-subtle overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-overlay border-b border-border-subtle">
                  <th className="text-left px-4 py-2 text-xs font-semibold text-text-muted uppercase tracking-wider w-16">Task</th>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-text-muted uppercase tracking-wider">Description</th>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-text-muted uppercase tracking-wider w-28">Status</th>
                </tr>
              </thead>
              <tbody>
                {remediationTasks.map((task) => (
                  <tr key={task.taskId} className="border-b border-border-subtle last:border-b-0">
                    <td className="px-4 py-2 text-xs font-mono text-text-muted w-16">{task.taskId}</td>
                    <td className="px-4 py-2 text-text-secondary">{task.description}</td>
                    <td className="px-4 py-2 w-28">
                      {task.status === 'complete' ? (
                        <span className="inline-flex items-center gap-1 text-xs text-success">
                          <CheckCircle2 size={12} /> Complete
                        </span>
                      ) : task.status === 'failed' ? (
                        <span className="inline-flex items-center gap-1 text-xs text-danger">
                          <XCircle size={12} /> Failed
                        </span>
                      ) : (
                        <span className="text-xs text-text-muted">{task.status ?? 'Pending'}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Human verification */}
      {humanVerification.length > 0 && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
            <UserCheck size={12} className="inline mr-1" />
            Human Verification Needed
          </h3>
          <div className="space-y-2">
            {humanVerification.map((item, i) => (
              <div key={i} className="flex items-start gap-2 px-3 py-2 rounded-lg bg-info/5 border border-info/10">
                <span className="text-info mt-0.5">•</span>
                <span className="text-sm text-text-secondary">{item}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Anti-patterns */}
      {antiPatterns.length > 0 && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
            <AlertTriangle size={12} className="inline mr-1 text-warning" />
            Anti-patterns Detected ({antiPatterns.length})
          </h3>
          <div className="space-y-2">
            {antiPatterns.map((pattern, i) => (
              <div key={i} className="flex items-start gap-2 px-3 py-2 rounded-lg bg-warning/5 border border-warning/10">
                <span className="text-warning mt-0.5">•</span>
                <span className="text-sm text-text-secondary">{pattern}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Full report */}
      {verify?.contentMd && (
        <CappedMarkdownBlock content={verify.contentMd} label="Verification Report" maxH="max-h-[500px]" />
      )}

      {/* Discoveries */}
      <DiscoveriesSection discoveries={discoveries} />
    </div>
  )
}
