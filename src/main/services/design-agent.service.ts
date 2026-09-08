/**
 * DesignAgentService — orchestrator for Impeccable-powered design runs.
 *
 * Structurally a sibling of `AuditAgentService`: per-workspace state so runs in
 * different workspaces can proceed independently, sequential execution within a
 * workspace, multi-round coverage-tracked sessions, and the same
 * `progress` / `result` / `intermediate_findings` / `stream` / `complete`
 * event surface the IPC layer already knows how to forward.
 *
 * ── Execution order: detector, then critique, then audit ─────────────────────
 * The deterministic detector runs FIRST and its output is injected into the
 * agent prompts for every subsequent command. That ordering is the whole point:
 * the agent is told what a static scan already caught, so it spends its budget
 * looking for the deeper problems those hits imply instead of re-reporting
 * `border-left: 3px solid` by hand.
 *
 * `critique` precedes `audit` because critique is the broad "is this design any
 * good" pass; audit is the narrower technical sweep.
 *
 * ── Storage ─────────────────────────────────────────────────────────────────
 * Design runs reuse audit storage: one `audit_runs` row with `kind = 'design'`
 * and one `audit_results` row per executed command, keyed
 * `trackId = 'design:<commandId>'`. That encoding is only representable because
 * P2.8 widened `AuditTrackId`.
 */

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import log from 'electron-log'
import type {
  AgentStatus,
  AuditApplicability,
  AuditCoverageStats,
  AuditFinding,
  AuditorStatus,
  AuditTrackId,
  DesignCommandId,
  DesignRunConfig,
  LLMProvider
} from '../../shared/types'
import type { StreamChunk } from './agent-base.service'
import {
  evaluateCommandsSelected,
  getDesignCommand,
  refineCommandsSelected,
  toDesignTrackId
} from '../../shared/design-commands'
import { AgentSessionService } from './agent-session.service'
import { DesignRoleAdapter } from './role-adapters/design.adapter'
import { AuditCoverageTracker } from './audit-coverage-tracker'
import {
  applyCoverageGate,
  inferScoreFromFindings,
  parseAuditResponse
} from './audit-response-parser'
import { discoverDesignFiles } from './design-discovery.service'
import {
  readDesignContextFiles,
  summarizeDetectorFindings,
  type DesignContextFiles
} from './design-prompt-templates'
import { DETECTOR_SOURCE, runDetection } from './impeccable-detector.service'
import { ensureProvisioned, getProvisionState } from './impeccable-provision.service'

const designLog = log.scope('design-agent')

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_RETRIES = 1
const RETRY_DELAY_MS = 2000

/**
 * Execution order for evaluate commands.
 *
 * Fixed rather than taken from the user's click order: the prompt for a later
 * command references what earlier ones found, so a stable order keeps runs
 * reproducible.
 */
const EVALUATE_ORDER: readonly DesignCommandId[] = ['critique', 'audit']

/**
 * Fallback when a selection contains no evaluate command.
 *
 * Refine cards (`animate`, `polish`, …) are routing signals only — they never
 * execute. A selection of nothing but refine cards would otherwise produce a run
 * with zero result rows and nothing to hand to a blueprint, so the broad
 * evaluation pass is run instead and the refine cards shape its prompt.
 */
const FALLBACK_EVALUATE_COMMAND: DesignCommandId = 'critique'

// ── Event payloads ───────────────────────────────────────────────────────────

/**
 * Every payload carries `workspaceId`.
 *
 * This service is a singleton emitter and runs are per-workspace concurrent, so
 * a listener wired for workspace A receives workspace B's events too. Without
 * the id there is nothing to filter on, and A's listener persists B's findings
 * into A's run row.
 */
export interface DesignProgressPayload {
  workspaceId: string
  trackId: AuditTrackId
  status: AuditorStatus
  score?: number
  streamChunk?: string
}

export interface DesignResultPayload {
  workspaceId: string
  trackId: AuditTrackId
  score: number
  status: AuditorStatus
  findings: AuditFinding[]
  summary: string
  skillsUsed: string[]
  coverageStats?: AuditCoverageStats
  coverageSufficient?: boolean
  applicability?: AuditApplicability
}

