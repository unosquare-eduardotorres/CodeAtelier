/**
 * AuditAgentService — multi-workspace orchestrator for workspace health audits.
 *
 * Maintains per-workspace state so audits can run concurrently across different
 * workspaces. Each workspace gets its own running flag, abort controller, and
 * active session. Events are tagged with workspaceId for IPC routing.
 *
 * Runs auditors sequentially within a workspace (one at a time), each with
 * multi-round coverage-tracked sessions. Emits 'progress', 'result',
 * 'intermediate_findings', 'stream', and 'complete' events for the IPC layer.
 */

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import log from 'electron-log'
import type {
  AuditMode,
  AuditTrackId,
  AuditFinding,
  AuditorStatus,
  AuditTrack,
  AuditApplicability,
  AuditCoverageStats,
  LLMProvider
} from '../../shared/types'
import type { StreamChunk } from './agent-base.service'
import { AUDIT_TRACKS } from '../../shared/constants'
import { AgentSessionService } from './agent-session.service'
import { AuditRoleAdapter } from './role-adapters/audit.adapter'
import {
  parseAuditResponse,
  inferScoreFromFindings,
  applyCoverageGate
} from './audit-response-parser'
import { modelConfigService } from './model-config.service'
import { AuditCoverageTracker } from './audit-coverage-tracker'
import { discoverAuditableFiles } from './audit-discovery.service'

const auditLog = log.scope('audit-agent')

// ── Constants ─────────────────────────────────────────────────────────────

const MAX_RETRIES = 1
const RETRY_DELAY_MS = 2000

// ── Event payloads ─────────────────────────────────────────────────────────

export interface AuditProgressPayload {
  trackId: AuditTrackId
  status: AuditorStatus
  score?: number
  streamChunk?: string
}

export interface AuditResultPayload {
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

export interface AuditIntermediateFindingsPayload {
  trackId: AuditTrackId
  findings: AuditFinding[]
  coverageStats: AuditCoverageStats
  roundNumber: number
  totalRounds: number
  totalFiles: number
  batchSize: number
}

export interface AuditCompletePayload {
  overallScore: number | null
}

// ── Per-workspace state ───────────────────────────────────────────────────

interface AuditWorkspaceState {
  running: boolean
  abortController: AbortController | null
  session: AgentSessionService | null
}

// ── Service ────────────────────────────────────────────────────────────────

export class AuditAgentService extends EventEmitter {
  private workspaceStates = new Map<string, AuditWorkspaceState>()

  /** Check if ANY audit is running (backward compat). */
  get isRunning(): boolean {
    for (const state of this.workspaceStates.values()) {
      if (state.running) return true
    }
    return false
  }

  /** Check if a specific workspace has a running audit. */
  isRunningForWorkspace(workspaceId: string): boolean {
    return this.workspaceStates.get(workspaceId)?.running ?? false
  }

  private getOrCreateState(workspaceId: string): AuditWorkspaceState {
    let state = this.workspaceStates.get(workspaceId)
    if (!state) {
      state = { running: false, abortController: null, session: null }
      this.workspaceStates.set(workspaceId, state)
    }
    return state
  }

  /**
   * Run a full audit: iterate selected tracks sequentially.
   * Emits: 'progress', 'result', 'complete'
   */
  async runAudit(params: {
    workspaceId: string
    workspacePath: string
    mode: AuditMode
    selectedTracks: AuditTrackId[]
    auditRunId: string
    llmProvider?: LLMProvider
  }): Promise<void> {
    const state = this.getOrCreateState(params.workspaceId)

    if (state.running) {
      auditLog.warn(`[audit] Already running for workspace ${params.workspaceId} — ignoring`)
      return
    }

    state.running = true
    state.abortController = new AbortController()

    const completedResults: AuditResultPayload[] = []

    for (const trackId of params.selectedTracks) {
      if (state.abortController.signal.aborted) {
        this.emit('progress', {
          trackId,
          status: 'cancelled'
        } satisfies AuditProgressPayload)
        continue
      }

      // Signal: running
      this.emit('progress', {
        trackId,
        status: 'running'
      } satisfies AuditProgressPayload)

      try {
        const result = await this.runSingleAuditor({
          workspaceId: params.workspaceId,
          workspacePath: params.workspacePath,
          trackId,
          mode: params.mode,
          llmProvider: params.llmProvider
        })

        completedResults.push(result)
        this.emit('result', result)
      } catch (err) {
        const failResult: AuditResultPayload = {
          trackId,
          score: 0,
          status: 'failed',
          findings: [],
          summary: err instanceof Error ? err.message : String(err),
          skillsUsed: []
        }
        this.emit('result', failResult)
      }
    }

    // Calculate overall score
    const overallScore = calculateOverallScore(completedResults, AUDIT_TRACKS)

    state.running = false
    state.abortController = null
    this.emit('complete', { overallScore } satisfies AuditCompletePayload)
  }

