/**
 * BlueprintVerifyService — orchestrates the VERIFY phase of the Blueprint pipeline.
 *
 * One-shot: creates a fresh AgentSessionService, sends the verify request,
 * parses the completion block with verification results, saves the artifact,
 * and determines the final blueprint status.
 *
 * VERIFY is the terminal phase — no approval gate, no next phase.
 *
 * Three completion outcomes:
 * - overallStatus: 'passed'       → blueprint.status = 'complete'
 * - overallStatus: 'human_needed' → blueprint.status = 'complete' (flagged)
 * - overallStatus: 'gaps_found'   → blueprint.status = 'failed'
 */

import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFile, type ExecFileException } from 'node:child_process'
import log from 'electron-log'
import type { StreamChunk } from './agent-base.service'
import type { AgentStatus } from '../../shared/types'
import { forwardBlueprintChunk } from './blueprint-chunk-forwarder'
import { PhaseActivityWatchdog, STALL_TIMEOUT_MS, wireAskUserAutoResponder } from './blueprint-phase-watchdog'
import { AgentSessionService } from './agent-session.service'
import { BlueprintVerifyAdapter } from './role-adapters/blueprint/blueprint-verify.adapter'
import { buildVerifyGoalCondition } from './blueprint-goal-conditions'
import { parsePhaseCompletionBlock, asStringArray } from './blueprint-artifact-parsers'
import { scanCompletedTaskFiles, applyDeterministicFileCheck } from './blueprint-task-verification'
import { blueprintService } from './blueprint.service'
import { modelConfigService } from './model-config.service'
import {
  blueprintRepository,
  blueprintPhaseRepository
} from '../db/repositories/blueprint.repository'
import { blueprintTaskRepository } from '../db/repositories/blueprint.repository'
import { blueprintEventRepository } from '../db/repositories/blueprint-event.repository'
import { workspaceRepository, conversationRepository } from '../db/repositories'
import { memoryExtractionService } from './memory-extraction.service'
import type {
  BlueprintPhaseStartPayload,
  BlueprintPhaseCompletePayload,
  BlueprintPhaseArtifactPayload,
  BlueprintPhaseCompletion
} from '../../shared/blueprint-types'

const bpLog = log.scope('blueprint-verify')

const PHASE_TIMEOUT_MS = 30 * 60_000 // 30 min

/** Matches circular re-run-verify task descriptions. Exported for tests (GAP-5). */
export const RERUN_VERIFY_RX = /\bre-?run\b.*\b(verify|verification)\b|\bverif\w+ (pass|evidence)\b/i

/** Generic remediation task description (Strategy-3 / GAP-B rescue). Exported for tests (GAP-F). */
export const GENERIC_REMEDIATION_TASK_DESC =
  'Fix all gaps identified in the verification report. Review the verify phase output and implement missing or incomplete functionality.'

export class BlueprintVerifyService extends EventEmitter {
  // BP-VERIFY-RAW-EMIT-01: Error-isolated emit prevents listener throws from
  // crashing the VERIFY pipeline. Mirrors safeEmit() in BlueprintBuildService.
  private safeEmit(event: string, payload: unknown): boolean {
    try {
      return this.emit(event, payload)
    } catch (err) {
      bpLog.error(`[safeEmit] Event '${event}' listener threw:`, err)
      return false
    }
  }