export interface DesignIntermediateFindingsPayload {
  workspaceId: string
  trackId: AuditTrackId
  findings: AuditFinding[]
  coverageStats: AuditCoverageStats
  roundNumber: number
  totalRounds: number
  totalFiles: number
  batchSize: number
}

export interface DesignCompletePayload {
  workspaceId: string
  overallScore: number | null
}

/** Raw chunk passthrough for the live run view. */
export interface DesignStreamPayload {
  workspaceId: string
  trackId: AuditTrackId
  chunk: StreamChunk
}

// ── Per-workspace state ──────────────────────────────────────────────────────

interface DesignWorkspaceState {
  running: boolean
  abortController: AbortController | null
  session: AgentSessionService | null
  lastConversationId?: string
}

// ── Detector / LLM merge (P3.4) ──────────────────────────────────────────────

/**
 * Reduce a finding title to comparable form: lowercase, alphanumeric only.
 *
 * Deliberately NOT truncated. Slicing both titles to a fixed width cannot make
 * a short title match a longer one that extends it ("sidetabaccentborder" vs
 * "sidetabaccentbordersoncards"), which would make suppression silently never
 * fire. Length-sensitive comparison lives in `titlesMatch`.
 */
export function normalizeTitleKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * Minimum shared prefix before two differently-phrased titles count as the same
 * issue. Short enough to catch real rephrasings, long enough that generic
 * openers do not collapse unrelated findings.
 */
const MIN_TITLE_OVERLAP = 12

/**
 * True when two normalised titles plausibly describe the same issue.
 *
 * An agent writes "Side-tab accent borders on cards" where the detector writes
 * "Side-tab accent border" — the same finding, phrased differently. Exact
 * equality would never match those, so one title prefixing the other counts,
 * provided the shared prefix is substantial.
 */
export function titlesMatch(a: string, b: string): boolean {
  if (a === b) return true
  const shorter = a.length <= b.length ? a : b
  const longer = a.length <= b.length ? b : a
  return shorter.length >= MIN_TITLE_OVERLAP && longer.startsWith(shorter)
}

/**
 * Merge detector findings into the LLM findings for one command.
 *
 * ── Why grouping is per (file, rule) and not per finding ─────────────────────
 * Detector findings are POSITIONAL: one rule legitimately fires many times in a
 * file (this repo's `main.css` has three distinct `side-tab` hits, at lines 480,
 * 502 and 604). De-duplicating on `filePath + title` alone would collapse those
 * three into one and silently discard two real findings.
 *
 * So a detector rule contributes ALL of its occurrences, and is suppressed only
 * when the agent already reported that same rule in that same file — in which
 * case the agent's richer, contextual write-up wins and the whole group drops.
 *
 * Detector titles are 1:1 with their rule id (the engine derives `name` from
 * `antipattern`), so grouping on `filePath + title` groups by rule exactly.
 */
export function mergeDetectorFindings(
  llmFindings: AuditFinding[],
  detectorFindings: AuditFinding[]
): AuditFinding[] {
  if (detectorFindings.length === 0) return llmFindings

  // What the agent already covered, per file.
  const llmKeysByFile = new Map<string, string[]>()
  for (const finding of llmFindings) {
    if (!finding.filePath) continue
    const keys = llmKeysByFile.get(finding.filePath)
    if (keys) keys.push(normalizeTitleKey(finding.title))
    else llmKeysByFile.set(finding.filePath, [normalizeTitleKey(finding.title)])
  }

  // Group detector findings by file + rule, preserving order within a group.
  const groups = new Map<string, AuditFinding[]>()
  for (const finding of detectorFindings) {
    const groupKey = `${finding.filePath ?? ''}|${normalizeTitleKey(finding.title)}`
    const group = groups.get(groupKey)
    if (group) group.push(finding)
    else groups.set(groupKey, [finding])
  }

  const kept: AuditFinding[] = []
  for (const group of groups.values()) {
    const sample = group[0]
    const sampleKey = normalizeTitleKey(sample.title)
    const covered =
      sample.filePath != null &&
      (llmKeysByFile.get(sample.filePath) ?? []).some((key) => titlesMatch(key, sampleKey))
    if (covered) {
      designLog.info(
        `[design] detector rule "${sample.title}" in ${sample.filePath} already covered by the agent — ` +
          `dropping ${group.length} detector finding(s)`
      )
      continue
    }
    kept.push(...group)
  }

  return [...llmFindings, ...kept]
}

