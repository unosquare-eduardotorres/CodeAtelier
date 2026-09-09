/**
 * OutcomePanel — the ONE outcome region for a blueprint run.
 *
 * Replaces six stacked sibling banners (gaps, unverified ledger, human
 * review needed, human review acknowledged, failed, stopped/interrupted)
 * plus a free-floating export row. One verdict banner leads (highest
 * precedence story), one primary action, lower-precedence facts become
 * chips, and evidence lists collapse behind <details> — impeccable focused
 * review 2026-09-09: "one verdict leads; evidence is one click deep".
 *
 * The export/follow-up actions render exactly once and are deliberately NOT
 * gated on the unverified ledger being non-empty: the most dangerous case is
 * a run whose gates all ran clean but whose tasks closed
 * `preexisting`/`accepted_by_user`, which no banner surfaces.
 */

import { useState, useMemo, type JSX } from 'react'
import {
  RotateCcw,
  PlayCircle,
  Download,
  Lightbulb,
  UserCheck,
  ChevronDown
} from 'lucide-react'
import type { BlueprintWithDetails } from '../../../../../../shared/blueprint-types'
import { formatPhaseLabel } from '../../../../../../shared/blueprint-types'
import { summarizeLedger, blueprintOutcome } from '../../../../../../shared/gate-types'
import { readJiraSyncLog } from '../../../../../../shared/jira.types'
import { useBlueprintStore } from '@renderer/store/blueprint.store'
import { formatTimeAgo } from '../utils'
import { findArtifact } from '../deliverables/artifact-helpers'
import { getFailureStory, getOutcomeStats, failedPhaseLabel } from './phase-summaries'
import { Banner } from './primitives'
import { TestabilityFollowUpDialog } from './TestabilityFollowUpDialog'

// Mid-pipeline statuses (orphaned — pipeline not running)
const MID_PIPELINE_STATUSES = new Set([
  'specifying',
  'clarifying',
  'planning',
  'tasking',
  'reviewing',
  'building',
  'verifying'
])

// ── Jira write-back summary (moved here from the detail view's block pile) ──

function JiraSyncNote({ settings }: { settings: Record<string, unknown> }): JSX.Element | null {
  const entries = Object.values(readJiraSyncLog(settings))
  if (entries.length === 0) return null
  return (
    <div className="border-t border-border-subtle px-4 py-3 space-y-1" data-testid="blueprint-jira-sync">
      {entries.map((entry) => {
        const target = entry.intent === 'done' ? 'Done' : 'In Progress'
        return (
          <div key={entry.intent} className="space-y-0.5">
            {entry.moved.length > 0 && (
              <p className="text-xs text-text-secondary">
                Jira: moved {entry.moved.join(', ')} to {target}
              </p>
            )}
            {(entry.commented?.length ?? 0) > 0 && (
              <p className="text-xs text-text-secondary">
                Jira: commented on {entry.commented?.join(', ')} — status left unchanged because
                checks could not be verified
              </p>
            )}
            {entry.skipped.length > 0 && (
              <p className="text-xs text-text-muted">
                Jira: {entry.skipped.join(', ')} skipped — workflow offers no {target} transition
              </p>
            )}
            {entry.failed.map((failure) => (
              <p key={failure.key} className="text-xs text-warning">
                Jira: {failure.key} could not be moved to {target}: {failure.error}
              </p>
            ))}
          </div>
        )
      })}
    </div>
  )
}

// ── Collapsible evidence group ──

function EvidenceGroup({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <details className="group border-t border-border-subtle">
      <summary className="flex items-center gap-2 px-4 py-2.5 cursor-pointer text-xs text-text-secondary hover:text-text-primary transition-colors select-none">
        <ChevronDown
          size={12}
          className="text-text-muted transition-transform group-open:rotate-180"
        />
        {label}
      </summary>
      <div className="px-4 pb-3">{children}</div>
    </details>
  )
}

// ── Main ──