  async startVerifyPhase(params: {
    blueprintId: string
    workspaceId: string
    workspacePath: string
  }): Promise<void> {
    const { blueprintId, workspaceId, workspacePath } = params

    bpLog.info(`[startVerifyPhase] Blueprint ${blueprintId} — starting VERIFY`)

    // BP-VERIFY-INIT-OUTSIDE-TRY-01: All initialization is now inside the
    // try-finally so that session.stop() and markPipelineStopped() always
    // run, even if markPipelineRunning or adapter creation throws.
    let session: AgentSessionService | null = null
    let onChunk: ((chunk: StreamChunk) => void) | null = null
    let onStatus: ((status: AgentStatus) => void) | null = null
    let verifyPhase: ReturnType<typeof blueprintPhaseRepository.findByBlueprintAndPhase> = undefined
    let cleanupAskUser: (() => void) | undefined
    let pendingRemediation: { blueprintId: string; workspaceId: string; workspacePath: string } | null = null

    try {
      // BP-VERIFY-CANCEL-STATUS-CHECK-01 + BP-VERIFY-NULL-BLUEPRINT-01:
      // Check if the blueprint was cancelled or deleted during the BUILD→VERIFY
      // transition window. cancel() sets DB status to 'cancelled' even when
      // running=false; deletion removes the row entirely.
      const existingBlueprint = blueprintRepository.findById(blueprintId)
      if (!existingBlueprint || existingBlueprint.status === 'cancelled') {
        bpLog.info(`[startVerifyPhase] Blueprint ${blueprintId} ${!existingBlueprint ? 'deleted' : 'cancelled'} — skipping VERIFY`)
        return
      }

      // 1. Pipeline + DB state
      blueprintService.markPipelineRunning(workspaceId, blueprintId, 'verify')

      verifyPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'verify')
      if (verifyPhase) {
        blueprintPhaseRepository.updateStatus(verifyPhase.id, 'active')
      }

      blueprintRepository.updateStatus(blueprintId, 'verifying')
      blueprintRepository.update(blueprintId, { currentPhase: 'verify' })

      // 2. Assemble context (includes ALL prior artifacts: spec → build + workspace docs)
      const phaseContext = await blueprintService.assemblePhaseContext(blueprintId, 'verify', workspacePath)

      // 3. Create adapter + session
      const adapter = new BlueprintVerifyAdapter({ workspaceId, blueprintId, phaseContext })

      const blueprint = blueprintService.getBlueprint(blueprintId)
      adapter.setGoalCondition(buildVerifyGoalCondition(blueprint?.title ?? 'Unknown'), 'enforce')

      session = new AgentSessionService(adapter)

      // 4. Emit phaseStart
      this.safeEmit('phaseStart', {
        blueprintId,
        workspaceId,
        phase: 'verify',
        goal: buildVerifyGoalCondition(blueprint?.title ?? 'Unknown')
      } satisfies BlueprintPhaseStartPayload)

      // 5. Wire streaming — named handlers for cleanup + stall watchdog
      const stallWatchdog = new PhaseActivityWatchdog(STALL_TIMEOUT_MS, 'VERIFY')

      onChunk = (chunk: StreamChunk): void => {
        stallWatchdog.touch()
        forwardBlueprintChunk(
          (event, payload) => this.safeEmit(event, payload),
          chunk,
          { blueprintId, workspaceId, phase: 'verify', workspacePath, mode: 'build' }
        )
      }
      onStatus = (status: AgentStatus): void => {
        this.safeEmit('status', { workspaceId, status })
      }
      session.on('chunk', onChunk)
      session.on('statusUpdate', onStatus)

      // B4-FIX: Auto-respond to ask_user calls — verify is non-interactive
      cleanupAskUser = wireAskUserAutoResponder(session, 'VERIFY')

      // 6. Start session in BUILD mode (Bash execution needed for quality gates).
      // Write/Edit remain blocked by BlueprintVerifyAdapter.buildMcpConfig().disallowedTools.
      await session.start(workspacePath, 'build')

      // BP-RETRY-CONV-REUSE: Check for prior conversation from failed attempt
      const verifyPhaseRec = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'verify')
      const priorConvId = verifyPhaseRec?.conversationId
      let syntheticConvId: string
      if (priorConvId && conversationRepository.getSessionId(priorConvId)) {
        const priorConv = conversationRepository.findById(priorConvId)
        const currentProvider = modelConfigService.getProvider(workspacePath)
        if (priorConv?.llmProvider === currentProvider) {
          syntheticConvId = priorConvId
          bpLog.info(`[startVerifyPhase] Resuming conversation ${priorConvId} from failed attempt`)
        } else {
          syntheticConvId = `blueprint-verify-${blueprintId}-${Date.now()}`
          bpLog.info(`[startVerifyPhase] Provider changed — falling back to fresh conversation`)
        }
      } else {
        syntheticConvId = `blueprint-verify-${blueprintId}-${Date.now()}`
      }

      // Persist conversation ID early so retries can find it
      if (verifyPhaseRec) {
        try { blueprintPhaseRepository.setConversation(verifyPhaseRec.id, syntheticConvId) }
        catch { /* conversation may not exist yet in DB */ }
      }