// ── Service ──────────────────────────────────────────────────────────────────

export class DesignAgentService extends EventEmitter {
  private workspaceStates = new Map<string, DesignWorkspaceState>()

  /** True when ANY workspace has a design run in flight. */
  get isRunning(): boolean {
    for (const state of this.workspaceStates.values()) {
      if (state.running) return true
    }
    return false
  }

  isRunningForWorkspace(workspaceId: string): boolean {
    return this.workspaceStates.get(workspaceId)?.running ?? false
  }

  private getOrCreateState(workspaceId: string): DesignWorkspaceState {
    let state = this.workspaceStates.get(workspaceId)
    if (!state) {
      state = { running: false, abortController: null, session: null }
      this.workspaceStates.set(workspaceId, state)
    }
    return state
  }

  /**
   * The evaluate commands a config will actually execute, in run order.
   *
   * Exported behaviour: the IPC layer calls this to create the matching
   * `audit_results` rows, so the rows and the execution agree by construction
   * rather than by two lists being kept in sync by hand.
   */
  static resolveExecutableCommands(config: DesignRunConfig): DesignCommandId[] {
    const selected = new Set(evaluateCommandsSelected(config.commandIds))
    const ordered = EVALUATE_ORDER.filter((id) => selected.has(id))
    return ordered.length > 0 ? ordered : [FALLBACK_EVALUATE_COMMAND]
  }

  /**
   * Run a full design pass. Emits `progress`, `result`, `complete`.
   *
   * Never throws: a failure inside one command is reported as a failed result
   * for that command and the run continues.
   */
  async runDesign(params: {
    workspaceId: string
    workspacePath: string
    config: DesignRunConfig
    designRunId: string
    llmProvider?: LLMProvider
  }): Promise<void> {
    const state = this.getOrCreateState(params.workspaceId)

    if (state.running) {
      designLog.warn(`[design] already running for workspace ${params.workspaceId} — ignoring`)
      return
    }

    state.running = true
    state.abortController = new AbortController()

    const completedResults: DesignResultPayload[] = []

    // Everything from here is wrapped: anything that throws between the guard
    // and the loop — a discovery walk over an unreadable directory, say — would
    // otherwise leave `running: true` forever (a permanent lockout for this
    // workspace) and never emit `complete`, leaking the IPC listeners with it.
    try {
      const commands = DesignAgentService.resolveExecutableCommands(params.config)
      const refineCommands = refineCommandsSelected(params.config.commandIds)
      const contextFiles = readDesignContextFiles(params.workspacePath)

      const discovery = discoverDesignFiles(params.workspacePath, params.config.scope)

      designLog.info(
        `[design] run ${params.designRunId}: commands=${commands.join(',')} ` +
          `refine=${refineCommands.join(',') || 'none'} files=${discovery.totalFiles}`
      )

      // ── Skill payload before any prompt is assembled ──
      await this.provisionSkill(params.workspaceId, commands[0])

      // ── Detector next, so its output can seed every agent prompt ──
      const detection = await this.runDetectorPhase(params, commands[0])

      for (const commandId of commands) {
        const trackId = toDesignTrackId(commandId)

        // Detector findings attach to the first command only — the detector
        // runs once per run, so repeating its findings on every command would
        // multiply them in the UI and in the blueprint brief.
        const ownedDetectorFindings = commandId === commands[0] ? detection.findings : []

        if (state.abortController.signal.aborted) {
          this.emit('progress', {
            workspaceId: params.workspaceId,
            trackId,
            status: 'cancelled'
          } satisfies DesignProgressPayload)
          continue
        }

        this.emit('progress', {
          workspaceId: params.workspaceId,
          trackId,
          status: 'running'
        } satisfies DesignProgressPayload)

        try {
          const result = await this.runSingleCommand({
            workspaceId: params.workspaceId,
            workspacePath: params.workspacePath,
            commandId,
            config: params.config,
            refineCommands,
            contextFiles,
            discovery,
            detectorFindings: ownedDetectorFindings,
            detectorSummary: detection.summary,
            llmProvider: params.llmProvider,
            state
          })

          completedResults.push(result)
          this.emit('result', result)
        } catch (err) {
          // Carry the detector findings this command owned. An exhausted-retry
          // critique must not discard the entire deterministic scan — it is
          // evidence the agent half never touched.
          this.emit('result', {
            workspaceId: params.workspaceId,
            trackId,
            score: 0,
            status: 'failed',
            findings: ownedDetectorFindings,
            summary: err instanceof Error ? err.message : String(err),
            skillsUsed: ownedDetectorFindings.length > 0 ? [DETECTOR_SOURCE] : []
          } satisfies DesignResultPayload)
        }
      }
    } catch (err) {
      // Contract: `runDesign` never throws. The `finally` below still runs, so
      // the run is reported complete with whatever it managed to produce.
      designLog.error(`[design] run ${params.designRunId} failed before completion:`, err)
    } finally {
      state.running = false
      state.abortController = null
      // Single emit point, so `complete` fires exactly once per run by
      // construction rather than by every exit path remembering to.
      this.emit('complete', {
        workspaceId: params.workspaceId,
        overallScore: calculateDesignScore(completedResults)
      } satisfies DesignCompletePayload)
    }
  }

