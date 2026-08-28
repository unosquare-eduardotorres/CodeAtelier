/**
 * BlueprintCodeReviewService — orchestrates the CODE-REVIEW phase (M7).
 *
 * Layer 4 of the quality stack: an adversarial, external-reviewer pass over
 * the WHOLE feature diff after BUILD settles and before VERIFY runs. The
 * reviewer sees the diff and the workspace conventions, NOT the builders'
 * reasoning — it judges the code, not the story about the code.
 *
 * One-shot, same shape as BlueprintReviewService: fresh AgentSessionService,
 * goal-condition enforced, structured findings artifact, then advance to
 * VERIFY (mirroring build→verify). Findings at/above the severity threshold
 * become R-prefixed fix tasks dispatched through the existing build machinery
 * (one fix wave), after which the diff is re-reviewed ONCE. Findings that
 * survive the re-review are recorded as unverified ledger entries — they
 * never block the pipeline.
 *
 * Optional layer: when no model is bound to `blueprint:code-review`,
 * BlueprintService.settleOptionalPhases() marks the phase record `skipped` and
 * the pipeline goes build → verify directly (see finalizeSuccess wiring).
 */

import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import log from 'electron-log'
import type { StreamChunk } from './agent-base.service'
import type { AgentStatus } from '../../shared/types'
import { forwardBlueprintChunk } from './blueprint-chunk-forwarder'
import {
  PhaseActivityWatchdog,
  STALL_TIMEOUT_MS,
  wireAskUserAutoResponder
} from './blueprint-phase-watchdog'
import { AgentSessionService } from './agent-session.service'
import { BlueprintCodeReviewAdapter } from './role-adapters/blueprint/blueprint-code-review.adapter'
import { buildCodeReviewGoalCondition } from './blueprint-goal-conditions'
import { parsePhaseCompletionBlock } from './blueprint-artifact-parsers'
import { blueprintService } from './blueprint.service'
import { modelConfigService } from './model-config.service'
// Static import is cycle-free (verify does not import this service) and keeps
// the build→verify-style synchronous lock handoff: startVerifyPhase's sync
// prefix re-acquires the pipeline lock before this service's finally runs.
import { blueprintVerifyService } from './blueprint-verify.service'
import {
  blueprintRepository,
  blueprintPhaseRepository,
  blueprintTaskRepository
} from '../db/repositories/blueprint.repository'
import { conversationRepository } from '../db/repositories'
import type {
  BlueprintPhaseStartPayload,
  BlueprintPhaseCompletePayload,
  BlueprintPhaseArtifactPayload,
  BlueprintPhaseCompletion
} from '../../shared/blueprint-types'
import type { UnverifiedItem } from '../../shared/gate-types'

const bpLog = log.scope('blueprint-code-review')

const PHASE_TIMEOUT_MS = 30 * 60_000 // 30 min

/** Whole-diff cap. A diff beyond this is summarized, not shipped raw. */
const MAX_DIFF_CHARS = 120_000

/** Findings at or above this severity become fix tasks. */
const FIX_TASK_SEVERITIES = new Set(['critical', 'high'])

/** Hard bound on fix tasks per review round — a review that finds more than
 * this is describing a rewrite, not a review. */
const MAX_FIX_TASKS = 10

export interface CodeReviewFinding {
  file: string
  line?: number
  severity: 'critical' | 'high' | 'medium' | 'low'
  summary: string
  suggestedFix?: string
}

export interface CodeReviewResult {
  findings: CodeReviewFinding[]
  verdict: 'approve' | 'fix_required' | 'concerns_noted'
}

