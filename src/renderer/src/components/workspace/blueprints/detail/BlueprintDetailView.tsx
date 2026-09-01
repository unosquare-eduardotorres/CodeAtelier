/**
 * BlueprintDetailView — top-level component for viewing a past or in-progress
 * blueprint run. Replaces the inline detail view that was in BlueprintPage.tsx.
 *
 * Layout:
 *   ┌─ Header card (title, status, priority, duration, created) ──┐
 *   │   ▸ Description (markdown, collapsed, gradient fade)        │
 *   ├─ OutcomeSummary (complete runs only) ───────────────────────┤
 *   ├─ Error/Stopped/Interrupted banners ─────────────────────────┤
 *   └─ PhaseJourney (accordion list of all phases) ───────────────┘
 */

import { useState, useMemo, useRef, useCallback, type JSX } from 'react'
import {
  StopCircle,
  Clock,
  XCircle,
  RotateCcw,
  PlayCircle,
  ChevronDown,
  AlertTriangle,
  MessageSquareText,
  MessageSquarePlus,
  UserCheck,
  CheckCircle2,
  GitBranch
} from 'lucide-react'
import type { BlueprintWithDetails } from '../../../../../../shared/blueprint-types'
import { summarizeLedger } from '../../../../../../shared/gate-types'
import { useBlueprintStore, type BlueprintChatMessage } from '@renderer/store/blueprint.store'
import { useChatAvatarSize } from '@renderer/hooks/useChatAvatarSize'
import { renderBlueprintMessage } from '../BlueprintChatView'
import { StatusBadge } from '../StatusBadge'
import { formatTimeAgo } from '../utils'
import { BlueprintMarkdown } from '../BlueprintMarkdown'
import { PhaseJourney } from './PhaseJourney'
import { OutcomeSummary } from './OutcomeSummary'
import { BlueprintHandoffCard } from './BlueprintHandoffCard'
import { getOutcomeStats, formatDuration } from './phase-summaries'
import { findArtifact, findAllArtifacts } from '../deliverables/artifact-helpers'
import { deriveTaskFailureDisplay, capTaskList } from '@renderer/utils/task-failure-display'
import { BlueprintAttachments } from './BlueprintAttachments'
import { extractReferenceDocs, readBlueprintBranchName } from './reference-docs'
import { DraftPanel } from './DraftPanel'
import BlueprintFileViewerDrawer from '../BlueprintFileViewerDrawer'

// ── Markdown Description Block (collapsible) ──

function DescriptionBlock({ description }: { description: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="relative">
      <div className={expanded ? '' : 'max-h-40 overflow-hidden'}>
        <BlueprintMarkdown>{description}</BlueprintMarkdown>
      </div>
      {!expanded && (
        <div className="absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-surface-raised to-transparent pointer-events-none" />
      )}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-xs text-accent hover:text-accent/80 font-medium mt-1 transition-colors"
      >
        <ChevronDown size={12} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
        {expanded ? 'Show less' : 'Show more'}
      </button>
    </div>
  )
}

// ── Mid-pipeline statuses (orphaned — pipeline not running) ──

const MID_PIPELINE_STATUSES = new Set([
  'specifying',
  'clarifying',
  'planning',
  'tasking',
  'reviewing',
  'building',
  'verifying'
])

// ── Props ──

interface BlueprintDetailViewProps {
  selectedId: string
  currentBlueprint: BlueprintWithDetails | null
  lastError: { blueprintId: string; message: string } | null
  isRunning: boolean
  workspaceId: string | null
  onBack: () => void
  onRetryPhase: () => void
  onNavigateToChat?: () => void
}

// ── Component ──