  /**
   * Ensure the Impeccable skill markdown is on disk before any prompt is built.
   *
   * Silent degradation is the failure mode worth engineering against: without
   * the payload `buildImpeccableLayer()` returns `''` and the run still produces
   * a fluent, plausible-looking review — with none of the Impeccable design
   * knowledge in it and no signal that anything was missing. Both the first-run
   * install and every failure are therefore narrated into the run's own stream.
   *
   * `ensureProvisioned` never throws, fast-paths on a matching stamp, shares one
   * in-flight install between concurrent callers, and cools down after failure.
   */
  private async provisionSkill(workspaceId: string, firstCommand: DesignCommandId): Promise<void> {
    const trackId = toDesignTrackId(firstCommand)

    if (!getProvisionState().provisioned) {
      // The first run downloads the payload. Say so, or a 30 s stall before the
      // first token looks like the app has hung.
      this.emit('progress', {
        workspaceId,
        trackId,
        status: 'running',
        streamChunk:
          '📦 Installing the Impeccable design skill (first run — this downloads, so it can take up to a minute)...\n\n'
      } satisfies DesignProgressPayload)
    }

    const result = await ensureProvisioned()
    if (result.status === 'ready') return

    designLog.warn(
      `[design] impeccable skill ${result.status}: ${result.reason ?? 'no reason given'}`
    )
    this.emit('progress', {
      workspaceId,
      trackId,
      status: 'running',
      streamChunk:
        `⚠️ The Impeccable design skill is ${result.status} (${result.reason ?? 'no reason given'}). ` +
        `This review runs WITHOUT the Impeccable design knowledge, so its findings will be generic.\n\n`
    } satisfies DesignProgressPayload)
  }

  /**
   * Run the deterministic detector over the run's scope.
   *
   * Failure here is never fatal: the agent half of a design run is the part that
   * matters, and a missing or broken engine must degrade rather than abort.
   */
  private async runDetectorPhase(
    params: { workspaceId: string; workspacePath: string; config: DesignRunConfig },
    firstCommand: DesignCommandId
  ): Promise<{ findings: AuditFinding[]; summary: string }> {
    const trackId = toDesignTrackId(firstCommand)
    const targets = params.config.scope.mode === 'paths' ? params.config.scope.paths : []
    const state = this.workspaceStates.get(params.workspaceId)

    this.emit('progress', {
      workspaceId: params.workspaceId,
      trackId,
      status: 'running',
      streamChunk: '🔎 Running the Impeccable detector over the selected scope...\n\n'
    } satisfies DesignProgressPayload)

    // The signal makes cancel actually cancel: without it a cancel during this
    // phase still waits out the detector's full 60 s budget.
    const detection = await runDetection(
      params.workspacePath,
      targets,
      state?.abortController?.signal
    )

    if (detection.status !== 'ok') {
      designLog.warn(`[design] detector ${detection.status}: ${detection.reason ?? 'no reason'}`)
      this.emit('progress', {
        workspaceId: params.workspaceId,
        trackId,
        status: 'running',
        streamChunk: `⚠️ Deterministic detector unavailable (${detection.reason ?? detection.status}). Continuing with the design review only.\n\n`
      } satisfies DesignProgressPayload)
      return { findings: [], summary: '' }
    }

    this.emit('progress', {
      workspaceId: params.workspaceId,
      trackId,
      status: 'running',
      streamChunk: `✅ Detector found ${detection.findings.length} issue(s) across ${detection.ruleCount} rule(s).\n\n`
    } satisfies DesignProgressPayload)

    return {
      findings: detection.findings,
      summary: summarizeDetectorFindings(detection.findings)
    }
  }

