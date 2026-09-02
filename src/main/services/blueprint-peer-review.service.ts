/**
 * BlueprintPeerReviewService — per-task advisory peer review (M5).
 *
 * Layer 3: after a build task's deterministic gates PASS, one cheap-model
 * session reviews the task diff against its work packet. The gates prove the
 * task did what it said (tests red→green, write-set respected); the peer
 * checks the inverse — what the packet said that the diff did not do.
 *
 * Advisory only, exactly one round (PEER_REVIEW_MAX_ROUNDS = 1):
 *   - findings become ONE fix attempt appended to the task's retry ladder
 *     (the builder re-runs with the findings as fix instructions — not a new
 *     wave, not a loop)
 *   - findings that survive the fix attempt are recorded to the unverified
 *     ledger (gate `peer-review`, reason `finding_unresolved`) — never block
 *
 * Gated by the optional role `blueprint:peer-review` (off unless bound):
 * callers check `modelConfigService.isRoleEnabled` before dispatching, so an
 * unbound workspace pays nothing.
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
import { BlueprintPeerReviewAdapter } from './role-adapters/blueprint/blueprint-peer-review.adapter'
import { buildPeerReviewGoalCondition } from './blueprint-goal-conditions'
import { parsePeerReview } from '../../shared/blueprint-artifact-parsers'
import type { PeerReviewResult, ReviewFinding } from '../../shared/task-review-types'
import { blueprintService } from './blueprint.service'
import { blueprintRepository } from '../db/repositories/blueprint.repository'
import type { BlueprintTask } from '../../shared/blueprint-types'
import type { UnverifiedItem } from '../../shared/gate-types'

const bpLog = log.scope('blueprint-peer-review')

const PASS_TIMEOUT_MS = 10 * 60_000 // 10 min — cheap model, scoped diff

/** Per-task diff cap. A task diff beyond this is truncated, not shipped raw. */
const MAX_TASK_DIFF_CHARS = 60_000

export interface PeerReviewOutcome {
  /** Parsed review result (empty findings when the pass could not run). */
  review: PeerReviewResult
  /** True when the findings were handed to a fix attempt (advisory round). */
  fixDispatched: boolean
}

export class BlueprintPeerReviewService extends EventEmitter {
  // Error-isolated emit — mirrors safeEmit() in the other phase services.
  private safeEmit(event: string, payload: unknown): boolean {
    try {
      return this.emit(event, payload)
    } catch (err) {
      bpLog.error(`[safeEmit] Event '${event}' listener threw:`, err)
      return false
    }
  }