export function BlueprintDetailView({
  selectedId,
  currentBlueprint,
  lastError,
  isRunning,
  workspaceId,
  onBack,
  onRetryPhase,
  onNavigateToChat
}: BlueprintDetailViewProps): JSX.Element {
  // All hooks must be called before any early returns (Rules of Hooks)
  const bp = currentBlueprint
  const isComplete = bp?.status === 'complete'
  const isDraft = bp?.status === 'draft'
  const referenceDocs = useMemo(() => (bp ? extractReferenceDocs(bp.settingsJson) : []), [bp])
  const branchName = bp ? readBlueprintBranchName(bp.settingsJson) : null
  const outcomeStats = isComplete && bp ? getOutcomeStats(bp.phases, bp.tasks) : null
  const isGapsFound = isComplete && outcomeStats?.verifyStatus === 'gaps_found'

  // The handoff card sits below the phase banners — roughly a screen down on a
  // finished run. The header button scrolls to it rather than duplicating the
  // intent picker: one place to choose an intent, two places to find it.
  const handoffCardRef = useRef<HTMLDivElement>(null)
  const scrollToHandoff = useCallback(() => {
    handoffCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [])

  // Extract human verification items from verify artifact
  const humanVerificationItems = useMemo(() => {
    if (!bp || !isComplete || outcomeStats?.verifyStatus !== 'human_needed') return []
    const verifyPhase = bp.phases.find((p) => p.phase === 'verify')
    if (!verifyPhase) return []
    const art = findArtifact(verifyPhase.artifactsJson, 'verify', 'verification')
    const json = art?.contentJson as Record<string, unknown> | undefined
    return (json?.humanVerificationNeeded as string[]) ?? []
  }, [isComplete, outcomeStats, bp])

  if (!bp || bp.id !== selectedId) {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
          ← Back to list
        </button>
        <div className="text-xs text-text-muted animate-pulse text-center py-8">
          Loading blueprint...
        </div>
      </div>
    )
  }

  // Compute total duration for header
  const startTimes = bp.phases.map((p) => p.startedAt).filter(Boolean) as string[]
  const endTimes = bp.phases.map((p) => p.completedAt).filter(Boolean) as string[]
  let totalDuration: string | null = null
  if (startTimes.length > 0 && endTimes.length > 0) {
    const earliest = new Date(
      Math.min(...startTimes.map((s) => new Date(s).getTime()))
    ).toISOString()
    const latest = new Date(Math.max(...endTimes.map((s) => new Date(s).getTime()))).toISOString()
    totalDuration = formatDuration(earliest, latest)
  }

  return (
    <div className="flex min-h-0">
      {/* Main column — the original detail scroll area */}
      <div className="flex-1 min-w-0 space-y-4">
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
          ← Back to list
        </button>

        {/* ── Header Card ── */}
        <div className="bg-surface-raised rounded-xl border border-border-subtle p-4 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-sm font-semibold text-text-primary">{bp.title}</h4>
            <StatusBadge status={bp.status} />
            {/* The run's own branch. Absent until the run starts, and deliberately
              distinct from the status bar, which shows the workspace checkout. */}
            {branchName && (
              <span
                data-testid="blueprint-branch-chip"
                title={`This blueprint works on ${branchName}`}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono rounded bg-surface-inset text-text-secondary max-w-[240px]"
              >
                <GitBranch size={10} className="flex-shrink-0" />
                <span className="truncate">{branchName}</span>
              </span>
            )}
            {totalDuration && (
              <span className="text-[10px] text-text-muted flex items-center gap-1">
                <Clock size={10} />
                {totalDuration}
              </span>
            )}
            {isComplete && (
              <button
                type="button"
                data-testid="blueprint-handoff-jump"
                onClick={scrollToHandoff}
                className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium text-accent hover:bg-accent/10 rounded-lg transition-colors"
              >
                <MessageSquarePlus size={11} />
                Continue in chat
              </button>
            )}
          </div>
          {bp.description && <DescriptionBlock description={bp.description} />}
          <div className="flex items-center gap-2 text-[10px] text-text-muted">
            <Clock size={10} />
            <span title={bp.createdAt}>Created {formatTimeAgo(new Date(bp.createdAt))}</span>
            {bp.completedAt &&
              (bp.status === 'complete' || bp.status === 'failed' || bp.status === 'cancelled') && (
                <>
                  <span>·</span>
                  <span title={bp.completedAt}>
                    {bp.status === 'complete'
                      ? 'Completed'
                      : bp.status === 'failed'
                        ? 'Failed'
                        : 'Stopped'}{' '}
                    {formatTimeAgo(new Date(bp.completedAt))}
                  </span>
                </>
              )}
          </div>
        </div>

        {/* ── Draft: edit + start, the only actions a never-run blueprint has ── */}
        {isDraft && <DraftPanel blueprint={bp} workspaceId={workspaceId} />}

        {/* ── Attachments (drafts render their own copy inside DraftPanel) ── */}
        {!isDraft && <BlueprintAttachments documents={referenceDocs} />}

        {/* ── Outcome Summary (complete runs only) ── */}
        {outcomeStats && <OutcomeSummary stats={outcomeStats} />}

        {/* ── Gaps found banner with Fix Gaps button ── */}
        {isGapsFound && (
          <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-warning/20 bg-warning/5 text-warning">
            <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
            <div className="flex flex-col gap-0.5 flex-1">
              <span className="text-sm font-medium">Gaps Found During Verification</span>
              <span className="text-xs opacity-80">
                The verifier identified issues that need fixing. Retry to generate fix tasks and
                rebuild.
              </span>
            </div>
            <button
              onClick={onRetryPhase}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-warning hover:bg-warning/80 rounded-lg transition-colors flex-shrink-0"
            >
              <RotateCcw size={12} />
              Fix Gaps
            </button>
          </div>
        )}

        {/* ── M9.4 — Unverified-items banner: the run finished UNPROVEN ──
          Persistent amber banner when the unverified ledger is non-empty —
          checks that could not run (no_command, no_git, …) or code-review
          findings that survived the fix round. Data flows via the blueprint
          record (unverifiedJson), so it survives reload. */}
        {bp.unverifiedJson && bp.unverifiedJson.length > 0 && (
          <div
            data-testid="blueprint-unverified-banner"
            className="rounded-xl border border-warning/20 bg-warning/5"
          >
            <div className="flex items-start gap-3 px-4 py-3">
              <AlertTriangle size={16} className="mt-0.5 flex-shrink-0 text-warning" />
              <div className="flex flex-col gap-0.5 flex-1">
                <span className="text-sm font-medium text-warning">
                  {/* M8.4 — grouped rollup instead of a bare count */}
                  Finished UNPROVEN — {bp.unverifiedJson.length} check
                  {bp.unverifiedJson.length > 1 ? 's' : ''} could not be verified (
                  {Object.entries(summarizeLedger(bp.unverifiedJson).byGate)
                    .map(([gate, n]) => `${gate} ×${n}`)
                    .join(', ')}
                  )
                </span>
                <span className="text-xs text-text-muted">
                  These checks never executed, so nothing was verified for them. They never blocked
                  the run — they are recorded so the gap is visible.
                </span>
              </div>
            </div>
            <div className="border-t border-warning/10 px-4 py-3 space-y-1.5">
              {bp.unverifiedJson.map((item, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="text-warning/60 mt-0.5 text-xs font-mono">▸</span>
                  <span className="text-xs text-text-secondary">
                    <span className="font-mono text-[10px] text-text-muted">
                      {item.taskId}/{item.gate}
                    </span>{' '}
                    <span className="font-mono text-[10px] text-warning/80">{item.reason}</span>
                    {item.detail ? ` — ${item.detail}` : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Human review needed banner (unacknowledged) with Mark as Verified + Re-verify ── */}
        {isComplete &&
          outcomeStats?.verifyStatus === 'human_needed' &&
          !outcomeStats.humanReviewAcknowledged && (
            <div className="rounded-xl border border-accent/20 bg-accent/5 text-accent">
              <div className="flex items-start gap-3 px-4 py-3">
                <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
                <div className="flex flex-col gap-0.5 flex-1">
                  <span className="text-sm font-medium">Human Review Needed</span>
                  <span className="text-xs opacity-80">
                    The verifier flagged items that require manual verification before shipping.
                  </span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={() => useBlueprintStore.getState().acknowledgeReview(bp.id)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-success hover:bg-success/80 rounded-lg transition-colors"
                  >
                    <UserCheck size={12} />
                    Mark as Verified
                  </button>
                  <button
                    onClick={onRetryPhase}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent/80 rounded-lg transition-colors"
                  >
                    <RotateCcw size={12} />
                    Re-verify
                  </button>
                </div>
              </div>
              {humanVerificationItems.length > 0 && (
                <div className="border-t border-accent/10 px-4 py-3 space-y-1.5">
                  {humanVerificationItems.map((item, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <span className="text-accent/60 mt-0.5 text-xs">▸</span>
                      <span className="text-xs text-text-secondary">{item}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

        {/* ── Human review acknowledged success note ── */}
        {isComplete &&
          outcomeStats?.verifyStatus === 'human_needed' &&
          outcomeStats.humanReviewAcknowledged && (
            <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl border border-success/20 bg-success/5 text-success">
              <CheckCircle2 size={14} className="flex-shrink-0" />
              <span className="text-xs font-medium">
                Human review completed ✓
                {outcomeStats.acknowledgedAt
                  ? ` — acknowledged ${formatTimeAgo(new Date(outcomeStats.acknowledgedAt))}`
                  : ''}
              </span>
            </div>
          )}

        {/* ── Failed phase error banner with retry ── */}
        {bp.status === 'failed' &&
          (() => {
            const failedPhase = bp.phases.find((p) => p.status === 'failed')
            const errorMsg = lastError?.blueprintId === bp.id ? lastError.message : null

            // F4 — environmental blocker from the persisted retry-context
            // snapshot. saveRetryContext writes `environmentalFailure` when the
            // failing gates included command_missing/command_error: the host
            // lacks a tool, so no retry can succeed (incident 2026-08, ~20
            // blind retries). Read from the phase record — survives reload.
            let environmentalFailure: string | null = null
            if (failedPhase?.contextSnapshot) {
              try {
                const snap = JSON.parse(failedPhase.contextSnapshot) as Record<string, unknown>
                if (typeof snap.environmentalFailure === 'string' && snap.environmentalFailure) {
                  environmentalFailure = snap.environmentalFailure
                }
              } catch {
                /* malformed snapshot — treat as absent */
              }
            }

            // When lastError is null (ephemeral, or gaps_found path), derive context
            // from the phase's own artifact data.
            let failureContext: {
              title: string
              description: string
              isGaps: boolean
              isEnvironmental?: boolean
            } | null = null
            if (environmentalFailure) {
              // Environmental outranks gaps: it explains why retrying cannot help.
              failureContext = {
                title: 'Environmental Failure — Retry Disabled',
                description: environmentalFailure,
                isGaps: false,
                isEnvironmental: true
              }
            } else if (!errorMsg && failedPhase) {
              const verifyArt = findArtifact(failedPhase.artifactsJson, 'verify', 'verification')
              const json = verifyArt?.contentJson as Record<string, unknown> | undefined
              const overallStatus = json?.overallStatus as string | undefined
              if (overallStatus === 'gaps_found') {
                // Prefer new `remediationTasks` field, fall back to legacy `tasks` R-filtered
                const remTasks =
                  (json?.remediationTasks as unknown[]) ??
                  ((json?.tasks as Array<Record<string, unknown>>) ?? []).filter((t) =>
                    String(t.taskId ?? '').startsWith('R')
                  )
                failureContext = {
                  title: 'Gaps Found During Verification',
                  description:
                    remTasks.length > 0
                      ? `The verifier identified ${remTasks.length} issue(s) requiring remediation.`
                      : 'The verifier identified issues but could not generate remediation tasks.',
                  isGaps: true
                }
              }
            }

            // WAVE-RACE FIX: surface the persisted per-task failure reasons. The
            // banner above only shows the ephemeral lastError (null after reload);
            // the real reasons live in blueprint_tasks.failure_reason and the
            // build phase's verification-failure artifacts — both already in props.
            const failedTaskList =
              failedPhase?.phase === 'build'
                ? capTaskList(
                    (bp.tasks ?? []).filter((t) => t.status === 'failed'),
                    5
                  )
                : null
            const verifyFailArts = failedPhase
              ? findAllArtifacts(failedPhase.artifactsJson, 'verification-failure')
              : []
            const artifactForTask = (taskId: string): string | null => {
              const art = verifyFailArts.find((a) => a.contentMd?.startsWith(`## Task ${taskId} `))
              return art?.contentMd ?? null
            }

            return failedPhase ? (
              <div className="flex flex-col gap-2" key="failed-banner">
                <div
                  className={`flex items-start gap-3 px-4 py-3 rounded-xl border ${
                    failureContext?.isGaps || failureContext?.isEnvironmental
                      ? 'border-warning/20 bg-warning/5 text-warning'
                      : 'border-danger/20 bg-danger-muted text-danger'
                  }`}
                >
                  {failureContext?.isGaps || failureContext?.isEnvironmental ? (
                    <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
                  ) : (
                    <XCircle size={16} className="mt-0.5 flex-shrink-0" />
                  )}
                  <div className="flex flex-col gap-0.5 flex-1">
                    <span className="text-sm font-medium">
                      {failureContext?.title ??
                        `${failedPhase.phase.charAt(0).toUpperCase() + failedPhase.phase.slice(1)} phase failed`}
                    </span>
                    <span className="text-xs opacity-80">
                      {failureContext?.description ??
                        errorMsg ??
                        'An error occurred during this phase. Retry to try again.'}
                    </span>
                    {failureContext?.isEnvironmental && (
                      <span className="text-[11px] opacity-70 leading-relaxed">
                        Retrying cannot fix this — the failure is on this machine, not in the code.
                        Install the missing tool (or make sure it is on PATH), or declare a fenced
                        <code className="mx-1 px-1 py-0.5 rounded bg-warning/10 font-mono text-[10px]">
                          gate-commands
                        </code>
                        block in the plan artifact to override detection. Then retry.
                      </span>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <button
                      onClick={onRetryPhase}
                      disabled={failureContext?.isEnvironmental === true}
                      title={
                        failureContext?.isEnvironmental
                          ? 'Retry is disabled: this failure is environmental and deterministic — retrying cannot change it'
                          : undefined
                      }
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white rounded-lg transition-colors flex-shrink-0 ${
                        failureContext?.isEnvironmental
                          ? 'bg-text-muted opacity-50 cursor-not-allowed'
                          : failureContext?.isGaps
                            ? 'bg-warning hover:bg-warning/80'
                            : 'bg-danger hover:bg-danger/80'
                      }`}
                    >
                      <RotateCcw size={12} />
                      {failureContext?.isGaps ? 'Fix Gaps' : 'Retry'}
                    </button>
                    {/* F4 — recovery path: the disable breaks the blind-retry loop,
                        but the user who HAS remediated (installed the tool,
                        declared gate-commands) must still be able to retry. */}
                    {failureContext?.isEnvironmental && (
                      <button
                        type="button"
                        onClick={onRetryPhase}
                        className="text-[10px] underline underline-offset-2 opacity-70 hover:opacity-100 transition-opacity"
                      >
                        I&apos;ve fixed it — retry anyway
                      </button>
                    )}
                  </div>
                </div>
                {failedTaskList && failedTaskList.shown.length > 0 && (
                  <div className="px-4 py-3 rounded-xl border border-danger/20 bg-danger-muted/40 text-danger">
                    <div className="text-xs font-medium mb-2">
                      {failedTaskList.shown.length + failedTaskList.hiddenCount} task
                      {failedTaskList.shown.length + failedTaskList.hiddenCount === 1
                        ? ''
                        : 's'}{' '}
                      failed — persisted reasons:
                    </div>
                    <ul className="flex flex-col gap-2">
                      {failedTaskList.shown.map((t) => {
                        const disp = deriveTaskFailureDisplay(t, artifactForTask(t.taskId))
                        return (
                          <li key={t.taskId} className="flex flex-col gap-0.5">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-mono font-semibold">{disp.title}</span>
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-danger/15 border border-danger/25">
                                {disp.attempts} attempt{disp.attempts === 1 ? '' : 's'}
                              </span>
                            </div>
                            <span className="text-xs opacity-80">{disp.hint}</span>
                            {disp.missingFiles.length > 0 && (
                              <span className="text-[11px] opacity-60 font-mono">
                                missing: {disp.missingFiles.join(', ')}
                                {(() => {
                                  const total = (t.filePathsJson ?? []).length
                                  return disp.missingFiles.length >= 3 && total > 3
                                    ? ` (+${total - disp.missingFiles.length} more)`
                                    : ''
                                })()}
                              </span>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                    {failedTaskList.hiddenCount > 0 && (
                      <div className="text-[11px] opacity-60 mt-2">
                        +{failedTaskList.hiddenCount} more failed task
                        {failedTaskList.hiddenCount === 1 ? '' : 's'}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : null
          })()}

        {/* ── Stopped banner with Resume ── */}
        {bp.status === 'cancelled' &&
          (() => {
            const interruptedPhase = bp.currentPhase
            const phaseLabel = interruptedPhase
              ? interruptedPhase.charAt(0).toUpperCase() + interruptedPhase.slice(1)
              : 'next'
            return (
              <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-info/20 bg-info-muted text-info">
                <StopCircle size={16} className="mt-0.5 flex-shrink-0" />
                <div className="flex flex-col gap-0.5 flex-1">
                  <span className="text-sm font-medium">Stopped</span>
                  <span className="text-xs opacity-80">
                    Resume to continue from the {phaseLabel} phase.
                  </span>
                </div>
                <button
                  onClick={onRetryPhase}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-info hover:bg-info/80 rounded-lg transition-colors flex-shrink-0"
                >
                  <PlayCircle size={12} />
                  Resume
                </button>
              </div>
            )
          })()}

        {/* ── Interrupted banner (orphaned mid-pipeline, not running) ── */}
        {MID_PIPELINE_STATUSES.has(bp.status) &&
          !isRunning &&
          (() => {
            const interruptedPhase = bp.currentPhase
            const phaseLabel = interruptedPhase
              ? interruptedPhase.charAt(0).toUpperCase() + interruptedPhase.slice(1)
              : 'current'
            return (
              <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-info/20 bg-info-muted text-info">
                <RotateCcw size={16} className="mt-0.5 flex-shrink-0" />
                <div className="flex flex-col gap-0.5 flex-1">
                  <span className="text-sm font-medium">Interrupted</span>
                  <span className="text-xs opacity-80">
                    This blueprint was interrupted during the {phaseLabel} phase. Resume to
                    continue.
                  </span>
                </div>
                <button
                  onClick={onRetryPhase}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-info hover:bg-info/80 rounded-lg transition-colors flex-shrink-0"
                >
                  <PlayCircle size={12} />
                  Resume
                </button>
              </div>
            )
          })()}

        {/* ── Continue in Chat (only once the run has produced something to hand over) ── */}
        {!isRunning && bp.phases.some((p) => p.status === 'complete') && (
          <div ref={handoffCardRef}>
            <BlueprintHandoffCard
              blueprintId={bp.id}
              blueprintTitle={bp.title}
              workspaceId={workspaceId}
              onNavigateToChat={onNavigateToChat}
              prominent={isComplete}
            />
          </div>
        )}

        {/* ── Phase Journey (replaces flat Phases + Tasks lists) ── */}
        <PhaseJourney
          phases={bp.phases}
          tasks={bp.tasks}
          autoExpandActive={true}
          blueprintId={bp.id}
        />

        {/* ── Transcript (read-only hydrated chat history) ── */}
        <TranscriptSection blueprintId={bp.id} />
      </div>

      {/* ── Shared file viewer drawer — any deliverable can open files here ── */}
      <BlueprintFileViewerDrawer />
    </div>
  )
}

// ── Read-only Transcript Section (hydrated journal messages) ──

function TranscriptSection({ blueprintId }: { blueprintId: string }): JSX.Element | null {
  const chatMessages = useBlueprintStore((s) => s.chatMessages)
  const currentBpId = useBlueprintStore((s) => s.currentBlueprint?.id)
  const avatarSize = useChatAvatarSize()
  const [expanded, setExpanded] = useState(false)

  // Only render if we have hydrated messages for THIS blueprint
  const messages = currentBpId === blueprintId ? chatMessages : []
  if (messages.length === 0) return null

  return (
    <div className="bg-surface-raised rounded-xl border border-border-subtle overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-3 hover:bg-surface-overlay/30 transition-colors"
      >
        <MessageSquareText size={14} className="text-accent" />
        <span className="text-xs font-semibold text-text-primary flex-1 text-left">Transcript</span>
        <span className="text-[10px] text-text-muted">{messages.length} messages</span>
        <ChevronDown
          size={12}
          className={`text-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>
      {expanded && (
        <div className="border-t border-border/30 px-4 py-4 space-y-4 max-h-[600px] overflow-y-auto">
          {messages.map((msg: BlueprintChatMessage, i: number) =>
            // 'blueprint' ctx: tool rows open against this blueprint's execution
            // track in the drawer mounted at the bottom of this view.
            renderBlueprintMessage(msg, i, avatarSize, 'blueprint', blueprintId)
          )}
        </div>
      )}
    </div>
  )
}