  /** Cancel the design run for one workspace, or all of them. */
  cancel(workspaceId?: string): void {
    const abort = (state: DesignWorkspaceState): void => {
      state.abortController?.abort()
      if (state.session) {
        try {
          state.session.cancelCurrentQuery(state.lastConversationId)
        } catch {
          /* non-fatal */
        }
      }
    }

    if (workspaceId) {
      designLog.info(`[design] cancel requested for workspace ${workspaceId}`)
      const state = this.workspaceStates.get(workspaceId)
      if (state) abort(state)
    } else {
      designLog.info('[design] cancel all requested')
      for (const [, state] of this.workspaceStates) abort(state)
    }
  }

  // ── Private: one command, with retry ───────────────────────────────────────

  private async runSingleCommand(params: {
    workspaceId: string
    workspacePath: string
    commandId: DesignCommandId
    config: DesignRunConfig
    refineCommands: string[]
    contextFiles: DesignContextFiles
    discovery: { totalFiles: number; filePaths: string[] }
    detectorFindings: AuditFinding[]
    detectorSummary: string
    llmProvider?: LLMProvider
    state: DesignWorkspaceState
  }): Promise<DesignResultPayload> {
    const trackId = toDesignTrackId(params.commandId)

    // A scope with no design-relevant files is not a failure — it is a
    // legitimately empty result, and scoring it would invent a number.
    if (params.discovery.totalFiles === 0) {
      designLog.info(`[design:${params.commandId}] no design-relevant files in scope`)
      return {
        workspaceId: params.workspaceId,
        trackId,
        score: 0,
        status: 'completed',
        findings: params.detectorFindings,
        summary:
          'No design-relevant files were found in the selected scope, so there was nothing to review.',
        skillsUsed: params.detectorFindings.length > 0 ? [DETECTOR_SOURCE] : [],
        applicability: 'not-applicable'
      }
    }

    let lastError: Error | null = null

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        designLog.info(`[design:${params.commandId}] retry ${attempt}/${MAX_RETRIES}`)
        this.emit('progress', {
          workspaceId: params.workspaceId,
          trackId,
          status: 'running',
          streamChunk: `\n\n---\n⚡ Retrying after API error (attempt ${attempt + 1})...\n\n`
        } satisfies DesignProgressPayload)
      }