export function OutcomePanel({
  bp,
  isRunning,
  lastError,
  onRetryPhase
}: {
  bp: BlueprintWithDetails
  isRunning: boolean
  lastError: { blueprintId: string; message: string } | null
  onRetryPhase: () => void
}): JSX.Element | null {
  const [followUpOpen, setFollowUpOpen] = useState(false)
  const isComplete = bp.status === 'complete'

  const outcomeStats = useMemo(
    () => (isComplete ? getOutcomeStats(bp.phases, bp.tasks) : null),
    [isComplete, bp.phases, bp.tasks]
  )
  const failureStory = useMemo(
    () => (bp.status === 'failed' ? getFailureStory(bp, lastError) : null),
    [bp, lastError]
  )

  const unverified = bp.unverifiedJson ?? []
  const isGapsFound = isComplete && outcomeStats?.verifyStatus === 'gaps_found'
  const humanNeeded = isComplete && outcomeStats?.verifyStatus === 'human_needed'
  const humanAcked = humanNeeded && outcomeStats?.humanReviewAcknowledged === true

  const humanVerificationItems = useMemo(() => {
    if (!humanNeeded || outcomeStats?.humanReviewAcknowledged) return []
    const verifyPhase = bp.phases.find((p) => p.phase === 'verify')
    if (!verifyPhase) return []
    const art = findArtifact(verifyPhase.artifactsJson, 'verify', 'verification')
    const json = art?.contentJson as Record<string, unknown> | undefined
    return (json?.humanVerificationNeeded as string[]) ?? []
  }, [humanNeeded, outcomeStats, bp.phases])

  const isCancelled = bp.status === 'cancelled'
  const isInterrupted = MID_PIPELINE_STATUSES.has(bp.status) && !isRunning

  if (bp.status === 'draft') return null

  const isFailed = failureStory?.failedPhase != null

  // ── Resolve the ONE leading verdict, in precedence order ──
  let verdict: JSX.Element | null = null

  if (isFailed && failureStory) {
    const { context, errorMsg, failedPhase } = failureStory
    const isSoft = context?.isGaps || context?.isEnvironmental
    verdict = (
      <Banner
        tone={isSoft ? 'warning' : 'danger'}
        title={context?.title ?? `${formatPhaseLabel(failedPhase!.phase)} phase failed`}
        testId="blueprint-failed-banner"
        actions={
          <div className="flex flex-col items-end gap-1">
            <button
              onClick={onRetryPhase}
              disabled={context?.isEnvironmental === true}
              title={
                context?.isEnvironmental
                  ? 'Retry is disabled: this failure is environmental and deterministic — retrying cannot change it'
                  : undefined
              }
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-on-accent rounded-lg transition-colors flex-shrink-0 ${
                context?.isEnvironmental
                  ? 'bg-text-muted opacity-50 cursor-not-allowed'
                  : context?.isGaps
                    ? 'bg-warning hover:bg-warning/80'
                    : 'bg-danger hover:bg-danger/80'
              }`}
            >
              <RotateCcw size={12} />
              {context?.isGaps ? 'Fix Gaps' : 'Retry'}
            </button>
            {/* F4 — recovery path: the disable breaks the blind-retry loop,
                but the user who HAS remediated must still be able to retry. */}
            {context?.isEnvironmental && (
              <button
                type="button"
                onClick={onRetryPhase}
                className="text-[10px] underline underline-offset-2 opacity-70 hover:opacity-100 transition-opacity"
              >
                I&apos;ve fixed it — retry anyway
              </button>
            )}
          </div>
        }
      >
        <span className="text-xs opacity-80">
          {context?.description ?? errorMsg ?? 'An error occurred during this phase. Retry to try again.'}
        </span>
        {context?.isEnvironmental && (
          <span className="text-[11px] opacity-70 leading-relaxed">
            Retrying cannot fix this — the failure is on this machine, not in the code. Install the
            missing tool (or make sure it is on PATH), or declare a fenced{' '}
            <code className="mx-1 px-1 py-0.5 rounded bg-warning/10 font-mono text-[10px]">
              gate-commands
            </code>{' '}
            block in the plan artifact to override detection. Then retry.
          </span>
        )}
      </Banner>
    )
  } else if (isGapsFound) {
    verdict = (
      <Banner
        tone="warning"
        title="Gaps Found During Verification"
        actions={
          <button
            onClick={onRetryPhase}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-on-accent bg-warning hover:bg-warning/80 rounded-lg transition-colors flex-shrink-0"
          >
            <RotateCcw size={12} />
            Fix Gaps
          </button>
        }
      >
        <span className="text-xs opacity-80">
          The verifier identified issues that need fixing. Retry to generate fix tasks and rebuild.
        </span>
      </Banner>
    )
  } else if (humanNeeded && !humanAcked) {
    verdict = (
      <Banner
        tone="accent"
        title="Human Review Needed"
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => useBlueprintStore.getState().acknowledgeReview(bp.id)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-on-accent bg-success hover:bg-success/80 rounded-lg transition-colors"
            >
              <UserCheck size={12} />
              Mark as Verified
            </button>
            <button
              onClick={onRetryPhase}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-on-accent bg-accent hover:bg-accent/80 rounded-lg transition-colors"
            >
              <RotateCcw size={12} />
              Re-verify
            </button>
          </div>
        }
      >
        <span className="text-xs opacity-80">
          The verifier flagged items that require manual verification before shipping.
        </span>
      </Banner>
    )
  } else if (unverified.length > 0) {
    verdict = (
      <Banner
        tone="warning"
        testId="blueprint-unverified-banner"
        title={`${blueprintOutcome(bp) === 'complete-unproven' ? 'Finished UNPROVEN' : 'Unproven so far'} — ${unverified.length} check${unverified.length > 1 ? 's' : ''} could not be verified (${Object.entries(summarizeLedger(unverified).byGate)
          .map(([gate, n]) => `${gate} ×${n}`)
          .join(', ')})`}
      >
        <span className="text-xs text-text-muted">
          These checks never executed, so nothing was verified for them. They never blocked the run —
          they are recorded so the gap is visible.
          {blueprintOutcome(bp) === 'incomplete' && ' This run is still open, so later phases may add more.'}
        </span>
      </Banner>
    )
  } else if (isCancelled) {
    verdict = (
      <Banner
        tone="info"
        title="Stopped"
        actions={
          <button
            onClick={onRetryPhase}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-on-accent bg-info hover:bg-info/80 rounded-lg transition-colors flex-shrink-0"
          >
            <PlayCircle size={12} />
            Resume
          </button>
        }
      >
        <span className="text-xs opacity-80">
          Resume to continue from the {failedPhaseLabel(bp)} phase.
        </span>
      </Banner>
    )
  } else if (isInterrupted) {
    verdict = (
      <Banner
        tone="info"
        title="Interrupted"
        actions={
          <button
            onClick={onRetryPhase}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-on-accent bg-info hover:bg-info/80 rounded-lg transition-colors flex-shrink-0"
          >
            <PlayCircle size={12} />
            Resume
          </button>
        }
      >
        <span className="text-xs opacity-80">
          This blueprint was interrupted during the {failedPhaseLabel(bp)} phase. Resume to continue.
        </span>
      </Banner>
    )
  } else if (humanAcked) {
    verdict = (
      <Banner tone="success" title="Human review completed">
        <span className="text-xs opacity-80">
          {outcomeStats?.acknowledgedAt
            ? `Acknowledged ${formatTimeAgo(new Date(outcomeStats.acknowledgedAt))}`
            : 'All flagged items verified.'}
        </span>
      </Banner>
    )
  }

  const hasEvidence =
    unverified.length > 0 || humanVerificationItems.length > 0 || (failureStory?.failedTaskList?.shown.length ?? 0) > 0

  return (
    <div className="bg-surface-raised rounded-xl border border-border-subtle overflow-hidden space-y-0">
      {verdict}

      {/* Lower-precedence facts as chips, not sibling banners */}
      {!isFailed && !isGapsFound && (unverified.length > 0 || humanNeeded) && isComplete && (
        <div className="flex flex-wrap gap-2 px-4 pt-3">
          {humanAcked && unverified.length === 0 && (
            <span className="text-[11px] text-success">Human review acknowledged</span>
          )}
        </div>
      )}

      {/* Evidence — one click deep */}
      {hasEvidence && (
        <div className={verdict ? 'pt-1' : 'pt-3'}>
          {failureStory && (failureStory.failedTaskList?.shown.length ?? 0) > 0 && (
            <EvidenceGroup
              label={`Failed tasks — persisted reasons (${failureStory.failedTaskList!.shown.length + failureStory.failedTaskList!.hiddenCount})`}
            >
              <ul className="flex flex-col gap-2 text-danger">
                {failureStory.taskDisplays.map(({ task, display }) => (
                  <li key={task.taskId} className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-mono font-semibold">{display.title}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-danger/15 border border-danger/25">
                        {display.attempts} attempt{display.attempts === 1 ? '' : 's'}
                      </span>
                    </div>
                    <span className="text-xs opacity-80">{display.hint}</span>
                    {display.missingFiles.length > 0 && (
                      <span className="text-[11px] opacity-60 font-mono">
                        missing: {display.missingFiles.join(', ')}
                        {(() => {
                          const total = (task.filePathsJson ?? []).length
                          return display.missingFiles.length >= 3 && total > 3
                            ? ` (+${total - display.missingFiles.length} more)`
                            : ''
                        })()}
                      </span>
                    )}
                  </li>
                ))}
                {failureStory.failedTaskList!.hiddenCount > 0 && (
                  <li className="text-[11px] opacity-60">
                    +{failureStory.failedTaskList!.hiddenCount} more failed task
                    {failureStory.failedTaskList!.hiddenCount === 1 ? '' : 's'}
                  </li>
                )}
              </ul>
            </EvidenceGroup>
          )}
          {unverified.length > 0 && (
            <EvidenceGroup label={`Unverified checks (${unverified.length})`}>
              <div className="space-y-1.5">
                {unverified.map((item, i) => (
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
            </EvidenceGroup>
          )}
          {humanVerificationItems.length > 0 && (
            <EvidenceGroup label={`Manual verification items (${humanVerificationItems.length})`}>
              <div className="space-y-1.5">
                {humanVerificationItems.map((item, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className="text-accent/60 mt-0.5 text-xs">▸</span>
                    <span className="text-xs text-text-secondary">{item}</span>
                  </div>
                ))}
              </div>
            </EvidenceGroup>
          )}
        </div>
      )}

      {/* Actions — exactly one location for the export pair */}
      <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border-subtle">
        <button
          type="button"
          data-testid="blueprint-export-testability"
          onClick={() => {
            void window.api.blueprintExportTestability({ blueprintId: bp.id }).catch(() => undefined)
          }}
          className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary"
          title="Export the list of tasks and checks this blueprint never proved, as Markdown"
        >
          <Download size={13} />
          Export testability ledger
        </button>
        <button
          type="button"
          data-testid="blueprint-followup-ideas"
          onClick={() => setFollowUpOpen(true)}
          className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary"
          title="Create one idea per unproven item, so the gap becomes scheduled work"
        >
          <Lightbulb size={13} />
          Create follow-up ideas
        </button>
      </div>

      <JiraSyncNote settings={bp.settingsJson} />

      {followUpOpen && (
        <TestabilityFollowUpDialog
          blueprintId={bp.id}
          blueprintTitle={bp.title}
          onClose={() => setFollowUpOpen(false)}
        />
      )}
    </div>
  )
}
