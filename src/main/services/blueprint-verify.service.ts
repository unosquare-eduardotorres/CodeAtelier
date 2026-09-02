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
import { BlueprintVerifyAdapter } from './role-adapters/blueprint/blueprint-verify.adapter'
import { buildVerifyGoalCondition } from './blueprint-goal-conditions'
import { parsePhaseCompletionBlock, asStringArray } from './blueprint-artifact-parsers'
import { parseGateCommands } from '../../shared/blueprint-artifact-parsers'
import { scanCompletedTaskFiles, applyDeterministicFileCheck } from './blueprint-task-verification'
import { blueprintService, capArtifactForIpc } from './blueprint.service'
import { syncBlueprintDone } from './jira-issue-sync.service'
import { modelConfigService } from './model-config.service'
import {
  blueprintRepository,
  blueprintPhaseRepository
} from '../db/repositories/blueprint.repository'
import { blueprintTaskRepository } from '../db/repositories/blueprint.repository'
import { blueprintEventRepository } from '../db/repositories/blueprint-event.repository'
import { appPreferenceRepository } from '../db/repositories/app-preference.repository'
import { workspaceRepository, conversationRepository } from '../db/repositories'
import { memoryExtractionService } from './memory-extraction.service'
import { runVerifyGates, runStructuralGate, type GateTaskContext } from './blueprint-gates.service'
import {
  boundEvidence,
  buildGateReport,
  ledgerItemsFrom,
  summarizeLedger,
  type GateReport
} from '../../shared/gate-types'
import { resolveGateCommands } from '../../shared/gate-command-resolver'
import type { GateCommandSet } from '../../shared/gate-command-types'
import { scanGateCommands } from './blueprint-preflight.service'
import { codeGraphService } from './code-graph.service'
import { primaryTreeLock, primaryTreeBusyError } from './track.service'
import { resolveBlueprintTrack, blueprintTrackOwner } from './blueprint-track'
import type {
  BlueprintPhaseStartPayload,
  BlueprintPhaseCompletePayload,
  BlueprintPhaseArtifactPayload,
  BlueprintPhaseCompletion
} from '../../shared/blueprint-types'

const bpLog = log.scope('blueprint-verify')

const PHASE_TIMEOUT_MS = 30 * 60_000 // 30 min

/** Matches circular re-run-verify task descriptions. Exported for tests (GAP-5). */
export const RERUN_VERIFY_RX =
  /\bre-?run\b.*\b(verify|verification)\b|\bverif\w+ (pass|evidence)\b/i

/** Generic remediation task description (Strategy-3 / GAP-B rescue). Exported for tests (GAP-F). */
export const GENERIC_REMEDIATION_TASK_DESC =
  'Fix all gaps identified in the verification report. Review the verify phase output and implement missing or incomplete functionality.'

/**
 * REMEDIATION-SCRAPE FILTER (R005 incident): paths that must NEVER become
 * remediation tasks. The verify report routinely cites the blueprint's own
 * metadata files (blueprints/<id>/tasks.md, plan.md, spec.md, build-*.md) when
 * describing what was checked — the Strategy-2 regex scraped `tasks.md` out of
 * that prose and generated "create tasks.md" as a build task. That file is
 * pipeline metadata, not a code deliverable: it does not exist in the build
 * worktree and never should, so the task failed verification on every retry
 * (live: blueprint 718c wave 7, R005 burned 2 attempts x ~5 min).
 */
const NON_REMEDIABLE_PATH_RX =
  /(?:^|\/)\b(?:tasks|plan|spec|build|build-\d+|verify|review)\.md\b/i