      try {
        return await this.executeMultiRoundDesign(params)
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        if (!isRetryableError(lastError) || attempt >= MAX_RETRIES) {
          designLog.error(`[design:${params.commandId}] failed:`, lastError)
          throw lastError
        }
        designLog.warn(`[design:${params.commandId}] retryable: ${lastError.message}`)
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
      }
    }

    throw lastError!
  }

  // ── Private: multi-round orchestration ─────────────────────────────────────

  private async executeMultiRoundDesign(params: {
    workspaceId: string
    workspacePath: string
    commandId: DesignCommandId
    config: DesignRunConfig
    refineCommands: string[]
    contextFiles: DesignContextFiles
    discovery: { totalFiles: number; filePaths: string[] }
    detectorFindings: AuditFinding[]
    detectorSummary: string
    llmProvider?: LLMProvider
    state: DesignWorkspaceState
  }): Promise<DesignResultPayload> {
    const trackId = toDesignTrackId(params.commandId)
    const isLocal = params.llmProvider === 'local-llm'
    const batchSize = isLocal ? 3 : 12
    const maxRounds = isLocal ? 15 : 5

    const coverageTracker = new AuditCoverageTracker()
    const llmFindings: AuditFinding[] = []
    let modelScore: number | null = null
    let modelSummary = ''

    this.emit('progress', {
      workspaceId: params.workspaceId,
      trackId,
      status: 'running',
      streamChunk: `📂 ${params.discovery.totalFiles} design-relevant file(s) in scope. Starting review...\n\n`
    } satisfies DesignProgressPayload)

    let remainingFiles = [...params.discovery.filePaths]
    let roundNumber = 0

    while (
      remainingFiles.length > 0 &&
      roundNumber < maxRounds &&
      !params.state.abortController?.signal.aborted
    ) {
      roundNumber++
      const batch = remainingFiles.slice(0, batchSize)

      this.emit('progress', {
        workspaceId: params.workspaceId,
        trackId,
        status: 'running',
        streamChunk: `\n---\n\n🔍 **Round ${roundNumber}/${maxRounds}** — reviewing ${batch.length} file(s)...\n\n`
      } satisfies DesignProgressPayload)

      try {
        const round = await this.runDesignRound({
          ...params,
          batch,
          roundNumber,
          isFirstRound: roundNumber === 1,
          previousFindings: llmFindings,
          remainingFileCount: remainingFiles.length - batch.length,
          coverageTracker
        })

        llmFindings.push(...round.findings)

        const inspected = new Set(coverageTracker.getStats().filesInspected)
        remainingFiles = remainingFiles.filter((f) => !inspected.has(f))

        if (round.score !== null) {
          modelScore = round.score
          modelSummary = round.summary
        }

        const stats = coverageTracker.getStats()

        // Intermediate findings include the detector's, so a crash mid-run still
        // leaves the deterministic results persisted.
        this.emit('intermediate_findings', {
          workspaceId: params.workspaceId,
          trackId,
          findings: mergeDetectorFindings(llmFindings, params.detectorFindings),
          coverageStats: stats,
          roundNumber,
          totalRounds: maxRounds,
          totalFiles: params.discovery.totalFiles,
          batchSize
        } satisfies DesignIntermediateFindingsPayload)

        if (hasAdequateCoverage(llmFindings, stats, params.discovery.totalFiles)) {
          designLog.info(
            `[design:${params.commandId}] adequate coverage after round ${roundNumber}`
          )
          break
        }
      } catch (roundErr) {
        designLog.warn(
          `[design:${params.commandId}] round ${roundNumber} failed:`,
          roundErr instanceof Error ? roundErr.message : roundErr
        )

        if (params.state.abortController?.signal.aborted) break

        const inspected = new Set(coverageTracker.getStats().filesInspected)
        remainingFiles = [
          ...batch.filter((f) => !inspected.has(f)),
          ...remainingFiles.slice(batch.length)
        ]

        if (llmFindings.length === 0 && roundNumber === 1) throw roundErr

        this.emit('progress', {
          workspaceId: params.workspaceId,
          trackId,
          status: 'running',
          streamChunk: `\n\n⚠️ Round ${roundNumber} hit an error. Continuing with the next batch...\n\n`
        } satisfies DesignProgressPayload)
      }
    }

    // ── Gate on the AGENT's findings only ──
    // The coverage gate exists to catch an agent that scored without looking.
    // Detector findings are deterministic output, not agent evidence, so folding
    // them in before the gate would let a scan of zero files pass the gate on
    // the detector's work. They are merged back in after gating.
    const stats = coverageTracker.getStats()
    const finalScore =
      modelScore ??
      (() => {
        const inferred = inferScoreFromFindings(llmFindings)
        return llmFindings.some((f) => f.severity !== 'info') ? inferred : Math.min(inferred, 50)
      })()

    const gated = applyCoverageGate(
      {
        score: finalScore,
        summary:
          modelSummary ||
          `Design review completed in ${roundNumber} round(s). ${llmFindings.length} finding(s) across ${stats.fileCount} file(s).`,
        findings: llmFindings
      },
      stats
    )
    gated.coveragePercent =
      params.discovery.totalFiles > 0
        ? Math.round((stats.fileCount / params.discovery.totalFiles) * 100)
        : null

    const applicability: AuditApplicability =
      params.discovery.totalFiles === 0 || stats.fileCount === 0
        ? 'not-applicable'
        : gated.isSufficient
          ? 'ok'
          : 'insufficient'

    // Claim the skill only when it was actually there to be used. Provisioning
    // can fail, in which case `buildImpeccableLayer()` returned '' and the run
    // carried no Impeccable knowledge at all — recording 'impeccable' anyway
    // would make a degraded run indistinguishable from a good one, in the UI
    // and in every downstream report.
    const skillsUsed: string[] = []
    if (getProvisionState().provisioned) skillsUsed.push('impeccable')
    if (params.detectorFindings.length > 0) skillsUsed.push(DETECTOR_SOURCE)

    return {
      workspaceId: params.workspaceId,
      trackId,
      score: gated.score,
      status: 'completed',
      findings: mergeDetectorFindings(gated.findings, params.detectorFindings),
      summary: gated.summary,
      skillsUsed,
      coverageStats: gated.coverageStats,
      coverageSufficient: gated.isSufficient,
      applicability
    }
  }

  // ── Private: one round ─────────────────────────────────────────────────────

  private async runDesignRound(params: {
    workspaceId: string
    workspacePath: string
    commandId: DesignCommandId
    config: DesignRunConfig
    refineCommands: string[]
    contextFiles: DesignContextFiles
    detectorSummary: string
    batch: string[]
    roundNumber: number
    isFirstRound: boolean
    previousFindings: AuditFinding[]
    remainingFileCount: number
    coverageTracker: AuditCoverageTracker
    llmProvider?: LLMProvider
    state: DesignWorkspaceState
  }): Promise<{ findings: AuditFinding[]; score: number | null; summary: string }> {
    const trackId = toDesignTrackId(params.commandId)

    const adapter = new DesignRoleAdapter({
      workspaceId: params.workspaceId,
      commandId: params.commandId,
      brief: params.config.brief,
      scopeMode: params.config.scope.mode,
      scopePaths: params.isFirstRound ? params.config.scope.paths : params.batch,
      refineCommands: params.refineCommands,
      productMd: params.contextFiles.productMd,
      designMd: params.contextFiles.designMd,
      detectorSummary: params.detectorSummary,
      roundContext: params.isFirstRound
        ? undefined
        : {
            roundNumber: params.roundNumber,
            fileBatch: params.batch,
            previousFindingsSummary: summarizePreviousFindings(params.previousFindings),
            remainingFileCount: params.remainingFileCount
          },
      llmProvider: params.llmProvider
    })

    const session = new AgentSessionService(adapter)
    params.state.session = session

    session.on('chunk', (chunk: StreamChunk) => {
      params.coverageTracker.onChunk(chunk)

      if (chunk.type === 'error' && chunk.error) {
        designLog.error(`[design:${params.commandId}] error chunk: ${chunk.error.slice(0, 300)}`)
        this.emit('progress', {
          workspaceId: params.workspaceId,
          trackId,
          status: 'running',
          streamChunk: `\n⚠️ Error: ${chunk.error.slice(0, 200)}\n`
        } satisfies DesignProgressPayload)
        return
      }

      if (chunk.type === 'auth_status' && chunk.content) {
        this.emit('progress', {
          workspaceId: params.workspaceId,
          trackId,
          status: 'running',
          streamChunk: `\n🔑 ${chunk.content}\n`
        } satisfies DesignProgressPayload)
        return
      }

      if (chunk.type === 'text' && chunk.content) {
        this.emit('progress', {
          workspaceId: params.workspaceId,
          trackId,
          status: 'running',
          streamChunk: chunk.content
        } satisfies DesignProgressPayload)
      }
      this.emit('stream', {
        workspaceId: params.workspaceId,
        trackId,
        chunk
      } satisfies DesignStreamPayload)
    })

    session.on('statusUpdate', (status: AgentStatus) => {
      this.emit('status', { workspaceId: params.workspaceId, status })
    })

    try {
      await session.start(params.workspacePath, 'plan')

      const message = params.isFirstRound
        ? 'Begin your design review.'
        : buildContinuationPrompt(params.commandId, params)

      const syntheticConvId = `design-${params.commandId}-r${params.roundNumber}-${Date.now()}`
      params.state.lastConversationId = syntheticConvId
      await session.send(message, syntheticConvId, [])

      const responseText = session.getStreamedContent(syntheticConvId)
      const parsed = parseAuditResponse(responseText)

      if (params.isFirstRound && parsed.score === 0 && parsed.findings.length === 0) {
        designLog.error(
          `[design:${params.commandId}] round 1 produced a ${responseText.length}-char response with 0 findings`
        )
        return {
          findings: [
            {
              id: randomUUID(),
              severity: 'info' as const,
              title: `${params.commandId} design review could not complete`,
              description:
                `The reviewer received an empty or unparseable response (${responseText.length} chars) from the LLM. ` +
                `This usually indicates a CLI authentication issue, an API rate limit, or invalid CLI flags.`,
              recommendation:
                'Verify CLI access: run "claude --version" and "claude -p hello" in your terminal.'
            }
          ],
          score: null,
          summary: 'Design review could not complete — empty LLM response.'
        }
      }

      return {
        findings: parsed.findings,
        score: parsed.score > 0 ? parsed.score : null,
        summary: parsed.summary
      }
    } finally {
      try {
        await session.stop()
      } catch {
        /* best-effort cleanup */
      }
      params.state.session = null
    }
  }

  /** Graceful shutdown — cancel everything and clear state. Called on app quit. */
  async shutdown(): Promise<void> {
    designLog.info(`[design] shutdown — ${this.workspaceStates.size} active state(s)`)
    this.cancel()
    this.workspaceStates.clear()
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isRetryableError(err: Error): boolean {
  const msg = err.message.toLowerCase()
  return (
    msg.includes('400') ||
    msg.includes('empty thinking') ||
    msg.includes('invalid_request_error') ||
    msg.includes('overloaded') ||
    msg.includes('529') ||
    msg.includes('rate_limit') ||
    msg.includes('timeout')
  )
}

function summarizePreviousFindings(findings: AuditFinding[]): string {
  if (findings.length === 0) return 'no findings yet'
  return findings
    .slice(-10)
    .map((f) => `- [${f.severity.toUpperCase()}] ${f.title}${f.filePath ? ` (${f.filePath})` : ''}`)
    .join('\n')
}

function buildContinuationPrompt(
  commandId: DesignCommandId,
  params: { batch: string[]; previousFindings: AuditFinding[]; remainingFileCount: number }
): string {
  const name = getDesignCommand(commandId)?.name ?? commandId
  return (
    `Continue your ${name} review.\n\n` +
    `## Already Reviewed\n${params.previousFindings.length} finding(s) so far:\n` +
    `${summarizePreviousFindings(params.previousFindings)}\n\n` +
    `## Remaining Work\n${params.remainingFileCount} file(s) still to review. Focus on these now:\n` +
    `${params.batch.map((f) => `- ${f}`).join('\n')}\n\n` +
    `Emit audit-finding blocks for each file you review. Finish with an audit-score block.`
  )
}

function hasAdequateCoverage(
  findings: AuditFinding[],
  stats: AuditCoverageStats,
  totalFiles: number
): boolean {
  const coveragePercent = totalFiles > 0 ? stats.fileCount / totalFiles : 0
  return findings.length >= 8 && coveragePercent >= 0.6
}

/**
 * Unweighted mean across commands.
 *
 * Unlike Workspace Health there is no per-track weight table: the design
 * commands are peers, so an average is the honest summary. Commands whose
 * coverage was insufficient are excluded so a hallucinated score cannot drag
 * the run down.
 */
function calculateDesignScore(results: DesignResultPayload[]): number | null {
  const usable = results.filter(
    (r) =>
      r.status === 'completed' &&
      r.coverageSufficient !== false &&
      r.applicability !== 'not-applicable'
  )
  if (usable.length === 0) return null
  return Math.round(usable.reduce((sum, r) => sum + r.score, 0) / usable.length)
}

export const designAgentService = new DesignAgentService()