  /** Cancel the running audit for a specific workspace (or all if no workspaceId). */
  cancel(workspaceId?: string): void {
    if (workspaceId) {
      auditLog.info(`[audit] Cancel requested for workspace ${workspaceId}`)
      const state = this.workspaceStates.get(workspaceId)
      if (state) {
        state.abortController?.abort()
        if (state.session) {
          try {
            state.session.cancelCurrentQuery()
          } catch {
            /* non-fatal */
          }
        }
      }
    } else {
      // Cancel all (backward compat)
      auditLog.info('[audit] Cancel all requested')
      for (const [, state] of this.workspaceStates) {
        state.abortController?.abort()
        if (state.session) {
          try {
            state.session.cancelCurrentQuery()
          } catch {
            /* non-fatal */
          }
        }
      }
    }
  }

  /**
   * Run a single track re-run. Emits 'progress', 'result' (no 'complete').
   */
  async runSingleTrack(params: {
    workspaceId: string
    workspacePath: string
    trackId: AuditTrackId
    mode: AuditMode
    llmProvider?: LLMProvider
  }): Promise<void> {
    const state = this.getOrCreateState(params.workspaceId)

    if (state.running) {
      auditLog.warn(`[audit:rerun] Already running for workspace ${params.workspaceId} — ignoring`)
      return
    }

    state.running = true
    state.abortController = new AbortController()

    this.emit('progress', {
      trackId: params.trackId,
      status: 'running'
    } satisfies AuditProgressPayload)

    try {
      const result = await this.runSingleAuditor(params)
      this.emit('result', result)
    } catch (err) {
      const failResult: AuditResultPayload = {
        trackId: params.trackId,
        score: 0,
        status: 'failed',
        findings: [],
        summary: err instanceof Error ? err.message : String(err),
        skillsUsed: []
      }
      this.emit('result', failResult)
    } finally {
      state.running = false
      state.abortController = null
    }
  }

  // ── Private: single auditor execution with retry ──────────────────────

  private async runSingleAuditor(params: {
    workspaceId: string
    workspacePath: string
    trackId: AuditTrackId
    mode: AuditMode
    llmProvider?: LLMProvider
  }): Promise<AuditResultPayload> {
    const state = this.getOrCreateState(params.workspaceId)
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        auditLog.info(`[audit:${params.trackId}] Retry attempt ${attempt}/${MAX_RETRIES}`)
        this.emit('progress', {
          trackId: params.trackId,
          status: 'running',
          streamChunk: `\n\n---\n⚡ Retrying after API error (attempt ${attempt + 1})...\n\n`
        } satisfies AuditProgressPayload)
      }

      try {
        return await this.executeMultiRoundAudit(params, state)
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        const isRetryable = this.isRetryableError(lastError)
        if (!isRetryable || attempt >= MAX_RETRIES) {
          auditLog.error(
            `[audit:${params.trackId}] failed (non-retryable or max retries):`,
            lastError
          )
          throw lastError
        }
        auditLog.warn(`[audit:${params.trackId}] Retryable error: ${lastError.message}`)
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
      }
    }