      let timeoutId: NodeJS.Timeout | undefined
      const timeoutPromise = new Promise<void>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('VERIFY phase timeout')), PHASE_TIMEOUT_MS)
      })

      const abortSignal = blueprintService.getAbortSignal(workspaceId)
      // BP-ABORT-TOCTOU-01: Attach listener BEFORE checking aborted status to
      // close the race window where the signal fires between check and addEventListener.
      const abortPromise = new Promise<void>((_, reject) => {
        const onAbort = (): void => reject(new Error('Phase cancelled'))
        abortSignal?.addEventListener('abort', onAbort, { once: true })
        if (abortSignal?.aborted) {
          onAbort()
        }
      })

      const sendPromise = session.send(adapter.getPhaseMessage(), syntheticConvId)

      try {
        await Promise.race([sendPromise, timeoutPromise, abortPromise, stallWatchdog.promise])
      } catch (err) {
        // BP-VERIFY-TIMEOUT-01: Cancel the in-flight query when timeout/abort/stall wins the race.
        // Without this, session.send() continues streaming in the background while
        // the outer catch handler tries to clean up — causing a race between the
        // active stream and session.stop() in the finally block.
        try {
          session.cancelCurrentQuery()
        } catch {
          /* best-effort — session may already be stopped */
        }
        throw err
      } finally {
        if (timeoutId) clearTimeout(timeoutId)
        stallWatchdog.dispose()
      }

      // FIX-1: Check session outcome — if send() was absorbed by handleStreamError
      // (overload, turn_limit, etc.), don't trust the completion.
      const sendOutcome = session.getLastSendOutcome()
      if (sendOutcome !== 'ok') {
        bpLog.error(
          `[startVerifyPhase] Blueprint ${blueprintId}: session ended with outcome '${sendOutcome}' — treating as verify failure`
        )
        this.safeEmit('phaseProgress', {
          blueprintId,
          workspaceId,
          phase: 'verify',
          text: `⚠ Verify session ended with ${sendOutcome} — treating as failure`,
          kind: 'system'
        })
        throw new Error(`Verify session ended with non-ok outcome: ${sendOutcome}`)
      }

      // 7. Parse output
      const text = session.getStreamedContent()
      let completion = parsePhaseCompletionBlock(text, 'verify') ?? undefined

      // BP-VERIFY-ENUM-GUARD: Normalize invalid overallStatus from the fence block —
      // mirror the extractor's guard. This prevents an LLM emitting e.g. "partial"
      // or "PASSED" from bypassing both Haiku extraction AND the unknown-status diagnostic.
      const VALID_OVERALL_STATUSES = new Set(['passed', 'gaps_found', 'human_needed'])
      if (completion?.overallStatus && !VALID_OVERALL_STATUSES.has(String(completion.overallStatus))) {
        bpLog.warn(`[startVerifyPhase] Invalid overallStatus '${completion.overallStatus}' from fence block — treating as missing`)
        delete completion.overallStatus  // → GAP 2 trigger fires → Haiku extraction rescues
      }

      // BP-VERIFY-DETERMINISTIC-EXTRACT: When the agent doesn't emit the structured
      // completion fence block, extract findings via a cheap one-shot Haiku call.
      // This makes verify completion deterministic — no more "agent forgot the block" failures.
      if ((!completion || !completion.overallStatus) && text.length >= 100) {
        bpLog.info(
          `[startVerifyPhase] ${!completion ? 'No completion block found' : 'Completion block missing overallStatus'} — running post-hoc extraction for blueprint ${blueprintId}`
        )
        try {
          const { extractVerifyCompletion } = await import('./blueprint-verify-extractor')
          const extracted = await extractVerifyCompletion({
            text,
            blueprintId,
            workspaceId
          })
          if (extracted) {
            bpLog.info(
              `[startVerifyPhase] Post-hoc extraction succeeded — overallStatus: ${(extracted as Record<string, unknown>).overallStatus}`
            )
            completion = extracted
          } else {
            bpLog.warn(
              `[startVerifyPhase] Post-hoc extraction returned null — falling through to 'unknown' status`
            )
          }
        } catch (extractErr) {
          bpLog.warn(`[startVerifyPhase] Post-hoc extraction failed (non-fatal):`, extractErr)
        }
      }

      // BP-VERIFY-DETERMINISTIC-DISK-01: Scan all 'complete' build tasks' planned
      // files against disk. If the LLM claimed 'passed' but files are missing,
      // force-downgrade to 'gaps_found' and let the existing remediation machinery
      // auto-dispatch fixes. This is the phase-level safety net — complementing the
      // per-task net in executeTask (BP-VERIFY-TASK-FILES-01).
      const allTasks = blueprintTaskRepository.findByBlueprint(blueprintId)
      const missingByTask = scanCompletedTaskFiles(workspacePath, allTasks)
      if (missingByTask.size > 0) {
        const totalClaimed = [...missingByTask.values()].reduce((sum, v) => sum + v.missingClaimed.length, 0)
        const totalDrift = [...missingByTask.values()].reduce((sum, v) => sum + v.driftFiles.length, 0)
        bpLog.warn(
          `[verify] Deterministic disk check: ${totalClaimed} claimed file(s) missing, ${totalDrift} drift file(s) across ${missingByTask.size} task(s)`
        )

        const beforeStatus = completion?.overallStatus
        completion = applyDeterministicFileCheck(completion, missingByTask) as BlueprintPhaseCompletion | undefined
        const afterStatus = completion?.overallStatus

        if (beforeStatus !== afterStatus) {
          bpLog.warn(
            `[verify] LLM claimed '${beforeStatus}' but ${totalClaimed} claimed file(s) missing on disk — overriding to '${afterStatus}'`
          )
          this.safeEmit('phaseProgress', {
            blueprintId,
            workspaceId,
            phase: 'verify',
            text: `⚠ Verify agent claimed '${beforeStatus}' but ${totalClaimed} claimed file(s) are missing on disk — overriding to '${afterStatus}'`,
            kind: 'system'
          })
        }
      }

      // FIX-5b: Deterministic quality gates — run tsc/npm test independently
      // of the verify agent's self-reported results.
      const gateResults = await this.runDeterministicQualityGates(workspacePath)
      if (gateResults.failed) {
        bpLog.warn(
          `[startVerifyPhase] Deterministic quality gate(s) failed — forcing gaps_found`
        )
        if (!completion) {
          completion = { phase: 'verify', status: 'complete', overallStatus: 'gaps_found', findings: [] }
        }
        completion = { ...completion, overallStatus: 'gaps_found' } as BlueprintPhaseCompletion
        // Inject deterministic findings
        const existingFindings = Array.isArray(completion.findings) ? completion.findings : []
        completion.findings = [
          ...existingFindings,
          ...gateResults.findings
        ]
        this.safeEmit('phaseProgress', {
          blueprintId,
          workspaceId,
          phase: 'verify',
          text: `⚠ Deterministic quality gates failed: ${gateResults.findings.map((f: { gate: string }) => f.gate).join(', ')}`,
          kind: 'system'
        })
      }

      // FIX-5c: Gate-evasion visibility — warn when completion lacks qualityGates
      // while gates were runnable
      if (gateResults.gatesAvailable && completion && !completion.qualityGates) {
        bpLog.warn(
          `[startVerifyPhase] Blueprint ${blueprintId}: completion lacks qualityGates ` +
          `while tsc/tests were available — agent may have skipped running them`
        )
        this.safeEmit('phaseProgress', {
          blueprintId,
          workspaceId,
          phase: 'verify',
          text: 'Verify agent did not report running quality gates (tsc/tests) — deterministic gates ran independently',
          kind: 'system'
        })
      }

      // 8. Save phase artifact
      const overallStatus = (completion?.overallStatus as string) ?? 'unknown'

      // BP-VERIFY-UNKNOWN-STATUS-DIAGNOSTIC: Log specific context when parser can't
      // extract a valid completion. Helps distinguish "agent timed out" from "parser bug".
      if (overallStatus === 'unknown') {
        bpLog.warn(
          `[startVerifyPhase] Blueprint ${blueprintId}: overallStatus='unknown' — ` +
          `completion was ${completion ? 'parsed but missing overallStatus' : 'null (parser failed)'}. ` +
          `Output length: ${text.length} chars`
        )

        // BP-VERIFY-UNKNOWN-SURFACE: Surface the dead-end to the user so they
        // understand why automatic remediation was skipped and can manually retry.
        this.safeEmit('phaseProgress', {
          blueprintId,
          workspaceId,
          phase: 'verify',
          text: 'Verify finished but a structured status could not be extracted — automatic remediation was skipped. Review the report and use Retry to run verify again.',
          kind: 'system'
        })
      }

      // BP-GAPS-FOUND-DEAD-END-FIX: When gaps_found and remediation is NOT
      // triggered, mark verify phase 'failed' (not 'complete') so retryPhase()
      // can find a retryable phase and the Retry banner renders. 'passed' and
      // 'human_needed' are genuine completions.
      const verifyPhaseStatus = (overallStatus === 'passed' || overallStatus === 'human_needed')
        ? 'complete' as const
        : 'failed' as const

      if (verifyPhase) {
        blueprintPhaseRepository.appendArtifact(verifyPhase.id, {
          type: 'verify',
          contentMd: text,
          contentJson: completion ?? undefined
        })
        blueprintPhaseRepository.setConversation(verifyPhase.id, syntheticConvId)
        blueprintPhaseRepository.updateStatus(verifyPhase.id, verifyPhaseStatus)
        // BP-RETRY-CONTEXT-CLEAR: Clear retry context on successful completion.
        // Verify is the terminal phase — advancePhase() is never called, so clear here.
        if (verifyPhaseStatus === 'complete' && verifyPhase.contextSnapshot) {
          blueprintPhaseRepository.saveContextSnapshot(verifyPhase.id, null)
        }
      }

      bpLog.info(
        `[startVerifyPhase] Blueprint ${blueprintId} — verify ${verifyPhaseStatus}, overallStatus: ${overallStatus}`
      )

      // 9. Remediation check — when gaps_found with actionable tasks, auto-fix
      // BP-REMEDIATION-01: Parse remediationTasks from completion block.
      let remediationTasks: Array<{ taskId: string; description: string; files: string[]; dependsOn?: string[] }> =
        Array.isArray(completion?.remediationTasks)
          ? (completion.remediationTasks as Array<Record<string, unknown>>)
              .filter((t): t is Record<string, unknown> & { taskId: string; description: string } =>
                t != null && typeof t === 'object' && typeof t.taskId === 'string' && typeof t.description === 'string'
              )
              .map((t) => ({
                taskId: t.taskId,
                description: t.description,
                files: asStringArray(t.files),
                dependsOn: Array.isArray(t.dependsOn)
                  ? (t.dependsOn as unknown[]).filter((d): d is string => typeof d === 'string')
                  : undefined
              }))
          : []

      // BP-CIRCULAR-VERIFY-FILTER: Drop remediation tasks that circularly request
      // re-running the verify phase. The remediation loop already re-runs verify
      // after the build wave completes — a "re-run verify" build task is redundant
      // and guaranteed to fail the file-claims net (it modifies no files by design).
      // GAP-1 FIX: Filter agent-provided tasks FIRST, then run fallback generation,
      // then filter again (fallback could theoretically emit a verify-ish task too).
      const filterCircularTasks = (tasks: typeof remediationTasks): typeof remediationTasks => {
        const before = tasks.length
        const filtered = tasks.filter((t) => {
          if (RERUN_VERIFY_RX.test(t.description)) {
            bpLog.info(`[remediation] Dropping circular re-run-verify task: ${t.taskId} — "${t.description}"`)
            return false
          }
          return true
        })
        if (filtered.length < before) {
          bpLog.info(
            `[remediation] Filtered ${before - filtered.length} circular verify task(s), ` +
            `${filtered.length} remaining`
          )
        }
        return filtered
      }

      // Step 1: Filter agent-provided tasks
      remediationTasks = filterCircularTasks(remediationTasks)

      // Step 2: BP-REMEDIATION-FALLBACK: When agent reports gaps but doesn't provide
      // usable remediation tasks (after filtering), auto-generate from completion data.
      if (overallStatus === 'gaps_found' && remediationTasks.length === 0) {
        const generated = this.generateFallbackRemediationTasks(completion ?? null, text, blueprintId)
        if (generated.length > 0) {
          bpLog.info(
            `[startVerifyPhase] No usable remediationTasks (omitted or all filtered) — auto-generated ${generated.length} from findings`
          )
          // Step 3: Filter fallback-generated tasks too (defensive)
          remediationTasks = filterCircularTasks(generated)

          // GAP-B FIX: If the defensive filter ate all generated tasks (e.g. a finding
          // phrased like "verification evidence missing for eslint" matches RERUN_VERIFY_RX),
          // substitute the Strategy-3 generic task which is guaranteed not to match the regex.
          if (remediationTasks.length === 0) {
            bpLog.info(
              `[startVerifyPhase] Defensive filter emptied ${generated.length} generated task(s) — substituting generic remediation task`
            )
            remediationTasks = [{
              taskId: 'R001',
              description: GENERIC_REMEDIATION_TASK_DESC,
              files: []
            }]
          }
        }
      }

      // BP-COLLISION-SAFE-RENUMBER: Re-assign sequential R-task IDs to avoid
      // collisions with tasks from prior remediation rounds. The agent doesn't
      // know about existing R-tasks, so it often reuses R001/R002 on round 2+.
      if (remediationTasks.length > 0) {
        const existingTasks = blueprintTaskRepository.findByBlueprint(blueprintId)
        const maxExistingR = existingTasks
          .filter((t) => /^R\d+$/.test(t.taskId))
          .reduce((max, t) => Math.max(max, parseInt(t.taskId.slice(1), 10)), 0)
        let seq = maxExistingR + 1

        // Build old→new ID map so dependsOn references can be remapped
        const idMap = new Map<string, string>()
        for (const t of remediationTasks) {
          idMap.set(t.taskId, `R${String(seq++).padStart(3, '0')}`)
        }

        remediationTasks = remediationTasks.map((t) => ({
          ...t,
          taskId: idMap.get(t.taskId)!,
          dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map((dep) => idMap.get(dep) ?? dep) : undefined
        }))
      }

      const currentBlueprint = blueprintRepository.findById(blueprintId)
      const currentSettings = currentBlueprint?.settingsJson ?? {}
      const remediationRound = (currentSettings.remediationRound as number) ?? 0
      const canRemediate =
        overallStatus === 'gaps_found' &&
        remediationTasks.length > 0 &&
        remediationRound < 2

      if (canRemediate) {
        // 9a. Increment remediationRound FIRST — prevents infinite retry loops
        // if appendTasks fails (BUG-A: round never advances → same error on retry).
        blueprintRepository.update(blueprintId, {
          settingsJson: { ...currentSettings, remediationRound: remediationRound + 1 }
        })

        // 9b. Append remediation tasks as new wave(s)
        bpLog.info(
          `[startVerifyPhase] gaps_found with ${remediationTasks.length} remediation task(s) — ` +
          `round ${remediationRound + 1}/2, appending tasks and re-triggering build`
        )
        blueprintService.appendTasks(blueprintId, remediationTasks)

        // 9c. Reset verify phase to pending, build to active, blueprint to building
        if (verifyPhase) {
          blueprintPhaseRepository.updateStatus(verifyPhase.id, 'pending')
        }
        const buildPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'build')
        if (buildPhase) {
          blueprintPhaseRepository.updateStatus(buildPhase.id, 'active')
        }
        blueprintRepository.update(blueprintId, {
          status: 'building' as import('../../shared/blueprint-types').BlueprintStatus,
          currentPhase: 'build'
        })

        // 9d. Emit system message
        this.safeEmit('phaseProgress', {
          blueprintId,
          workspaceId,
          phase: 'verify',
          text: `Verification found gaps — adding ${remediationTasks.length} remediation task(s) (round ${remediationRound + 1}/2)`,
          kind: 'system'
        })

        // 9e. Defer remediation dispatch until after the finally block releases
        // the pipeline lock (deferred dispatch pattern — same as spec→plan chaining).
        // The old setTimeout(5000) was always cancelled by the finally block's
        // clearTimeout before it could fire (RC-1 root cause).
        pendingRemediation = { blueprintId, workspaceId, workspacePath }

        // 10. Emit phaseComplete (remediation-triggered)
        // BP-STATUS-CONSISTENCY-01: Keep status 'complete' for type safety but add
        // remediationTriggered flag (top-level, survives null completion) so UI
        // consumers can distinguish a remediation loop from a genuine completion.
        // The verify phase is actually 'pending' in the DB — it will re-run after build.
        this.safeEmit('phaseComplete', {
          blueprintId,
          workspaceId,
          phase: 'verify',
          status: 'complete',
          remediationTriggered: true,
          completion: completion ? { ...completion, _remediationTriggered: true } : undefined
        } satisfies BlueprintPhaseCompletePayload)
      } else {
        // 10. Determine final blueprint status (no remediation)
        // BP-03: Only explicit 'passed' or 'human_needed' → complete.
        // 'unknown' (parse failure / truncation) and 'gaps_found' → failed.
        // BP-VERIFY-CANCEL-OVERWRITE-01: Guard against overwriting 'cancelled' status.
        const currentStatus = currentBlueprint?.status
        if (currentStatus !== 'cancelled') {
          if (overallStatus === 'passed' || overallStatus === 'human_needed') {
            blueprintRepository.updateStatus(blueprintId, 'complete')
          } else {
            // BP-RETRY-CONTEXT: Save retry context for gaps_found/unknown failures
            try {
              blueprintService.saveRetryContext(blueprintId, 'verify', {
                error: `Verify failed with status: ${overallStatus}`
              })
            } catch { /* best effort */ }
            blueprintRepository.updateStatus(blueprintId, 'failed')
          }
        }

        // Emit phaseComplete
        this.safeEmit('phaseComplete', {
          blueprintId,
          workspaceId,
          phase: 'verify',
          status: verifyPhaseStatus,
          completion
        } satisfies BlueprintPhaseCompletePayload)

        // MEM-BP-COMPLETE-01: Enqueue memory extraction for completed/failed blueprint.
        // Non-blocking — runs after all DB and event work is done.
        this.enqueueBlueprintMemoryExtraction(
          blueprintId, workspaceId, workspacePath,
          (overallStatus === 'passed' || overallStatus === 'human_needed') ? 'complete' : 'failed'
        )
      }

      if (verifyPhase) {
        this.safeEmit('phaseArtifact', {
          blueprintId,
          workspaceId,
          phase: 'verify',
          artifact: { type: 'verify', contentMd: text }
        } satisfies BlueprintPhaseArtifactPayload)
      }
    } catch (err) {
      bpLog.error(`[startVerifyPhase] VERIFY phase failed:`, err)

      // Guard: don't overwrite 'cancelled' status
      const currentStatus = blueprintRepository.findById(blueprintId)?.status
      if (currentStatus !== 'cancelled') {
        if (verifyPhase) {
          blueprintPhaseRepository.updateStatus(verifyPhase.id, 'failed')
        }
        blueprintRepository.updateStatus(blueprintId, 'failed')
      }

      const partialText = session?.getStreamedContent()
      if (partialText && verifyPhase) {
        blueprintPhaseRepository.appendArtifact(verifyPhase.id, {
          type: 'verify-partial',
          contentMd: partialText
        })
      }

      // M5: Use failPipeline to properly transition machine to 'failed' state
      const errorMsg = err instanceof Error ? err.message : String(err)
      blueprintService.failPipeline(workspaceId, errorMsg)

      // BP-RETRY-CONTEXT: Save structured retry context for next attempt
      try { blueprintService.saveRetryContext(blueprintId, 'verify', { error: errorMsg }) }
      catch { /* best effort */ }

      const autoRetrying = blueprintService.scheduleAutoRetry({
        blueprintId, workspaceId, workspacePath, phase: 'verify', error: errorMsg
      })

      this.safeEmit('phaseComplete', {
        blueprintId,
        workspaceId,
        phase: 'verify',
        status: 'failed',
        error: errorMsg,
        ...(autoRetrying ? { autoRetry: true } : {})
      } satisfies BlueprintPhaseCompletePayload)

      // MEM-BP-COMPLETE-01: Also extract from failed blueprints — failures are
      // valuable gotcha facts. Skip if auto-retrying (extraction on final outcome only).
      if (!autoRetrying) {
        this.enqueueBlueprintMemoryExtraction(blueprintId, workspaceId, workspacePath, 'failed')
      }
    } finally {
      cleanupAskUser?.()
      if (session) {
        if (onChunk) session.removeListener('chunk', onChunk)
        if (onStatus) session.removeListener('statusUpdate', onStatus)
        // BP-SESSION-LEAK-01: Wrap session.stop() in its own try-catch so a
        // stop() failure doesn't skip markPipelineStopped(), stranding the
        // pipeline in phase-running with state.running=true permanently.
        try {
          await session.stop()
        } catch (err) {
          bpLog.error('[verify] session.stop() failed:', err)
        }
      }
      blueprintService.markPipelineStopped(workspaceId)
    }

    // Dispatch AFTER finally — markPipelineStopped() has released the lock.
    // setImmediate avoids re-entrancy with the stateChange listener chain.
    // Cancel-safety: the IPC listener re-checks blueprint status before dispatching.
    if (pendingRemediation) {
      const payload = pendingRemediation
      setImmediate(() => this.safeEmit('remediationNeeded', payload))
    }
  }

  // ── Deterministic Quality Gates ────────────────────────────────────────

  /**
   * FIX-5b: Run tsc + npm test deterministically after the verify agent completes.
   * Non-zero exit → gate failed. Commands unavailable/timeout → log + skip.
   */
  private async runDeterministicQualityGates(workspacePath: string): Promise<{
    failed: boolean
    gatesAvailable: boolean
    findings: Array<{ source: string; severity: string; gate: string; description: string }>
  }> {
    const findings: Array<{ source: string; severity: string; gate: string; description: string }> = []
    let gatesAvailable = false
    const GATE_TIMEOUT_MS = 120_000 // 2 min per gate

    // Gate 1: TypeScript typecheck (only if tsconfig.json exists)
    const hasTsConfig = existsSync(join(workspacePath, 'tsconfig.json'))
    if (hasTsConfig) {
      gatesAvailable = true
      try {
        const tscOutput = await this.execGateCommand(
          'npx', ['tsc', '--noEmit'],
          workspacePath, GATE_TIMEOUT_MS
        )
        if (tscOutput.exitCode !== 0) {
          findings.push({
            source: 'deterministic-quality-gate',
            severity: 'error',
            gate: 'tsc',
            description: `TypeScript typecheck failed (exit ${tscOutput.exitCode}): ${tscOutput.output.slice(0, 2048)}`
          })
        } else {
          bpLog.info('[verify:quality-gates] tsc --noEmit passed')
        }
      } catch (err) {
        bpLog.warn('[verify:quality-gates] tsc gate skipped:', err)
      }
    }

    // Gate 2: npm test (only if package.json has a test script)
    try {
      const pkgPath = join(workspacePath, 'package.json')
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
        if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
          gatesAvailable = true
          try {
            const testOutput = await this.execGateCommand(
              'npm', ['test', '--silent'],
              workspacePath, GATE_TIMEOUT_MS
            )
            if (testOutput.exitCode !== 0) {
              findings.push({
                source: 'deterministic-quality-gate',
                severity: 'error',
                gate: 'npm-test',
                description: `Test suite failed (exit ${testOutput.exitCode}): ${testOutput.output.slice(0, 2048)}`
              })
            } else {
              bpLog.info('[verify:quality-gates] npm test passed')
            }
          } catch (err) {
            bpLog.warn('[verify:quality-gates] npm test gate skipped:', err)
          }
        }
      }
    } catch (err) {
      bpLog.warn('[verify:quality-gates] Failed to read package.json:', err)
    }

    return {
      failed: findings.length > 0,
      gatesAvailable,
      findings
    }
  }

  /**
   * Execute a gate command with timeout. Returns exit code + combined output.
   */
  private execGateCommand(
    cmd: string,
    args: string[],
    cwd: string,
    timeoutMs: number
  ): Promise<{ exitCode: number; output: string }> {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, {
        cwd,
        timeout: timeoutMs,
        encoding: 'utf-8',
        maxBuffer: 5 * 1024 * 1024, // 5MB
        env: { ...process.env, CI: '1', NODE_ENV: 'test' }
      }, (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
          reject(new Error(`Gate timed out after ${timeoutMs}ms`))
          return
        }
        if (error) {
          const execErr = error as ExecFileException
          const code = execErr.code ?? 1
          resolve({ exitCode: typeof code === 'number' ? code : 1, output: (stdout ?? '') + (stderr ?? '') })
        } else {
          resolve({ exitCode: 0, output: (stdout ?? '') + (stderr ?? '') })
        }
      })
    })
  }

  // ── Remediation fallback ──────────────────────────────────────────────

  /**
   * BP-REMEDIATION-FALLBACK: Generate remediation tasks from verify findings
   * when the agent fails to include them in the completion block.
   *
   * Extracts MISSING/STUB/ORPHANED artifact names and broken key links from
   * either the structured completion JSON or the raw markdown text.
   */
  private generateFallbackRemediationTasks(
    completion: Record<string, unknown> | null,
    text: string,
    _blueprintId: string
  ): Array<{ taskId: string; description: string; files: string[] }> {
    const tasks: Array<{ taskId: string; description: string; files: string[] }> = []

    // Placeholder IDs — the caller's centralized renumbering (BP-COLLISION-SAFE-RENUMBER)
    // reassigns all taskIds before appendTasks, so these are temporary.
    let seq = 1

    // Strategy 1: Parse structured completion fields
    if (completion) {
      // Extract findings array if present
      const findings = completion.findings as Array<Record<string, unknown>> | undefined
      if (Array.isArray(findings)) {
        for (const finding of findings) {
          if (!finding || typeof finding !== 'object') continue
          // Skip deterministic disk-check findings — these reflect plan drift
          // (planned files the agent decided not to create) and are structurally
          // unresolvable through remediation. Quality gate findings (tsc, npm test)
          // ARE actionable and should generate remediation tasks — the
          // remediationRound < 2 cap prevents loops for those.
          const source = String(finding.source ?? '')
          if (source === 'deterministic-disk-check' || source === 'deterministic-disk-check-drift') continue

          const desc = String(finding.description ?? finding.issue ?? '')
          let files = Array.isArray(finding.files) ? finding.files.map(String) : []

          // Extract file paths from quality gate error output (e.g., TSC errors)
          // Format: "src/components/Foo.tsx(83,7): error TS2345: ..."
          if (source === 'deterministic-quality-gate' && files.length === 0 && desc) {
            const tscPathPattern = /(?:^|\n)\s*(\S+\.\w+)\(\d+,\d+\)/g
            const extracted = new Set<string>()
            let m: RegExpExecArray | null
            while ((m = tscPathPattern.exec(desc)) !== null) {
              if (m[1] && !m[1].startsWith('node_modules')) extracted.add(m[1])
            }
            if (extracted.size > 0) files = [...extracted].slice(0, 20)
          }
          if (desc) {
            tasks.push({
              taskId: `R${String(seq++).padStart(3, '0')}`,
              description: `Fix: ${desc}`,
              files
            })
          }
        }
      }
      // If artifacts object has missing/stub/orphaned counts but no findings array
      if (tasks.length === 0) {
        const artifacts = completion.artifacts as Record<string, unknown> | undefined
        if (artifacts) {
          const missing = (artifacts.missing as number) ?? 0
          const stub = (artifacts.stub as number) ?? 0
          const orphaned = (artifacts.orphaned as number) ?? 0
          if (missing + stub + orphaned > 0) {
            tasks.push({
              taskId: `R${String(seq++).padStart(3, '0')}`,
              description: `Fix verification gaps: ${missing} missing, ${stub} stub, ${orphaned} orphaned artifacts. Review the verify phase report and implement the missing functionality.`,
              files: []
            })
          }
        }
      }
    }

    // Strategy 2: Regex fallback — extract file paths from MISSING/STUB/ORPHANED lines
    if (tasks.length === 0 && text) {
      const gapPattern = /(?:MISSING|STUB|ORPHANED|✗|⚠️)\s*[—–-]\s*(?:`([^`]+)`|(\S+\.\w+))/gi
      const gapFiles = new Set<string>()
      let match: RegExpExecArray | null
      while ((match = gapPattern.exec(text)) !== null) {
        const file = match[1] || match[2]
        if (file) gapFiles.add(file)
      }
      if (gapFiles.size > 0) {
        tasks.push({
          taskId: `R${String(seq++).padStart(3, '0')}`,
          description: `Fix ${gapFiles.size} artifact gap(s) identified during verification: ${[...gapFiles].slice(0, 10).join(', ')}${gapFiles.size > 10 ? '...' : ''}`,
          files: [...gapFiles].slice(0, 20)
        })
      }
    }

    // Strategy 3: Last resort — single generic task from the full report
    if (tasks.length === 0 && text.length > 100) {
      tasks.push({
        taskId: `R${String(seq++).padStart(3, '0')}`,
        description: GENERIC_REMEDIATION_TASK_DESC,
        files: []
      })
    }

    return tasks
  }

  // ── Memory extraction helper ───────────────────────────────────────────

  /**
   * Enqueue blueprint memory extraction (non-blocking). Assembles context from
   * phases, tasks, and clarify Q&A, then delegates to memoryExtractionService.
   * Gated behind captureBlueprints setting.
   */
  private enqueueBlueprintMemoryExtraction(
    blueprintId: string,
    workspaceId: string,
    workspacePath: string,
    status: 'complete' | 'failed'
  ): void {
    try {
      const wsSettings = workspaceRepository.getSettings(workspaceId)
      if ((wsSettings as any).memoryCaptureBlueprints === false) return

      const blueprint = blueprintRepository.findById(blueprintId)
      if (!blueprint) return

      const phases = blueprintPhaseRepository.findByBlueprint(blueprintId)
      const tasks = blueprintTaskRepository.findByBlueprint(blueprintId)

      // Extract clarify Q&A from blueprint events
      let clarifyQA: Array<{ question: string; answer: string }> | undefined
      try {
        const events = blueprintEventRepository.findByBlueprint(blueprintId)
        const qaEvents = events.filter((e: any) => e.type === 'qa' || e.type === 'user')
        if (qaEvents.length > 0) {
          clarifyQA = qaEvents.map((e: any) => ({
            question: e.content?.question ?? e.content ?? '',
            answer: e.content?.answer ?? ''
          })).filter((qa: any) => qa.question)
        }
      } catch {
        // Events may not exist — fine
      }

      memoryExtractionService.enqueueBlueprintExtraction({
        blueprintId,
        workspaceId,
        workspacePath,
        title: blueprint.title,
        status,
        phases: phases.map((p: any) => ({
          phase: p.phase,
          artifacts: p.artifactsJson ?? p.artifacts ?? []
        })),
        tasks: tasks.map((t: any) => ({
          taskId: t.taskId,
          description: t.description,
          status: t.status
        })),
        clarifyQA
      })
    } catch (err) {
      bpLog.warn(`[enqueueBlueprintMemoryExtraction] Failed to enqueue: ${err}`)
    }
  }

  /** Cancel (one-shot — handled by AbortController in blueprintService.cancel()). */
  async cancelBlueprint(_blueprintId: string): Promise<void> {
    // One-shot — no session map to clean up.
  }

  async shutdown(): Promise<void> {
    // One-shot — no persistent sessions to clean up.
  }
}

export const blueprintVerifyService = new BlueprintVerifyService()