/** True when a scraped path is pipeline metadata (or not a real file path at all). */
function isNonRemediablePath(path: string): boolean {
  const trimmed = path.trim().replace(/^[`'"]+|[`'"]+$/g, '')
  if (!trimmed) return true
  return NON_REMEDIABLE_PATH_RX.test(trimmed)
}

/**
 * BP-VERIFY-GATE-SALVAGE: When the agent verdict cannot be extracted at all
 * (no fence block, post-hoc extraction returned null) but the deterministic
 * gates ran and came back green, the pipeline has real evidence the code is
 * sound — failing the phase throws that away. Synthesize a conservative
 * 'human_needed' completion: verify finishes, the report stays readable,
 * nothing is claimed as a clean pass, remediation is not triggered.
 * Returns null when salvage does not apply (caller keeps current behaviour).
 */
export function salvageCompletionFromGates(
  completion: BlueprintPhaseCompletion | undefined,
  gateResults: { failed: boolean; gatesAvailable: boolean }
): BlueprintPhaseCompletion | null {
  if (completion?.overallStatus) return null // verdict exists — nothing to salvage
  if (!gateResults.gatesAvailable || gateResults.failed) return null // no green evidence
  return {
    ...(completion ?? {}),
    phase: 'verify',
    status: 'complete',
    overallStatus: 'human_needed',
    recommendation:
      'Deterministic gates passed (full-suite, structural) but the agent verdict could not be extracted — review the verify report.',
    findings: [],
    gateSalvaged: true
  } as BlueprintPhaseCompletion
}

/** Run a git subcommand in the execution tree (sync, best-effort). */
function gitSync(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 })
  } catch {
    return null
  }
}

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
    let pendingRemediation: {
      blueprintId: string
      workspaceId: string
      workspacePath: string
    } | null = null
    // M6.1 — deferred lead-review-pass dispatch. Same pattern as
    // pendingRemediation: the pass re-acquires the pipeline lock, so it must
    // not start until this method's finally has released it.
    let pendingLeadReviewPass: {
      blueprintId: string
      workspaceId: string
      workspacePath: string
    } | null = null
    // BP-CATCH-SCOPE-01: Hoisted outside try so the catch block (partial-output save) can read it.
    let syntheticConvId: string | undefined
    // F6 FIX: set when the first terminal event is emitted — a late/re-fired
    // catch must not produce a duplicate phaseComplete or re-fail the pipeline.
    let settled = false

    // VERIFY runs in whatever tree BUILD wrote into — resolved, never created,
    // because BUILD owns creation and a VERIFY re-run long after the fact should
    // follow the work rather than resurrect a branch.
    //
    // When that is the run's own worktree, VERIFY's Bash and its deterministic
    // quality gates run there and the user's checkout is untouched. When it is
    // the primary tree (workspace opted out, or the track is gone), VERIFY takes
    // the same claim BUILD does, under the same owner id: BUILD deliberately
    // does not release before auto-triggering VERIFY, so the acquire is
    // re-entrant and the handoff has no gap. The release in `finally` is
    // unconditional and owner-guarded — it ends the blueprint's claim whether
    // this phase took it or inherited it, and no-ops when somebody else holds
    // the tree.
    const primaryTreeOwnerId = `blueprint:${blueprintId}`
    const track = resolveBlueprintTrack(blueprintId, workspacePath)
    const executionPath = track.path

    try {
      // BP-VERIFY-CANCEL-STATUS-CHECK-01 + BP-VERIFY-NULL-BLUEPRINT-01:
      // Check if the blueprint was cancelled or deleted during the BUILD→VERIFY
      // transition window. cancel() sets DB status to 'cancelled' even when
      // running=false; deletion removes the row entirely.
      const existingBlueprint = blueprintRepository.findById(blueprintId)
      if (!existingBlueprint || existingBlueprint.status === 'cancelled') {
        bpLog.info(
          `[startVerifyPhase] Blueprint ${blueprintId} ${!existingBlueprint ? 'deleted' : 'cancelled'} — skipping VERIFY`
        )
        return
      }

      // 1. Pipeline + DB state
      blueprintService.markPipelineRunning(workspaceId, blueprintId, 'verify')

      if (
        !track.isolated &&
        !primaryTreeLock.acquire(workspaceId, {
          ownerKind: 'blueprint',
          ownerId: primaryTreeOwnerId,
          reason: 'A blueprint VERIFY phase'
        })
      ) {
        throw primaryTreeBusyError(primaryTreeLock.holder(workspaceId))
      }

      verifyPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'verify')
      if (verifyPhase) {
        blueprintPhaseRepository.updateStatus(verifyPhase.id, 'active')
      }

      blueprintRepository.updateStatus(blueprintId, 'verifying')
      blueprintRepository.update(blueprintId, { currentPhase: 'verify' })

      // 2. Assemble context (includes ALL prior artifacts: spec → build + workspace docs)
      const phaseContext = await blueprintService.assemblePhaseContext(
        blueprintId,
        'verify',
        workspacePath,
        blueprintService.resolveWorkspaceContextWindow(workspacePath)
      )

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
        forwardBlueprintChunk((event, payload) => this.safeEmit(event, payload), chunk, {
          blueprintId,
          workspaceId,
          phase: 'verify',
          workspacePath: executionPath,
          mode: 'build'
        })
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
      // When blueprintAutoMode is enabled, use 'danger' to bypass permission prompts.
      const autoMode = appPreferenceRepository.getAppPreferences().blueprintAutoMode
      // Repo root for workspace identity, track owner for the cwd — see the
      // note on the same call in blueprint-build.service.ts.
      await session.start(workspacePath, autoMode ? 'danger' : 'build', {
        trackOwner: blueprintTrackOwner(blueprintId)
      })

      // BP-RETRY-CONV-REUSE: Check for prior conversation from failed attempt
      const verifyPhaseRec = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'verify')
      const priorConvId = verifyPhaseRec?.conversationId
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
        try {
          blueprintPhaseRepository.setConversation(verifyPhaseRec.id, syntheticConvId)
        } catch {
          /* conversation may not exist yet in DB */
        }
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
          session.cancelCurrentQuery(syntheticConvId)
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
      const text = session.getStreamedContent(syntheticConvId)
      let completion = parsePhaseCompletionBlock(text, 'verify') ?? undefined

      // BP-VERIFY-ENUM-GUARD: Normalize invalid overallStatus from the fence block —
      // mirror the extractor's guard. This prevents an LLM emitting e.g. "partial"
      // or "PASSED" from bypassing both Haiku extraction AND the unknown-status diagnostic.
      const VALID_OVERALL_STATUSES = new Set(['passed', 'gaps_found', 'human_needed'])
      if (
        completion?.overallStatus &&
        !VALID_OVERALL_STATUSES.has(String(completion.overallStatus))
      ) {
        bpLog.warn(
          `[startVerifyPhase] Invalid overallStatus '${completion.overallStatus}' from fence block — treating as missing`
        )
        delete completion.overallStatus // → GAP 2 trigger fires → Haiku extraction rescues
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
            workspaceId,
            workspacePath
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
      // The tree BUILD actually wrote into — scanning the primary tree would
      // report every completed task's files as missing.
      // Primary checkout passed as the secondary root: absolute paths recorded
      // against it are re-rooted onto the tree BUILD wrote in, and anything under
      // neither root is skipped rather than reported missing (BP-VERIFY-UNVERIFIABLE-01).
      const missingByTask = scanCompletedTaskFiles(executionPath, allTasks, workspacePath)
      if (missingByTask.size > 0) {
        const totalClaimed = [...missingByTask.values()].reduce(
          (sum, v) => sum + v.missingClaimed.length,
          0
        )
        const totalDrift = [...missingByTask.values()].reduce(
          (sum, v) => sum + v.driftFiles.length,
          0
        )
        bpLog.warn(
          `[verify] Deterministic disk check: ${totalClaimed} claimed file(s) missing, ${totalDrift} drift file(s) across ${missingByTask.size} task(s)`
        )

        const beforeStatus = completion?.overallStatus
        completion = applyDeterministicFileCheck(completion, missingByTask) as
          BlueprintPhaseCompletion | undefined
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

      // FIX-5b (M8.2/M8.3): deterministic quality gates — the real engine
      // replaces the hardcoded tsc/npm-test probe. Commands resolve through
      // the same override → declared → detected chain the build phase uses;
      // `unverifiable` gates land in the ledger (M4.3 semantics) and only a
      // red full-suite/smoke forces gaps_found.
      // Gates must run where the code is: a typecheck of the user's checkout
      // says nothing about what BUILD produced.
      const gateResults = await this.runVerifyQualityGates({
        blueprintId,
        workspaceId,
        workspacePath,
        executionPath,
        signal: abortSignal ?? undefined
      })
      if (gateResults.failed) {
        bpLog.warn(`[startVerifyPhase] Deterministic quality gate(s) failed — forcing gaps_found`)
        if (!completion) {
          completion = {
            phase: 'verify',
            status: 'complete',
            overallStatus: 'gaps_found',
            findings: []
          }
        }
        completion = { ...completion, overallStatus: 'gaps_found' } as BlueprintPhaseCompletion
        // Inject deterministic findings
        const existingFindings = Array.isArray(completion.findings) ? completion.findings : []
        completion.findings = [...existingFindings, ...gateResults.findings]
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
            `while gate commands were available — agent may have skipped running them`
        )
        this.safeEmit('phaseProgress', {
          blueprintId,
          workspaceId,
          phase: 'verify',
          text: 'Verify agent did not report running quality gates — deterministic gates ran independently',
          kind: 'system'
        })
      }

      // BP-VERIFY-GATE-SALVAGE (see helper): green gates rescue an unextractable verdict.
      const salvaged = salvageCompletionFromGates(completion, gateResults)
      if (salvaged) {
        bpLog.warn(
          `[startVerifyPhase] Blueprint ${blueprintId}: no extractable verdict but deterministic ` +
            `gates are green — salvaging to 'human_needed'`
        )
        completion = salvaged
        this.safeEmit('phaseProgress', {
          blueprintId,
          workspaceId,
          phase: 'verify',
          text: 'Verify agent verdict could not be extracted, but all deterministic quality gates passed — completing as "needs human review". Review the report below.',
          kind: 'system'
        })
      }

      // M8.4 — inject the ledger rollup into the completion payload so the
      // terminal report states what shipped unproven (grouped by gate/reason).
      if (completion) {
        const ledgerNow = blueprintRepository.findById(blueprintId)?.unverifiedJson ?? []
        completion = {
          ...completion,
          unverifiedSummary: summarizeLedger(ledgerNow)
        } as BlueprintPhaseCompletion
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
      const verifyPhaseStatus =
        overallStatus === 'passed' || overallStatus === 'human_needed'
          ? ('complete' as const)
          : ('failed' as const)

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
      let remediationTasks: Array<{
        taskId: string
        description: string
        files: string[]
        dependsOn?: string[]
      }> = Array.isArray(completion?.remediationTasks)
        ? (completion.remediationTasks as Array<Record<string, unknown>>)
            .filter(
              (t): t is Record<string, unknown> & { taskId: string; description: string } =>
                t != null &&
                typeof t === 'object' &&
                typeof t.taskId === 'string' &&
                typeof t.description === 'string'
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
            bpLog.info(
              `[remediation] Dropping circular re-run-verify task: ${t.taskId} — "${t.description}"`
            )
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
        const generated = this.generateFallbackRemediationTasks(
          completion ?? null,
          text,
          blueprintId
        )
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
            remediationTasks = [
              {
                taskId: 'R001',
                description: GENERIC_REMEDIATION_TASK_DESC,
                files: []
              }
            ]
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
          dependsOn: Array.isArray(t.dependsOn)
            ? t.dependsOn.map((dep) => idMap.get(dep) ?? dep)
            : undefined
        }))
      }

      const currentBlueprint = blueprintRepository.findById(blueprintId)
      const currentSettings = currentBlueprint?.settingsJson ?? {}
      const remediationRound = (currentSettings.remediationRound as number) ?? 0
      const canRemediate =
        overallStatus === 'gaps_found' && remediationTasks.length > 0 && remediationRound < 2

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
        settled = true
      } else {
        // 10. Determine final blueprint status (no remediation)
        // BP-03: Only explicit 'passed' or 'human_needed' → complete.
        // 'unknown' (parse failure / truncation) and 'gaps_found' → failed.
        // BP-VERIFY-CANCEL-OVERWRITE-01: Guard against overwriting 'cancelled' status.
        const currentStatus = currentBlueprint?.status

        // M6.1 — post-verify lead-review pass. When the workspace setting is
        // ON, the outcome is a genuine completion, and no fix round has been
        // dispatched yet, the pass runs BEFORE the blueprint is marked
        // complete. The pass owns the terminal transition (and the memory
        // extraction) when dispatched — verify skips both here.
        //
        // leadReviewRound: absent/0 → first dispatch; 1 → fix wave already ran
        // (the re-verify re-triggers the pass for the round-2 check, which
        // records survivors to the ledger and completes); ≥2 → settled.
        const leadPassEligible =
          (overallStatus === 'passed' || overallStatus === 'human_needed') &&
          currentStatus !== 'cancelled' &&
          (() => {
            try {
              const wsSettings = workspaceRepository.getSettings(workspaceId) as Record<
                string,
                unknown
              >
              if (wsSettings.leadReviewPass !== true) return false
              const round = currentSettings.leadReviewRound
              return typeof round !== 'number' || round < 2
            } catch {
              return false
            }
          })()

        if (leadPassEligible) {
          // Emit phaseComplete for the verify phase itself (it genuinely
          // completed), then hand off to the pass. The pass re-acquires the
          // pipeline lock in its own markPipelineRunning — deferred until
          // after this finally releases it (same pattern as pendingRemediation).
          this.safeEmit('phaseComplete', {
            blueprintId,
            workspaceId,
            phase: 'verify',
            status: 'complete',
            completion
          } satisfies BlueprintPhaseCompletePayload)
          settled = true

          if (verifyPhase) {
            this.safeEmit('phaseArtifact', {
              blueprintId,
              workspaceId,
              phase: 'verify',
              artifact: capArtifactForIpc({ type: 'verify', contentMd: text })
            } satisfies BlueprintPhaseArtifactPayload)
          }

          pendingLeadReviewPass = { blueprintId, workspaceId, workspacePath }
        } else {
          if (currentStatus !== 'cancelled') {
            if (overallStatus === 'passed' || overallStatus === 'human_needed') {
              blueprintRepository.updateStatus(blueprintId, 'complete')
              void syncBlueprintDone(blueprintId)
            } else {
              // BP-RETRY-CONTEXT: Save retry context for gaps_found/unknown failures
              try {
                blueprintService.saveRetryContext(blueprintId, 'verify', {
                  error: `Verify failed with status: ${overallStatus}`
                })
              } catch {
                /* best effort */
              }
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
          settled = true

          // MEM-BP-COMPLETE-01: Enqueue memory extraction for completed/failed blueprint.
          // Non-blocking — runs after all DB and event work is done.
          this.enqueueBlueprintMemoryExtraction(
            blueprintId,
            workspaceId,
            workspacePath,
            overallStatus === 'passed' || overallStatus === 'human_needed' ? 'complete' : 'failed'
          )
        }
      }

      if (verifyPhase) {
        this.safeEmit('phaseArtifact', {
          blueprintId,
          workspaceId,
          phase: 'verify',
          // A5: cap for IPC — multi-hundred-KB payloads stall the renderer
          artifact: capArtifactForIpc({ type: 'verify', contentMd: text })
        } satisfies BlueprintPhaseArtifactPayload)
      }
    } catch (err) {
      if (settled) {
        // F6 FIX: the run already settled (phaseComplete emitted) — a late
        // throw from post-completion work must not re-fail the pipeline or
        // emit a duplicate terminal event. Guard sits BEFORE the DB writes so
        // a settled run's status is never overwritten (same as review services).
        bpLog.warn(`[startVerifyPhase] Post-settlement throw ignored:`, err)
        // F3 FIX: still surface it to the human — a swallowed post-completion
        // failure would otherwise look like a silent stall.
        this.safeEmit('phaseProgress', {
          blueprintId,
          workspaceId,
          phase: 'verify',
          text: `⚠️ Post-completion error (phase already settled): ${
            err instanceof Error ? err.message : String(err)
          }`
        })
        return
      }
      bpLog.error(`[startVerifyPhase] VERIFY phase failed:`, err)

      // Guard: don't overwrite 'cancelled' status
      const currentStatus = blueprintRepository.findById(blueprintId)?.status
      if (currentStatus !== 'cancelled') {
        if (verifyPhase) {
          blueprintPhaseRepository.updateStatus(verifyPhase.id, 'failed')
        }
        blueprintRepository.updateStatus(blueprintId, 'failed')
      }

      const partialText = session?.getStreamedContent(syntheticConvId)
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
      try {
        blueprintService.saveRetryContext(blueprintId, 'verify', { error: errorMsg })
      } catch {
        /* best effort */
      }

      const autoRetrying = blueprintService.scheduleAutoRetry({
        blueprintId,
        workspaceId,
        workspacePath,
        phase: 'verify',
        error: errorMsg
      })

      this.safeEmit('phaseComplete', {
        blueprintId,
        workspaceId,
        phase: 'verify',
        status: 'failed',
        error: errorMsg,
        ...(autoRetrying ? { autoRetry: true } : {})
      } satisfies BlueprintPhaseCompletePayload)
      settled = true

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
      primaryTreeLock.release(workspaceId, primaryTreeOwnerId)
    }

    // Dispatch AFTER finally — markPipelineStopped() has released the lock.
    // setImmediate avoids re-entrancy with the stateChange listener chain.
    // Cancel-safety: the IPC listener re-checks blueprint status before dispatching.
    if (pendingRemediation) {
      const payload = pendingRemediation
      setImmediate(() => this.safeEmit('remediationNeeded', payload))
    }

    // M6.1 — lead-review pass dispatch, same deferred pattern. Lazy import:
    // the lead-review service imports the build service (fix-wave dispatch),
    // which imports this service — a static import here would be a cycle.
    if (pendingLeadReviewPass) {
      const payload = pendingLeadReviewPass
      setImmediate(() => {
        import('./blueprint-lead-review.service')
          .then(({ blueprintLeadReviewService }) =>
            blueprintLeadReviewService.startLeadReviewPass(payload)
          )
          .catch((err) => {
            bpLog.error('[verify→lead-review] Lead-review pass failed:', err)
            // The pass records its own failures to the ledger and completes;
            // this catch is the belt-and-braces path (e.g. import failure).
            const errorMsg = err instanceof Error ? err.message : String(err)
            blueprintService.failPipeline(payload.workspaceId, errorMsg)
            blueprintRepository.updateStatus(payload.blueprintId, 'failed')
          })
      })
    }
  }

  // ── Deterministic Quality Gates ────────────────────────────────────────

  /**
   * FIX-5b, rebuilt on the gate engine (M8.2/M8.3): resolve commands through
   * the same override → declared → detected chain the build phase uses, run
   * the VERIFY command gates (full-suite + smoke) plus the structural gate,
   * and map the outcomes onto the verify model.
   *
   * No cache — verify runs once per blueprint, so the resolution is fresh by
   * construction (and post-build scaffolding is visible).
   *
   * Mapping (M4.3 semantics):
   *   - `fail` on full-suite/smoke → error findings (source
   *     `deterministic-quality-gate`) feeding the existing findings array, so
   *     the verify model and the FIX-5c gate-evasion check keep working
   *   - `unverifiable` → ledger append + phaseProgress warning — never a fail
   *   - structural findings → warning-severity findings (never fail)
   *
   * `gatesAvailable` keeps its FIX-5c meaning: true when any command gate
   * actually resolved (regardless of outcome).
   */
  private async runVerifyQualityGates(params: {
    blueprintId: string
    workspaceId: string
    workspacePath: string
    executionPath: string
    signal?: AbortSignal
  }): Promise<{
    failed: boolean
    gatesAvailable: boolean
    findings: Array<{ source: string; severity: string; gate: string; description: string }>
  }> {
    const { blueprintId, workspaceId, workspacePath, executionPath, signal } = params
    const findings: Array<{ source: string; severity: string; gate: string; description: string }> =
      []

    // 1. Resolve commands: override (workspace settings) → declared (PLAN
    //    artifact `gate-commands` block) → detected (toolchain scan).
    let declared: GateCommandSet = {}
    try {
      const planPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'plan')
      for (const artifact of planPhase?.artifactsJson ?? []) {
        if (!artifact.contentMd) continue
        const parsed = parseGateCommands(artifact.contentMd)
        if (Object.keys(parsed).length > 0) declared = { ...declared, ...parsed }
      }
    } catch (err) {
      bpLog.warn('[verify:quality-gates] Could not read declared gate commands:', err)
    }

    let commands
    try {
      const settings = workspaceRepository.getSettingsByPath(workspacePath)
      commands = resolveGateCommands({
        override: settings?.gateCommands as GateCommandSet | undefined,
        declared,
        detected: scanGateCommands(executionPath)
      })
    } catch (err) {
      bpLog.warn('[verify:quality-gates] Command resolution failed:', err)
      commands = {}
    }

    const gatesAvailable = commands.test !== undefined || commands.smoke !== undefined

    // 2. Feature baseline for the structural gate — same contract as
    //    lead-review's assembleFeatureDiff (settings baseline, merge-base fallback).
    const baselineCommit = this.resolveFeatureBaseline(blueprintId, executionPath)

    // 3. Run the gates. A throw anywhere here must not kill verify — the
    //    agent's own report still stands; record honestly and continue.
    let report: GateReport
    try {
      const ctx: GateTaskContext & {
        workspaceId: string
        baselineCommit: string | null
      } = {
        blueprintId,
        taskId: 'verify',
        workspacePath,
        executionPath,
        plannedFiles: [],
        packet: null,
        commands,
        signal,
        workspaceId,
        baselineCommit
      }

      const commandReport = await runVerifyGates(ctx)
      const structural = await runStructuralGate(ctx, {
        indexWorkspace: (wsId, wsPath) => codeGraphService.indexWorkspace(wsId, wsPath),
        findDeadCode: (wsId, wsPath, opts) => codeGraphService.findDeadCode(wsId, wsPath, opts),
        findCircularDependencies: (wsId, opts) =>
          codeGraphService.findCircularDependencies(wsId, opts)
      })

      report = buildGateReport([...commandReport.gates, structural], {
        startedAt: commandReport.startedAt
      })
    } catch (err) {
      bpLog.warn('[verify:quality-gates] Gate run threw — recording unverifiable:', err)
      report = buildGateReport([
        {
          name: 'full-suite',
          verdict: 'unverifiable',
          reason: 'command_error',
          evidence: boundEvidence([
            `gate engine error: ${err instanceof Error ? err.message : String(err)}`
          ]),
          durationMs: 0
        }
      ])
    }

    // 4. Persist as a `verify-gates` artifact on the verify phase record
    //    (mirrors P1.1 wave-gates; survives reload). Best-effort.
    try {
      const verifyPhaseRec = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'verify')
      if (verifyPhaseRec) {
        blueprintPhaseRepository.appendArtifact(verifyPhaseRec.id, {
          type: 'verify-gates',
          contentJson: { report }
        })
      }
    } catch (err) {
      bpLog.warn(`[verify:quality-gates] Could not persist verify-gates artifact:`, err)
    }

    // 5. Map outcomes: fails → error findings; unverifiable → ledger + warning.
    for (const gate of report.gates) {
      if (gate.verdict === 'fail') {
        findings.push({
          source: 'deterministic-quality-gate',
          severity: 'error',
          gate: gate.name,
          description: `${gate.evidence[0] ?? `${gate.name} gate failed`}: ${gate.evidence
            .slice(1)
            .join('\n')
            .slice(0, 2048)}`
        })
      }
    }

    const ledgerItems = ledgerItemsFrom(report, 'verify')
    if (ledgerItems.length > 0) {
      try {
        blueprintRepository.appendUnverified(blueprintId, ledgerItems)
      } catch (err) {
        bpLog.warn('[verify:quality-gates] Ledger append failed:', err)
      }
      this.safeEmit('phaseProgress', {
        blueprintId,
        workspaceId,
        phase: 'verify',
        text:
          `⚠ Verify: ${ledgerItems.length} check(s) could not be verified ` +
          `(${ledgerItems.map((i) => `${i.gate}/${i.reason}`).join(', ')}) — continuing, recorded as unproven`,
        kind: 'system'
      })
    }

    // 6. Structural warnings → warning-severity findings (never fail).
    const structuralGate = report.gates.find((g) => g.name === 'structural')
    if (structuralGate && structuralGate.verdict === 'pass' && structuralGate.counts) {
      const dead = structuralGate.counts.deadCode ?? 0
      const cycles = structuralGate.counts.cycles ?? 0
      if (dead + cycles > 0) {
        findings.push({
          source: 'deterministic-quality-gate',
          severity: 'warning',
          gate: 'structural',
          description: `Structural analysis found ${dead} new dead-code symbol(s) and ${cycles} import cycle(s) in changed files:\n${structuralGate.evidence.join('\n').slice(0, 2048)}`
        })
      }
    }

    bpLog.info(
      `[verify:quality-gates] ${blueprintId} → ${report.overall} ` +
        `(${report.gates.map((g) => `${g.name}:${g.verdict}`).join(' ')})`
    )

    return {
      failed: findings.some((f) => f.severity === 'error'),
      gatesAvailable,
      findings
    }
  }

  /**
   * Feature baseline for the structural gate — `settingsJson.buildBaselineCommit`
   * with merge-base fallback, the same contract as lead-review's
   * `assembleFeatureDiff`. Null when neither resolves (⇒ structural `no_git`).
   */
  private resolveFeatureBaseline(blueprintId: string, executionPath: string): string | null {
    try {
      const blueprint = blueprintRepository.findById(blueprintId)
      const settings = (blueprint?.settingsJson ?? {}) as Record<string, unknown>
      if (typeof settings.buildBaselineCommit === 'string' && settings.buildBaselineCommit) {
        return settings.buildBaselineCommit
      }
      const mb = gitSync(['merge-base', 'HEAD', 'main'], executionPath)
      return mb?.trim() || null
    } catch {
      return null
    }
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
          if (source === 'deterministic-disk-check' || source === 'deterministic-disk-check-drift')
            continue

          const desc = String(finding.description ?? finding.issue ?? '')
          let files = Array.isArray(finding.files) ? finding.files.map(String) : []

          // A quality-gate finding with no error text after the "(exit N): "
          // marker is unactionable by construction — remediating it produces an
          // empty task that fails the same gate again, forever. Drop it.
          if (source === 'deterministic-quality-gate') {
            const bodyStart = desc.indexOf('): ')
            if (bodyStart !== -1 && desc.slice(bodyStart + 3).trim().length === 0) {
              bpLog.warn(
                `[verify:remediation] Skipping empty-bodied quality-gate finding: ${desc.slice(0, 120)}`
              )
              continue
            }
          }

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
        // REMEDIATION-SCRAPE FILTER: blueprint metadata prose is not a gap.
        if (file && !isNonRemediablePath(file)) gapFiles.add(file)
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
          clarifyQA = qaEvents
            .map((e: any) => ({
              question: e.content?.question ?? e.content ?? '',
              answer: e.content?.answer ?? ''
            }))
            .filter((qa: any) => qa.question)
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