/** Parse the structured findings out of a completion block (defensive). */
export function parseCodeReviewFindings(
  completion: Record<string, unknown> | null
): CodeReviewResult | null {
  if (!completion) return null
  const raw = completion.findings
  if (!Array.isArray(raw)) return null

  const findings: CodeReviewFinding[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const f = item as Record<string, unknown>
    const file = typeof f.file === 'string' ? f.file : ''
    const summary = typeof f.summary === 'string' ? f.summary : ''
    if (!file || !summary) continue
    const severity = String(f.severity ?? 'medium').toLowerCase()
    findings.push({
      file,
      ...(typeof f.line === 'number' ? { line: f.line } : {}),
      severity: (['critical', 'high', 'medium', 'low'].includes(severity)
        ? severity
        : 'medium') as CodeReviewFinding['severity'],
      summary,
      ...(typeof f.suggestedFix === 'string' && f.suggestedFix
        ? { suggestedFix: f.suggestedFix }
        : {})
    })
  }

  const verdictRaw = String(completion.verdict ?? '').toLowerCase()
  const verdict = (['approve', 'fix_required', 'concerns_noted'].includes(verdictRaw)
    ? verdictRaw
    : findings.some((x) => FIX_TASK_SEVERITIES.has(x.severity))
      ? 'fix_required'
      : 'concerns_noted') as CodeReviewResult['verdict']

  return { findings, verdict }
}

/** Run a git subcommand in the workspace (sync, best-effort). */
function gitSync(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024
    })
  } catch {
    return null
  }
}

export class BlueprintCodeReviewService extends EventEmitter {
  // BP-PHASE-RAW-EMIT-01: Error-isolated emit prevents listener throws from
  // crashing the pipeline. Mirrors safeEmit() in the other phase services.
  private safeEmit(event: string, payload: unknown): boolean {
    try {
      return this.emit(event, payload)
    } catch (err) {
      bpLog.error(`[safeEmit] Event '${event}' listener threw:`, err)
      return false
    }
  }

  async startCodeReviewPhase(params: {
    blueprintId: string
    workspaceId: string
    workspacePath: string
  }): Promise<void> {
    const { blueprintId, workspaceId, workspacePath } = params

    bpLog.info(`[startCodeReviewPhase] Blueprint ${blueprintId} — starting CODE-REVIEW`)

    let phaseRecord = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'code-review')
    let session: AgentSessionService | null = null
    let onChunk: ((chunk: StreamChunk) => void) | null = null
    let onStatus: ((status: AgentStatus) => void) | null = null
    let cleanupAskUser: (() => void) | undefined
    let syntheticConvId: string | undefined
    // Set when a successor phase (fix-wave build, or verify) has taken over the
    // pipeline lock — this service's finally must then NOT markPipelineStopped,
    // which would destroy the successor's AbortController mid-flight (same
    // pattern as BP-BUILD-VERIFY-STARTLOCK-COLLISION in the build service).
    let lockHandedOff = false