  /**
   * Run one advisory peer-review pass over a task whose gates just passed.
   *
   * Called from the build service's gate loop AFTER `report.overall !== 'fail'`
   * and only when the `blueprint:peer-review` role is enabled. The task is NOT
   * blocked by anything this method does: findings either become one fix
   * attempt (returned to the caller, which re-runs the builder with them as
   * instructions) or are recorded to the unverified ledger.
   *
   * Returns the outcome so the caller can append the fix attempt to its retry
   * ladder. The caller owns the pipeline lock throughout — this pass runs
   * inside the task's existing gate loop, not as a successor phase.
   */
  async reviewTask(params: {
    task: BlueprintTask
    blueprintId: string
    workspaceId: string
    workspacePath: string
    executionPath: string
    /** Baseline commit captured before the task's first attempt. */
    baselineCommit: string | null
    /** Files exempt from this task's diff (peers' in-flight writes). */
    exemptFiles?: readonly string[]
  }): Promise<PeerReviewOutcome> {
    const { task, blueprintId, workspaceId, workspacePath } = params
    const empty: PeerReviewOutcome = { review: { findings: [], rejected: [] }, fixDispatched: false }

    bpLog.info(`[reviewTask] Task ${task.taskId} — peer-review pass starting`)

    let session: AgentSessionService | null = null
    let onChunk: ((chunk: StreamChunk) => void) | null = null
    let onStatus: ((status: AgentStatus) => void) | null = null
    let cleanupAskUser: (() => void) | undefined
    let syntheticConvId: string | undefined

    try {
      // 1. Assemble the task-scoped diff (baseline..HEAD, write-set filtered).
      const diff = this.assembleTaskDiff(params)
      if (diff === null) {
        // No git baseline → nothing to review. Record honestly, advise nothing.
        bpLog.warn(`[reviewTask] Task ${task.taskId} — no diff could be assembled; skipping pass`)
        blueprintRepository.appendUnverified(blueprintId, [
          {
            taskId: task.taskId,
            gate: 'peer-review',
            reason: 'no_git',
            detail: 'task diff could not be assembled (no baseline commit)',
            at: new Date().toISOString()
          }
        ])
        return empty
      }

      // 2. Phase context — LITE, and deliberately so. peer-review-pass.md has no
      // {{…}} placeholders, so the full assembly's output was discarded whole;
      // all it contributed was per-task DB + doc reads and a truncate-then-write
      // over blueprints/<name>/{plan,tasks,spec,build}.md — the exact paths this
      // task's still-running wave siblings are told to Read. The reviewer's real
      // context is the diff and the work packet, both passed to the adapter.
      const phaseContext = await blueprintService.assembleLitePhaseContext(blueprintId, 'build')

      // 3. Adapter + session
      const adapter = new BlueprintPeerReviewAdapter({
        workspaceId,
        blueprintId,
        phaseContext,
        diff,
        packet: task.packetJson ?? null,
        taskDescription: task.description
      })
      adapter.setGoalCondition(
        buildPeerReviewGoalCondition(task.taskId, task.description),
        'enforce'
      )

      session = new AgentSessionService(adapter)

      // 4. Progress — the pass runs under the build umbrella.
      this.safeEmit('phaseProgress', {
        blueprintId,
        workspaceId,
        phase: 'build',
        text: `Peer review: reviewing task ${task.taskId} against its work packet`,
        kind: 'system'
      })

      // 5. Streaming + watchdog
      const stallWatchdog = new PhaseActivityWatchdog(STALL_TIMEOUT_MS, 'PEER-REVIEW')

      onChunk = (chunk: StreamChunk): void => {
        stallWatchdog.touch()
        forwardBlueprintChunk((event, payload) => this.safeEmit(event, payload), chunk, {
          blueprintId,
          workspaceId,
          phase: 'build',
          workspacePath,
          mode: 'plan'
        })
      }
      onStatus = (status: AgentStatus): void => {
        this.safeEmit('status', { workspaceId, status })
      }
      session.on('chunk', onChunk)
      session.on('statusUpdate', onStatus)

      // Non-interactive pass — auto-respond to ask_user calls.
      cleanupAskUser = wireAskUserAutoResponder(session, 'PEER-REVIEW')

      // 6. Start session
      await session.start(workspacePath, 'plan')

      syntheticConvId = `blueprint-peer-review-${task.id}-${Date.now()}`

      // 7. Timeout + abort race
      let timeoutId: NodeJS.Timeout | undefined
      const timeoutPromise = new Promise<void>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('PEER-REVIEW pass timeout')), PASS_TIMEOUT_MS)
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

      // 8. Parse findings (existing shared parser — closed 4-category rubric,
      // off-rubric and non-actionable findings rejected with a reason).
      const text = session.getStreamedContent(syntheticConvId)
      const review = parsePeerReview(text)

      bpLog.info(
        `[reviewTask] Task ${task.taskId} — pass complete: ${review.findings.length} finding(s)` +
          ` (${review.rejected.length} rejected as off-rubric)`
      )

      this.safeEmit('phaseProgress', {
        blueprintId,
        workspaceId,
        phase: 'build',
        text:
          review.findings.length === 0
            ? `Peer review: task ${task.taskId} clean — no findings`
            : `Peer review: task ${task.taskId} — ${review.findings.length} finding(s)` +
              ` (${review.rejected.length} rejected as off-rubric)`,
        kind: 'system'
      })