    throw lastError!
  }

  private isRetryableError(err: Error): boolean {
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

  // ── Private: multi-round audit orchestration ──────────────────────────

  private async executeMultiRoundAudit(
    params: {
      workspaceId: string
      workspacePath: string
      trackId: AuditTrackId
      mode: AuditMode
      llmProvider?: LLMProvider
    },
    state: AuditWorkspaceState
  ): Promise<AuditResultPayload> {
    const isLocal = params.llmProvider === 'local-llm'
    const batchSize = this.getBatchSize(isLocal)
    const maxRounds = this.getMaxRounds(isLocal)

    const discovery = discoverAuditableFiles(params.workspacePath, params.trackId)
    const coverageTracker = new AuditCoverageTracker()
    const allFindings: AuditFinding[] = []
    let modelScore: number | null = null
    let modelSummary = ''

    auditLog.info(
      `[audit:${params.trackId}] Discovery found ${discovery.totalFiles} files, batch=${batchSize}, maxRounds=${maxRounds}`
    )

    this.emit('progress', {
      trackId: params.trackId,
      status: 'running',
      streamChunk: `📂 Discovered ${discovery.totalFiles} relevant files (${discovery.priorityFiles.length} priority). Starting multi-round inspection...\n\n`
    } satisfies AuditProgressPayload)

    let remainingFiles = [...discovery.filePaths]
    let roundNumber = 0

    while (
      remainingFiles.length > 0 &&
      roundNumber < maxRounds &&
      !state.abortController?.signal.aborted
    ) {
      roundNumber++
      const batch = remainingFiles.slice(0, batchSize)

      this.emit('progress', {
        trackId: params.trackId,
        status: 'running',
        streamChunk:
          roundNumber === 1
            ? `\n---\n\n🔍 **Round ${roundNumber}/${maxRounds}** — Inspecting ${batch.length} files...\n\n`
            : `\n\n---\n\n🔄 **Round ${roundNumber}/${maxRounds}** — Inspecting next ${batch.length} files (${remainingFiles.length - batch.length} remaining)...\n\n`
      } satisfies AuditProgressPayload)

      try {
        const roundResult = await this.runAuditRound({
          workspaceId: params.workspaceId,
          workspacePath: params.workspacePath,
          trackId: params.trackId,
          mode: params.mode,
          batch,
          roundNumber,
          previousFindings: allFindings,
          remainingFileCount: remainingFiles.length - batch.length,
          coverageTracker,
          isFirstRound: roundNumber === 1,
          llmProvider: params.llmProvider
        }, state)

        allFindings.push(...roundResult.findings)

        const inspected = new Set(coverageTracker.getStats().filesInspected)
        remainingFiles = remainingFiles.filter((f) => !inspected.has(f))

        if (roundResult.score !== null) {
          modelScore = roundResult.score
          modelSummary = roundResult.summary
        }

        const stats = coverageTracker.getStats()
        this.emit('progress', {
          trackId: params.trackId,
          status: 'running',
          streamChunk: `\n\n📊 Round ${roundNumber}: ${roundResult.findings.length} finding(s), ${stats.fileCount}/${discovery.totalFiles} files covered` +
            (roundResult.findings.length === 0 && stats.toolCallCount === 0
              ? ` ⚠️ No tool calls detected — the LLM may not have responded properly.\n\n`
              : `\n\n`)
        } satisfies AuditProgressPayload)

        this.emit('intermediate_findings', {
          trackId: params.trackId,
          findings: allFindings,
          coverageStats: stats,
          roundNumber,
          totalRounds: maxRounds,
          totalFiles: discovery.totalFiles,
          batchSize
        } satisfies AuditIntermediateFindingsPayload)

        if (this.hasAdequateCoverage(allFindings, stats, discovery.totalFiles)) {
          auditLog.info(
            `[audit:${params.trackId}] Adequate coverage reached after round ${roundNumber}`
          )
          break
        }
      } catch (roundErr) {
        auditLog.warn(
          `[audit:${params.trackId}] Round ${roundNumber} failed:`,
          roundErr instanceof Error ? roundErr.message : roundErr
        )

        if (state.abortController?.signal.aborted) {
          auditLog.info(`[audit:${params.trackId}] Aborted — stopping multi-round loop`)
          break
        }

        const inspected = new Set(coverageTracker.getStats().filesInspected)
        const uninspectedFromBatch = batch.filter((f) => !inspected.has(f))
        remainingFiles = [...uninspectedFromBatch, ...remainingFiles.slice(batch.length)]

        if (allFindings.length === 0 && roundNumber === 1) {
          throw roundErr
        }

        this.emit('progress', {
          trackId: params.trackId,
          status: 'running',
          streamChunk: `\n\n⚠️ Round ${roundNumber} encountered an error. Continuing with next batch...\n\n`
        } satisfies AuditProgressPayload)
      }
    }

    // Phase 3: Compute final result with coverage gate
    const stats = coverageTracker.getStats()
    let finalScore: number
    if (modelScore != null) {
      finalScore = modelScore
    } else {
      const inferred = inferScoreFromFindings(allFindings)
      const hasRealFindings = allFindings.some((f) => f.severity !== 'info')
      finalScore = hasRealFindings ? inferred : Math.min(inferred, 50)
    }

    const parsed = {
      score: finalScore,
      summary:
        modelSummary ||
        `Audit completed in ${roundNumber} round(s). ${allFindings.length} finding(s) across ${stats.fileCount} files.`,
      findings: allFindings
    }

    const gated = applyCoverageGate(parsed, stats)
    gated.coveragePercent =
      discovery.totalFiles > 0 ? Math.round((stats.fileCount / discovery.totalFiles) * 100) : null

    // Derive applicability: no files discovered for this track ⇒ not-applicable;
    // failed coverage gate ⇒ insufficient; otherwise the score is trustworthy.
    const applicability: AuditApplicability =
      discovery.totalFiles === 0 || stats.fileCount === 0
        ? 'not-applicable'
        : gated.isSufficient
          ? 'ok'
          : 'insufficient'

    return {
      trackId: params.trackId,
      score: gated.score,
      status: 'completed',
      findings: gated.findings,
      summary: gated.summary,
      skillsUsed: [],
      coverageStats: gated.coverageStats,
      coverageSufficient: gated.isSufficient,
      applicability
    }
  }

  // ── Private: single round execution ───────────────────────────────────

  private async runAuditRound(
    params: {
      workspaceId: string
      workspacePath: string
      trackId: AuditTrackId
      mode: AuditMode
      batch: string[]
      roundNumber: number
      previousFindings: AuditFinding[]
      remainingFileCount: number
      coverageTracker: AuditCoverageTracker
      isFirstRound: boolean
      llmProvider?: LLMProvider
    },
    state: AuditWorkspaceState
  ): Promise<{ findings: AuditFinding[]; score: number | null; summary: string }> {
    const roundContext = params.isFirstRound
      ? undefined
      : {
          roundNumber: params.roundNumber,
          fileBatch: params.batch,
          previousFindingsSummary: this.summarizePreviousFindings(params.previousFindings),
          remainingFileCount: params.remainingFileCount
        }

    const adapter = new AuditRoleAdapter({
      workspaceId: params.workspaceId,
      trackId: params.trackId,
      mode: params.mode,
      roundContext,
      llmProvider: params.llmProvider
    })

    const session = new AgentSessionService(adapter)
    state.session = session

    session.on('chunk', (chunk: StreamChunk) => {
      params.coverageTracker.onChunk(chunk)

      // Surface error chunks — CLI auth failures, API issues, invalid flags
      if (chunk.type === 'error' && chunk.error) {
        auditLog.error(
          `[audit:${params.trackId}] Error chunk: ${chunk.error.slice(0, 300)}`
        )
        this.emit('progress', {
          trackId: params.trackId,
          status: 'running',
          streamChunk: `\n⚠️ Error: ${chunk.error.slice(0, 200)}\n`
        } satisfies AuditProgressPayload)
        return
      }

      // Surface auth issues so the user knows to fix credentials
      if (chunk.type === 'auth_status' && chunk.content) {
        auditLog.warn(`[audit:${params.trackId}] Auth status: ${chunk.content}`)
        this.emit('progress', {
          trackId: params.trackId,
          status: 'running',
          streamChunk: `\n🔑 ${chunk.content}\n`
        } satisfies AuditProgressPayload)
        return
      }

      if (chunk.type === 'text' && chunk.content && this.isApiErrorText(chunk.content)) {
        auditLog.warn(
          `[audit:${params.trackId}] Suppressed API error from stream: ${chunk.content.slice(0, 150)}`
        )
        this.emit('progress', {
          trackId: params.trackId,
          status: 'running',
          streamChunk: '\n⚡ Encountered a transient API issue — retrying automatically...\n'
        } satisfies AuditProgressPayload)
        return
      }

      if (chunk.type === 'text' && chunk.content) {
        this.emit('progress', {
          trackId: params.trackId,
          status: 'running',
          streamChunk: chunk.content
        } satisfies AuditProgressPayload)
      }
      this.emit('stream', { trackId: params.trackId, chunk })
    })

    try {
      await session.start(params.workspacePath, 'plan')

      const message = params.isFirstRound
        ? 'Begin your audit.'
        : this.buildContinuationPrompt(params)

      const syntheticConvId = `audit-${params.trackId}-r${params.roundNumber}-${Date.now()}`
      await session.send(message, syntheticConvId, [])

      if (session.wasTimedOut()) {
        auditLog.warn(`[audit:${params.trackId}] Round ${params.roundNumber} timed out`)
      }

      const responseText = session.getStreamedContent()

      // Detect empty/very short responses — likely CLI or API failure
      if (responseText.length < 50) {
        auditLog.error(
          `[audit:${params.trackId}] Round ${params.roundNumber} produced near-empty response ` +
          `(${responseText.length} chars). Possible CLI/API issue. ` +
          `Response: "${responseText.slice(0, 100)}"`
        )
      }

      const parsed = parseAuditResponse(responseText)

      if (params.isFirstRound && parsed.score === 0 && parsed.findings.length === 0) {
        if (responseText.length > 100) {
          // Model responded but didn't emit structured blocks — try recovery
          return this.attemptToolFreeRecovery(params, responseText)
        }
        // Near-empty response — emit diagnostic finding so the user sees WHY it failed
        auditLog.error(
          `[audit:${params.trackId}] Round 1 produced ${responseText.length}-char response with 0 findings`
        )
        return {
          findings: [{
            id: randomUUID(),
            severity: 'info' as const,
            title: `${params.trackId} audit could not complete`,
            description:
              `The auditor received an empty or very short response (${responseText.length} chars) from the LLM. ` +
              `This usually indicates a CLI authentication issue, API rate limit, or invalid CLI flags. ` +
              `Check that the "claude" CLI is working by running "claude -p hello" in your terminal.`,
            recommendation: 'Verify Claude CLI access: run "claude --version" and "claude -p hello" in your terminal.'
          }],
          score: null,
          summary: 'Audit could not complete — empty LLM response. Check Claude CLI configuration.'
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
      state.session = null
    }
  }

  // ── Private: tool-free recovery nudge ─────────────────────────────────

  private async attemptToolFreeRecovery(
    params: { trackId: AuditTrackId; workspacePath: string },
    responseText: string
  ): Promise<{ findings: AuditFinding[]; score: number | null; summary: string }> {
    auditLog.warn(
      `[audit:${params.trackId}] No findings extracted from ${responseText.length}-char response — tool-free recovery`
    )

    try {
      const { execFileSync } = await import('node:child_process')

      const nudgePrompt =
        `Your previous audit analysis is below. You investigated the codebase but did not emit any finding blocks.\n\n` +
        `--- ANALYSIS ---\n${responseText.slice(0, 8000)}\n--- END ---\n\n` +
        `Based on what you found above, output a JSON code block with this exact shape:\n\n` +
        '```json\n{"score": <0-100>, "summary": "<2-3 sentences>", "findings": [{"severity": "...", "title": "...", "description": "...", "filePath": "...", "recommendation": "..."}]}\n```\n\n' +
        `Score conservatively. Include findings for what you DID inspect. Output ONLY the JSON block.`

      const nudgeText = execFileSync('claude', [
        '-p', nudgePrompt,
        '--model', modelConfigService.getModel(params.workspacePath, 'da-vinci:plan'),
        '--system-prompt', 'You are an audit result formatter. Output only the requested JSON block.',
        '--permission-mode', 'plan',
        '--max-turns', '1',
        '--output-format', 'text'
      ], {
        encoding: 'utf-8',
        timeout: 60_000,
        cwd: params.workspacePath
      })

      const nudgeParsed = parseAuditResponse(nudgeText)

      if (nudgeParsed.score > 0 || nudgeParsed.findings.length > 0) {
        auditLog.info(
          `[audit:${params.trackId}] Tool-free recovery succeeded — score=${nudgeParsed.score}, findings=${nudgeParsed.findings.length}`
        )
        return {
          findings: nudgeParsed.findings,
          score: nudgeParsed.score > 0 ? nudgeParsed.score : null,
          summary: nudgeParsed.summary
        }
      }
    } catch (nudgeErr) {
      auditLog.warn(`[audit:${params.trackId}] Tool-free recovery failed:`, nudgeErr)
    }

    const analysisText = responseText.trim()
    const preservedSummary =
      analysisText.length > 1500 ? analysisText.slice(-1500).trim() : analysisText

    const syntheticFinding: AuditFinding = {
      id: randomUUID(),
      severity: 'info',
      title: `${params.trackId} audit analysis completed`,
      description:
        preservedSummary ||
        'The auditor completed its analysis but did not emit structured findings. Review the stream output above for details.',
      recommendation:
        'Re-run this audit track to attempt structured extraction. If the issue persists, the codebase may use patterns the auditor cannot parse into discrete findings.'
    }

    return {
      findings: [syntheticFinding],
      score: null,
      summary:
        preservedSummary || 'Audit analysis completed — structured findings could not be extracted.'
    }
  }

  // ── Private: helpers ──────────────────────────────────────────────────

  private isApiErrorText(text: string): boolean {
    return (
      text.includes('API Error:') ||
      text.includes('"type":"error"') ||
      text.includes('invalid_request_error') ||
      text.includes('each thinking block must contain')
    )
  }

  private getBatchSize(isLocal: boolean): number {
    return isLocal ? 3 : 12
  }

  private getMaxRounds(isLocal: boolean): number {
    return isLocal ? 15 : 5
  }

  private buildContinuationPrompt(params: {
    trackId: AuditTrackId
    batch: string[]
    roundNumber: number
    previousFindings: AuditFinding[]
    remainingFileCount: number
  }): string {
    return (
      `Continue your ${params.trackId} audit.\n\n` +
      `## Already Reviewed\n` +
      `${params.previousFindings.length} finding(s) discovered so far:\n` +
      `${this.summarizePreviousFindings(params.previousFindings)}\n\n` +
      `## Remaining Work\n` +
      `${params.remainingFileCount} files still to inspect. Focus on these files in this round:\n` +
      `${params.batch.map((f) => `- ${f}`).join('\n')}\n\n` +
      `Emit audit-finding blocks for each file you inspect. After reviewing all files above, emit an audit-score block.`
    )
  }

  private summarizePreviousFindings(findings: AuditFinding[]): string {
    if (findings.length === 0) return 'No findings yet.'
    return findings
      .slice(-10)
      .map(
        (f) => `- [${f.severity.toUpperCase()}] ${f.title}${f.filePath ? ` (${f.filePath})` : ''}`
      )
      .join('\n')
  }

  private hasAdequateCoverage(
    findings: AuditFinding[],
    stats: AuditCoverageStats,
    totalFiles: number
  ): boolean {
    const coveragePercent = totalFiles > 0 ? stats.fileCount / totalFiles : 0
    const hasEnoughFindings = findings.length >= 8
    const hasEnoughCoverage = coveragePercent >= 0.6

    return hasEnoughFindings && hasEnoughCoverage
  }

  /** Graceful shutdown — cancel all audits and clear state. Called on app quit. */
  async shutdown(): Promise<void> {
    auditLog.info(`[audit] Shutdown initiated — ${this.workspaceStates.size} active states`)
    this.cancel() // Cancels all workspace audits
    this.workspaceStates.clear()
  }
}

// ── Weighted average calculation ───────────────────────────────────────────

function calculateOverallScore(
  results: AuditResultPayload[],
  tracks: Record<AuditTrackId, AuditTrack>
): number | null {
  // Exclude tracks whose coverage was insufficient (or not-applicable) — a
  // hallucinated 0 from an empty audit must not drag down the overall score.
  const completed = results.filter(
    (r) => r.status === 'completed' && r.coverageSufficient !== false
  )
  if (completed.length === 0) return null

  let weightedSum = 0
  let totalWeight = 0
  for (const r of completed) {
    const weight = tracks[r.trackId]?.weight ?? 1.0
    weightedSum += r.score * weight
    totalWeight += weight
  }
  return Math.round(weightedSum / totalWeight)
}

export const auditAgentService = new AuditAgentService()