    try {
      // 1. Pipeline + DB state
      blueprintService.markPipelineRunning(workspaceId, blueprintId, 'code-review')

      if (phaseRecord) {
        blueprintPhaseRepository.updateStatus(phaseRecord.id, 'active')
      } else {
        phaseRecord = blueprintPhaseRepository.create({ blueprintId, phase: 'code-review' })
        blueprintPhaseRepository.updateStatus(phaseRecord.id, 'active')
      }

      blueprintRepository.updateStatus(blueprintId, 'codeReviewing')
      blueprintRepository.update(blueprintId, { currentPhase: 'code-review' })

      // 2. Assemble the whole-feature diff (the reviewer's primary input)
      const diff = this.assembleFeatureDiff(blueprintId, workspacePath)
      if (diff === null) {
        // No git baseline → nothing to review. Record honestly and advance.
        bpLog.warn(
          `[startCodeReviewPhase] Blueprint ${blueprintId} — no diff could be assembled; recording unverifiable and advancing`
        )
        const ledgerItem: UnverifiedItem = {
          taskId: 'CR',
          gate: 'code-review',
          reason: 'no_git',
          detail: 'feature diff could not be assembled (no baseline commit)',
          at: new Date().toISOString()
        }
        blueprintRepository.appendUnverified(blueprintId, [ledgerItem])
        if (phaseRecord) {
          blueprintPhaseRepository.appendArtifact(phaseRecord.id, {
            type: 'code-review',
            contentJson: {
              findings: [],
              verdict: 'concerns_noted',
              note: 'diff unavailable — review not performed'
            }
          })
          blueprintPhaseRepository.updateStatus(phaseRecord.id, 'complete')
        }
        lockHandedOff = this.advanceToVerify(blueprintId, workspaceId, workspacePath)
        return
      }

      // 3. Phase context (spec/plan/build artifacts per PHASE_ARTIFACT_RELEVANCE)
      const phaseContext = await blueprintService.assemblePhaseContext(
        blueprintId,
        'code-review',
        workspacePath
      )

      // 4. Adapter + session
      const adapter = new BlueprintCodeReviewAdapter({
        workspaceId,
        blueprintId,
        phaseContext,
        diff
      })
      const blueprint = blueprintService.getBlueprint(blueprintId)
      adapter.setGoalCondition(
        buildCodeReviewGoalCondition(blueprint?.title ?? 'Unknown'),
        'enforce'
      )

      session = new AgentSessionService(adapter)

      // 5. Emit phaseStart
      this.safeEmit('phaseStart', {
        blueprintId,
        workspaceId,
        phase: 'code-review',
        goal: buildCodeReviewGoalCondition(blueprint?.title ?? 'Unknown')
      } satisfies BlueprintPhaseStartPayload)

      // 6. Streaming + watchdog (same wiring as REVIEW)
      const stallWatchdog = new PhaseActivityWatchdog(STALL_TIMEOUT_MS, 'CODE-REVIEW')

      onChunk = (chunk: StreamChunk): void => {
        stallWatchdog.touch()
        forwardBlueprintChunk((event, payload) => this.safeEmit(event, payload), chunk, {
          blueprintId,
          workspaceId,
          phase: 'code-review',
          workspacePath,
          mode: 'plan'
        })
      }
      onStatus = (status: AgentStatus): void => {
        this.safeEmit('status', { workspaceId, status })
      }
      session.on('chunk', onChunk)
      session.on('statusUpdate', onStatus)

      // Non-interactive phase — auto-respond to ask_user calls.
      cleanupAskUser = wireAskUserAutoResponder(session, 'CODE-REVIEW')

      // 7. Start session + conversation reuse (same pattern as REVIEW)
      await session.start(workspacePath, 'plan')

      const priorConvId = phaseRecord?.conversationId
      if (priorConvId && conversationRepository.getSessionId(priorConvId)) {
        const priorConv = conversationRepository.findById(priorConvId)
        const currentProvider = modelConfigService.getProvider(workspacePath)
        if (priorConv?.llmProvider === currentProvider) {
          syntheticConvId = priorConvId
        } else {
          syntheticConvId = `blueprint-code-review-${blueprintId}-${Date.now()}`
        }
      } else {
        syntheticConvId = `blueprint-code-review-${blueprintId}-${Date.now()}`
      }

      if (phaseRecord) {
        try {
          blueprintPhaseRepository.setConversation(phaseRecord.id, syntheticConvId)
        } catch {
          /* conversation may not exist yet in DB */
        }
      }

      // 8. Timeout + abort race
      let timeoutId: NodeJS.Timeout | undefined
      const timeoutPromise = new Promise<void>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('CODE-REVIEW phase timeout')),
          PHASE_TIMEOUT_MS
        )
      })

      const abortSignal = blueprintService.getAbortSignal(workspaceId)
      const abortPromise = new Promise<void>((_, reject) => {
        const onAbort = (): void => reject(new Error('Phase cancelled'))
        abortSignal?.addEventListener('abort', onAbort, { once: true })
        if (abortSignal?.aborted) onAbort()
      })

      const sendPromise = session.send(adapter.getPhaseMessage(), syntheticConvId)

      try {
        await Promise.race([sendPromise, timeoutPromise, abortPromise, stallWatchdog.promise])
      } finally {
        if (timeoutId) clearTimeout(timeoutId)
        stallWatchdog.dispose()
      }

      // 9. Parse findings
      const text = session.getStreamedContent(syntheticConvId)
      const completion = parsePhaseCompletionBlock(text, 'code-review')
      const review = parseCodeReviewFindings(
        (completion as unknown as Record<string, unknown>) ?? null
      ) ?? { findings: [], verdict: 'concerns_noted' as const }

      // 10. Persist the findings artifact
      if (phaseRecord) {
        blueprintPhaseRepository.appendArtifact(phaseRecord.id, {
          type: 'code-review',
          contentMd: text,
          contentJson: { findings: review.findings, verdict: review.verdict }
        })
        blueprintPhaseRepository.setConversation(phaseRecord.id, syntheticConvId)
        blueprintPhaseRepository.updateStatus(phaseRecord.id, 'complete')
        if (phaseRecord.contextSnapshot) {
          blueprintPhaseRepository.saveContextSnapshot(phaseRecord.id, null)
        }
      }

      bpLog.info(
        `[startCodeReviewPhase] Blueprint ${blueprintId} — review complete: ` +
          `${review.findings.length} finding(s), verdict ${review.verdict}`
      )

      this.safeEmit('phaseComplete', {
        blueprintId,
        workspaceId,
        phase: 'code-review',
        status: 'complete',
        completion: {
          phase: 'code-review',
          status: 'complete',
          findings: review.findings,
          verdict: review.verdict
        } as BlueprintPhaseCompletion
      } satisfies BlueprintPhaseCompletePayload)

      if (phaseRecord) {
        this.safeEmit('phaseArtifact', {
          blueprintId,
          workspaceId,
          phase: 'code-review',
          artifact: {
            type: 'code-review',
            contentJson: { findings: review.findings, verdict: review.verdict }
          }
        } satisfies BlueprintPhaseArtifactPayload)
      }

      // 11. Findings → fix tasks (M7.3). One fix wave, then re-review once.
      // When the fix wave is dispatched, the build service takes over the
      // pipeline lock and this invocation ends (the fix build's finalizeSuccess
      // re-enters this service for the re-review).
      const fixWaveDispatched = await this.dispatchFixTasksAndRereview({
        blueprintId,
        workspaceId,
        workspacePath,
        review
      })

      if (fixWaveDispatched) {
        lockHandedOff = true
        return
      }

      // 12. Advance to VERIFY (mirrors build→verify)
      lockHandedOff = this.advanceToVerify(blueprintId, workspaceId, workspacePath)
    } catch (err) {
      bpLog.error(`[startCodeReviewPhase] CODE-REVIEW phase failed:`, err)

      const currentStatus = blueprintRepository.findById(blueprintId)?.status
      if (currentStatus !== 'cancelled') {
        if (phaseRecord) {
          blueprintPhaseRepository.updateStatus(phaseRecord.id, 'failed')
        }
        blueprintRepository.updateStatus(blueprintId, 'failed')
      }

      const partialText = session?.getStreamedContent(syntheticConvId)
      if (partialText && phaseRecord) {
        blueprintPhaseRepository.appendArtifact(phaseRecord.id, {
          type: 'code-review-partial',
          contentMd: partialText
        })
      }

      const errorMsg = err instanceof Error ? err.message : String(err)
      blueprintService.failPipeline(workspaceId, errorMsg)

      try {
        blueprintService.saveRetryContext(blueprintId, 'code-review', { error: errorMsg })
      } catch {
        /* best effort */
      }

      const autoRetrying = blueprintService.scheduleAutoRetry({
        blueprintId,
        workspaceId,
        workspacePath,
        phase: 'code-review',
        error: errorMsg
      })

      this.safeEmit('phaseComplete', {
        blueprintId,
        workspaceId,
        phase: 'code-review',
        status: 'failed',
        error: errorMsg,
        ...(autoRetrying ? { autoRetry: true } : {})
      } satisfies BlueprintPhaseCompletePayload)
    } finally {
      cleanupAskUser?.()
      if (session) {
        if (onChunk) session.removeListener('chunk', onChunk)
        if (onStatus) session.removeListener('statusUpdate', onStatus)
        await session.stop()
      }
      // Only release the pipeline lock when no successor took it over — the
      // successor's own finally owns markPipelineStopped from that point.
      if (!lockHandedOff) {
        blueprintService.markPipelineStopped(workspaceId)
      }
    }
  }

  // ── Diff assembly ──

  /**
   * M7.1 — whole-feature diff: `git diff <baseline>..HEAD` where the baseline
   * is the run's starting commit. Stored on the blueprint record at build
   * start (settingsJson.buildBaselineCommit, captured by startBuildPhase);
   * falls back to a merge-base against main.
   */
  private assembleFeatureDiff(blueprintId: string, workspacePath: string): string | null {
    const blueprint = blueprintRepository.findById(blueprintId)
    if (!blueprint) return null

    const settings = (blueprint.settingsJson ?? {}) as Record<string, unknown>
    let baseline: string | null =
      typeof settings.buildBaselineCommit === 'string' ? settings.buildBaselineCommit : null

    if (!baseline) {
      // Fallback: merge-base with the default branch — the diff since the
      // blueprint's branch diverged. Better than nothing; recorded as such.
      const mb = gitSync(['merge-base', 'HEAD', 'main'], workspacePath)
      baseline = mb?.trim() || null
    }

    if (!baseline) return null

    const diff = gitSync(['diff', '--no-color', `${baseline}..HEAD`, '--'], workspacePath)
    if (diff === null) return null
    if (diff.trim() === '') return '' // clean tree — nothing built? still reviewable as empty
    return diff.length > MAX_DIFF_CHARS
      ? diff.slice(0, MAX_DIFF_CHARS) + '\n… (diff truncated for review)'
      : diff
  }

  // ── M7.3: findings → fix tasks + one re-review ──

  /**
   * Findings at/above the threshold become R-prefixed fix tasks appended after
   * the build tasks (BP-COLLISION-SAFE-RENUMBER), dispatched as ONE fix wave
   * through the existing build machinery, then the diff is re-reviewed ONCE.
   * Findings that survive land in the unverified ledger — never block.
   *
   * Returns true when a fix wave was dispatched (the build service then owns
   * the pipeline lock; the caller must skip its own advance/finally cleanup).
   */
  private async dispatchFixTasksAndRereview(params: {
    blueprintId: string
    workspaceId: string
    workspacePath: string
    review: CodeReviewResult
  }): Promise<boolean> {
    const { blueprintId, workspaceId, workspacePath, review } = params

    const fixable = review.findings.filter((f) => FIX_TASK_SEVERITIES.has(f.severity))
    if (fixable.length === 0) return false

    // Re-review bound: only one fix round. A second fix_required verdict after
    // the re-review goes to the ledger, not back into the loop.
    const settings = (blueprintRepository.findById(blueprintId)?.settingsJson ?? {}) as Record<
      string,
      unknown
    >
    if (settings.codeReviewFixRound) {
      bpLog.info(
        `[code-review] Blueprint ${blueprintId} — fix round already ran; recording ${fixable.length} surviving finding(s) as unverified`
      )
      this.recordSurvivingFindings(blueprintId, fixable)
      return false
    }

    // BP-COLLISION-SAFE-RENUMBER: R-task IDs continue after any existing R-tasks.
    const existing = blueprintTaskRepository.findByBlueprint(blueprintId)
    const maxExistingR = existing
      .filter((t) => /^R\d+$/.test(t.taskId))
      .reduce((max, t) => Math.max(max, parseInt(t.taskId.slice(1), 10)), 0)
    const maxWave = existing.reduce((max, t) => Math.max(max, t.wave), 0)

    const fixTasks = fixable.slice(0, MAX_FIX_TASKS).map((f, i) => ({
      taskId: `R${String(maxExistingR + 1 + i).padStart(3, '0')}`,
      wave: maxWave + 1,
      description:
        `[code-review fix] ${f.severity}: ${f.summary}` +
        (f.suggestedFix ? `\nSuggested fix: ${f.suggestedFix}` : '') +
        `\nFile: ${f.file}${f.line ? `:${f.line}` : ''}`,
      filePathsJson: [f.file]
    }))

    blueprintTaskRepository.createBulk(blueprintId, fixTasks)
    blueprintRepository.update(blueprintId, {
      settingsJson: { ...settings, codeReviewFixRound: 1 }
    })

    this.safeEmit('phaseProgress', {
      blueprintId,
      workspaceId,
      phase: 'code-review',
      text: `Code review: ${fixTasks.length} fix task(s) created — dispatching fix wave`,
      kind: 'system'
    })

    // Dispatch ONE fix wave through the existing build machinery. The build
    // service re-runs only pending tasks (BP-RESUME-01) and its completion
    // re-enters finalizeSuccess → code-review (this service) for the re-review.
    //
    // Lock handoff: release this phase's pipeline lock first — the build
    // service's markPipelineRunning throws unless the machine is idle (same
    // BP-BUILD-VERIFY-STARTLOCK-COLLISION pattern). The build service's own
    // finally then owns markPipelineStopped from this point.
    try {
      const { blueprintBuildService } = await import('./blueprint-build.service')
      blueprintService.markPipelineStopped(workspaceId)
      await blueprintBuildService.startBuildPhase({
        blueprintId,
        workspaceId,
        workspacePath
      })
      return true
    } catch (err) {
      bpLog.error(`[code-review] Fix wave dispatch failed for ${blueprintId}:`, err)
      this.recordSurvivingFindings(blueprintId, fixable)
      return false
    }
  }

  /** Findings that survived the fix round → unverified ledger (never block). */
  private recordSurvivingFindings(blueprintId: string, findings: CodeReviewFinding[]): void {
    if (findings.length === 0) return
    const items: UnverifiedItem[] = findings.map((f) => ({
      taskId: 'CR',
      gate: 'code-review',
      reason: 'finding_unresolved',
      detail: `${f.severity}: ${f.summary} (${f.file}${f.line ? `:${f.line}` : ''})`,
      at: new Date().toISOString()
    }))
    blueprintRepository.appendUnverified(blueprintId, items)
    bpLog.info(
      `[code-review] Blueprint ${blueprintId} — ${items.length} finding(s) recorded as unverified`
    )
  }

  // ── Advance ──

  /**
   * Advance to VERIFY (mirrors build→verify in finalizeSuccess).
   * Returns true when verify took over the pipeline lock (caller's finally
   * must then skip markPipelineStopped).
   */
  private advanceToVerify(
    blueprintId: string,
    workspaceId: string,
    workspacePath: string
  ): boolean {
    bpLog.info(
      `[code-review] Blueprint ${blueprintId} — code-review complete, advancing to VERIFY`
    )
    try {
      // BP-BUILD-VERIFY-STARTLOCK-COLLISION pattern: release this phase's lock
      // before verify re-acquires it, then hand ownership to verify's finally.
      blueprintService.markPipelineStopped(workspaceId)
      blueprintVerifyService
        .startVerifyPhase({
          blueprintId,
          workspaceId,
          workspacePath
        })
        .catch((err) => {
          bpLog.error('[code-review→verify] Verify phase failed:', err)
          const errorMsg = err instanceof Error ? err.message : String(err)
          blueprintService.failPipeline(workspaceId, errorMsg)
          blueprintRepository.updateStatus(blueprintId, 'failed')
        })
      return true
    } catch (syncErr) {
      bpLog.error('[code-review→verify] Verify startup failed (sync):', syncErr)
      const errorMsg = syncErr instanceof Error ? syncErr.message : String(syncErr)
      blueprintService.failPipeline(workspaceId, errorMsg)
      blueprintRepository.updateStatus(blueprintId, 'failed')
      return false
    }
  }

  /** One-shot — no session map to clean up. */
  async cancelBlueprint(_blueprintId: string): Promise<void> {}

  async shutdown(): Promise<void> {}
}

export const blueprintCodeReviewService = new BlueprintCodeReviewService()