      // 9. Advisory round: findings → ONE fix attempt (the caller appends it to
      // the task's retry ladder). Survivors are ledgered by the caller after
      // the fix attempt re-runs the gates — or here when there is nothing to fix.
      if (review.findings.length === 0) return { review, fixDispatched: false }
      return { review, fixDispatched: true }
    } catch (err) {
      // The pass is advisory: a failure must not fail a task whose gates
      // passed. Record it as an unverified ledger entry and continue.
      const errorMsg = err instanceof Error ? err.message : String(err)
      bpLog.error(`[reviewTask] Peer-review pass failed for ${task.taskId}:`, errorMsg)
      blueprintRepository.appendUnverified(blueprintId, [
        {
          taskId: task.taskId,
          gate: 'peer-review',
          reason: 'pass_error',
          detail: `peer-review pass failed: ${errorMsg.slice(0, 300)}`,
          at: new Date().toISOString()
        }
      ])
      return empty
    } finally {
      cleanupAskUser?.()
      if (session) {
        if (onChunk) session.removeListener('chunk', onChunk)
        if (onStatus) session.removeListener('statusUpdate', onStatus)
        await session.stop()
      }
    }
  }

  /**
   * Findings that survived the advisory fix attempt → unverified ledger
   * (never block). Called by the build service after the fix attempt's gates
   * re-ran, with whatever findings remain unresolved.
   */
  recordSurvivingFindings(
    blueprintId: string,
    taskId: string,
    findings: ReviewFinding[]
  ): void {
    if (findings.length === 0) return
    const items: UnverifiedItem[] = findings.map((f) => ({
      taskId,
      gate: 'peer-review',
      reason: 'finding_unresolved',
      detail: `${f.category}: ${f.issue} (${f.file}${f.location ? ` ${f.location}` : ''})`,
      at: new Date().toISOString()
    }))
    blueprintRepository.appendUnverified(blueprintId, items)
    bpLog.info(
      `[peer-review] Task ${taskId} — ${items.length} finding(s) recorded as unverified`
    )
  }

  // ── Diff assembly (task-scoped, write-set filtered) ──

  /**
   * The task's diff against the baseline commit, filtered to the task's
   * write-set (packet allowedFiles ∪ declared files). Peers' in-flight writes
   * and pre-existing dirt are excluded via exemptFiles — same attribution
   * contract as the gates.
   */
  private assembleTaskDiff(params: {
    task: BlueprintTask
    executionPath: string
    baselineCommit: string | null
    exemptFiles?: readonly string[]
  }): string | null {
    const { task, executionPath, baselineCommit, exemptFiles } = params
    if (!baselineCommit) return null

    const diff = gitSync(
      ['diff', '--no-color', baselineCommit, '--'],
      executionPath
    )
    if (diff === null) return null
    if (diff.trim() === '') return ''

    // Scope to the write-set: the reviewer judges the packet's files, not the
    // whole wave's output. Untracked files in the write-set are appended —
    // they have no diff hunks.
    const writeSet = new Set(
      [...(task.packetJson?.allowedFiles ?? []), ...(task.filePathsJson ?? [])].filter(
        (f): f is string => typeof f === 'string'
      )
    )
    const exempt = new Set((exemptFiles ?? []).map((f) => f.replace(/\\/g, '/')))

    const scopedLines: string[] = []
    let inFile = false
    let kept = false
    for (const line of diff.split('\n')) {
      if (line.startsWith('+++ b/')) {
        const file = line.slice(6).replace(/\\/g, '/')
        inFile = true
        kept = writeSet.has(file) && !exempt.has(file)
      } else if (line.startsWith('diff --git')) {
        inFile = false
        kept = false
      }
      if (!inFile || kept) scopedLines.push(line)
    }
    let scoped = scopedLines.join('\n')

    // Untracked write-set files: full content additions, no diff hunks.
    const untracked = gitSync(
      ['ls-files', '--others', '--exclude-standard'],
      executionPath
    )
    if (untracked) {
      for (const rel of untracked.split('\n').map((l) => l.trim()).filter(Boolean)) {
        const norm = rel.replace(/\\/g, '/')
        if (!writeSet.has(norm) || exempt.has(norm)) continue
        scoped += `\n--- NEW FILE: ${norm} (untracked, full content follows) ---`
      }
    }

    return scoped.length > MAX_TASK_DIFF_CHARS
      ? scoped.slice(0, MAX_TASK_DIFF_CHARS) + '\n… (diff truncated for review)'
      : scoped
  }

  async cancelBlueprint(_blueprintId: string): Promise<void> {}

  async shutdown(): Promise<void> {}
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

export const blueprintPeerReviewService = new BlueprintPeerReviewService()
