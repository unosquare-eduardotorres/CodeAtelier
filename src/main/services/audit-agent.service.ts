/**
 * AuditAgentService — orchestrator for workspace health audits.
 *
 * A sibling to ChatAgentService that owns its own AgentSessionService.
 * Runs auditors sequentially (one at a time), each with multi-round
 * coverage-tracked sessions. Emits 'progress', 'result',
 * 'intermediate_findings', and 'complete' events for the IPC layer.
 *
 * Chat stays alive and independent — this service has no overlap with it.
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

// ── Service ────────────────────────────────────────────────────────────────

export class AuditAgentService extends EventEmitter {
  private session: AgentSessionService | null = null
  private abortController: AbortController | null = null
  private running = false

  get isRunning(): boolean {
    return this.running
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
    if (this.running) {
      auditLog.warn('[audit] Already running — ignoring duplicate start')
      return
    }

    this.running = true
    this.abortController = new AbortController()

    const completedResults: AuditResultPayload[] = []

    for (const trackId of params.selectedTracks) {
      if (this.abortController.signal.aborted) {
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

    this.running = false
    this.abortController = null
    this.emit('complete', { overallScore } satisfies AuditCompletePayload)
  }

  /** Cancel the running audit. Keeps completed results, cancels remaining. */
  cancel(): void {
    auditLog.info('[audit] Cancel requested')
    this.abortController?.abort()

    // If a session is currently running, cancel its query
    if (this.session) {
      try {
        this.session.cancelCurrentQuery()
      } catch {
        /* non-fatal */
      }
    }
  }

  /**
   * Run a single track re-run. Emits 'progress', 'result' (no 'complete').
   * Used for re-running individual auditors from the report view.
   */
  async runSingleTrack(params: {
    workspaceId: string
    workspacePath: string
    trackId: AuditTrackId
    mode: AuditMode
    llmProvider?: LLMProvider
  }): Promise<void> {
    if (this.running) {
      auditLog.warn('[audit:rerun] Already running — ignoring')
      return
    }

    this.running = true
    this.abortController = new AbortController()

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
      this.running = false
      this.abortController = null
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
        return await this.executeMultiRoundAudit(params)
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

  /** Determine whether an error is worth retrying. */
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

  private async executeMultiRoundAudit(params: {
    workspaceId: string
    workspacePath: string
    trackId: AuditTrackId
    mode: AuditMode
    llmProvider?: LLMProvider
  }): Promise<AuditResultPayload> {
    const isLocal = params.llmProvider === 'local-llm'
    const batchSize = this.getBatchSize(isLocal)
    const maxRounds = this.getMaxRounds(isLocal)

    // Phase 1: Discover relevant files for this track
    const discovery = discoverAuditableFiles(params.workspacePath, params.trackId)
    const coverageTracker = new AuditCoverageTracker()
    const allFindings: AuditFinding[] = []
    let modelScore: number | null = null
    let modelSummary = ''

    auditLog.info(
      `[audit:${params.trackId}] Discovery found ${discovery.totalFiles} files, batch=${batchSize}, maxRounds=${maxRounds}`
    )

    // Emit discovery summary to UI
    this.emit('progress', {
      trackId: params.trackId,
      status: 'running',
      streamChunk: `📂 Discovered ${discovery.totalFiles} relevant files (${discovery.priorityFiles.length} priority). Starting multi-round inspection...\n\n`
    } satisfies AuditProgressPayload)

    // Phase 2: Run inspection rounds
    let remainingFiles = [...discovery.filePaths]
    let roundNumber = 0

    while (
      remainingFiles.length > 0 &&
      roundNumber < maxRounds &&
      !this.abortController?.signal.aborted
    ) {
      roundNumber++
      const batch = remainingFiles.slice(0, batchSize)

      // Pre-round separator + announcement
      this.emit('progress', {
        trackId: params.trackId,
        status: 'running',
        streamChunk:
          roundNumber === 1
            ? `\n---\n\n🔍 **Round ${roundNumber}/${maxRounds}** — Inspecting ${batch.length} files...\n\n`
            : `\n\n---\n\n🔄 **Round ${roundNumber}/${maxRounds}** — Inspecting next ${batch.length} files (${remainingFiles.length - batch.length} remaining)...\n\n`
      } satisfies AuditProgressPayload)

      auditLog.info(
        `[audit:${params.trackId}] Round ${roundNumber}: inspecting ${batch.length} files (${remainingFiles.length} remaining)`
      )

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
        })

        // Collect findings from this round
        allFindings.push(...roundResult.findings)

        // Update remaining files (remove inspected ones)
        const inspected = new Set(coverageTracker.getStats().filesInspected)
        remainingFiles = remainingFiles.filter((f) => !inspected.has(f))

        // If model emitted a score, capture it (last one wins)
        if (roundResult.score !== null) {
          modelScore = roundResult.score
          modelSummary = roundResult.summary
        }

        // Emit intermediate progress to UI
        const stats = coverageTracker.getStats()
        this.emit('progress', {
          trackId: params.trackId,
          status: 'running',
          streamChunk: `\n\n📊 Round ${roundNumber}: ${roundResult.findings.length} finding(s), ${stats.fileCount}/${discovery.totalFiles} files covered\n\n`
        } satisfies AuditProgressPayload)

        // Emit intermediate findings for live UI display
        this.emit('intermediate_findings', {
          trackId: params.trackId,
          findings: allFindings,
          coverageStats: stats,
          roundNumber,
          totalRounds: maxRounds,
          totalFiles: discovery.totalFiles,
          batchSize
        } satisfies AuditIntermediateFindingsPayload)

        // Early termination: enough coverage
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

        // If aborted (cancel/pause), stop immediately — don't continue to next round
        if (this.abortController?.signal.aborted) {
          auditLog.info(`[audit:${params.trackId}] Aborted — stopping multi-round loop`)
          break
        }

        // Move un-inspected files from this batch back to remaining
        const inspected = new Set(coverageTracker.getStats().filesInspected)
        const uninspectedFromBatch = batch.filter((f) => !inspected.has(f))
        remainingFiles = [...uninspectedFromBatch, ...remainingFiles.slice(batch.length)]

        // If we have findings from previous rounds, continue; otherwise re-throw
        if (allFindings.length === 0 && roundNumber === 1) {
          throw roundErr
        }

        // Emit error notice and continue to next round
        this.emit('progress', {
          trackId: params.trackId,
          status: 'running',
          streamChunk: `\n\n⚠️ Round ${roundNumber} encountered an error. Continuing with next batch...\n\n`
        } satisfies AuditProgressPayload)
      }
    }

    // Phase 3: Compute final result with coverage gate
    const stats = coverageTracker.getStats()

    // Score resolution: model-emitted score wins, otherwise infer from findings.
    // Guard: if the only findings are synthetic recovery "info" entries (no model score),
    // the inferred score of 100 is misleading — cap at 50 ("inconclusive").
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

    auditLog.info(
      `[audit:${params.trackId}] completed — score=${gated.score}, findings=${gated.findings.length}, ` +
        `coverage=${stats.fileCount}/${discovery.totalFiles} (${gated.coveragePercent ?? '?'}%), ` +
        `sufficient=${gated.isSufficient}`
    )

    return {
      trackId: params.trackId,
      score: gated.score,
      status: 'completed',
      findings: gated.findings,
      summary: gated.summary,
      skillsUsed: [],
      coverageStats: gated.coverageStats,
      coverageSufficient: gated.isSufficient
    }
  }

  // ── Private: single round execution ───────────────────────────────────

  private async runAuditRound(params: {
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
  }): Promise<{ findings: AuditFinding[]; score: number | null; summary: string }> {
    // Build round context for the adapter (rounds > 1 get continuation context)
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

    this.session = new AgentSessionService(adapter)

    // Wire coverage tracker + streaming
    this.session.on('chunk', (chunk: StreamChunk) => {
      params.coverageTracker.onChunk(chunk)

      // Filter raw API error text — replace with user-friendly notice
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

      // Continue emitting progress for status tracking (backwards compat)
      if (chunk.type === 'text' && chunk.content) {
        this.emit('progress', {
          trackId: params.trackId,
          status: 'running',
          streamChunk: chunk.content
        } satisfies AuditProgressPayload)
      }
      // Forward the full chunk for chat-like rendering
      this.emit('stream', { trackId: params.trackId, chunk })
    })

    try {
      // Start session in plan mode (read-only)
      await this.session.start(params.workspacePath, 'plan')

      // Build the message for this round
      const message = params.isFirstRound
        ? 'Begin your audit.'
        : this.buildContinuationPrompt(params)

      const syntheticConvId = `audit-${params.trackId}-r${params.roundNumber}-${Date.now()}`
      await this.session.send(message, syntheticConvId, [])

      // ── Check if session was killed by timeout ──
      if (this.session.wasTimedOut()) {
        auditLog.warn(`[audit:${params.trackId}] Round ${params.roundNumber} timed out`)
        // Still parse what we got — partial findings are valuable
      }

      // Collect the full response
      const responseText = this.session.getStreamedContent()

      // Parse structured JSON from the auditor's response
      const parsed = parseAuditResponse(responseText)

      // ── Recovery: if first round, no findings, long response — try tool-free nudge ──
      if (
        params.isFirstRound &&
        parsed.score === 0 &&
        parsed.findings.length === 0 &&
        responseText.length > 200
      ) {
        return this.attemptToolFreeRecovery(params, responseText)
      }

      return {
        findings: parsed.findings,
        score: parsed.score > 0 ? parsed.score : null,
        summary: parsed.summary
      }
    } finally {
      try {
        await this.session.stop()
      } catch {
        /* best-effort cleanup */
      }
      this.session = null
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
      const { query } = await import('@anthropic-ai/claude-agent-sdk')
      const { authProvider } = await import('./auth-provider')

      const apiKey = authProvider.getApiKey()
      if (apiKey && !process.env.ANTHROPIC_API_KEY) {
        process.env.ANTHROPIC_API_KEY = apiKey
      }

      const nudgePrompt =
        `Your previous audit analysis is below. You investigated the codebase but did not emit any finding blocks.\n\n` +
        `--- ANALYSIS ---\n${responseText.slice(0, 8000)}\n--- END ---\n\n` +
        `Based on what you found above, output a JSON code block with this exact shape:\n\n` +
        '```json\n{"score": <0-100>, "summary": "<2-3 sentences>", "findings": [{"severity": "...", "title": "...", "description": "...", "filePath": "...", "recommendation": "..."}]}\n```\n\n' +
        `Score conservatively. Include findings for what you DID inspect. Output ONLY the JSON block.`

      const nudgeResult = query({
        prompt: nudgePrompt,
        options: {
          model: modelConfigService.getModel(params.workspacePath, 'da-vinci:plan'),
          systemPrompt: 'You are an audit result formatter. Output only the requested JSON block.',
          permissionMode: 'default',
          maxTurns: 1,
          abortController: new AbortController()
        }
      })

      let nudgeText = ''
      for await (const msg of nudgeResult) {
        const m = msg as Record<string, unknown>
        if (m.type === 'stream_event') {
          const event = m.event as Record<string, unknown> | undefined
          if (event?.type === 'content_block_delta') {
            const delta = event.delta as Record<string, unknown> | undefined
            if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
              nudgeText += delta.text
            }
          }
        }
        if (m.type === 'result' && typeof m.result === 'string') {
          nudgeText = m.result
        }
      }

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

    auditLog.warn(
      `[audit:${params.trackId}] No structured result extracted — preserving analysis text as report`
    )

    // Preserve the analysis text as the summary so the user sees what the auditor found.
    // Take the last ~1500 chars which typically contain the conclusion/summary.
    const analysisText = responseText.trim()
    const preservedSummary =
      analysisText.length > 1500 ? analysisText.slice(-1500).trim() : analysisText

    // Create a synthetic "info" finding so the report always has content to show.
    // Without this, the UI shows an empty report which looks like a silent failure.
    const syntheticFinding: AuditFinding = {
      id: randomUUID(),
      severity: 'info',
      title: `${params.trackId} audit analysis completed`,
      description: preservedSummary || 'The auditor completed its analysis but did not emit structured findings. Review the stream output above for details.',
      recommendation: 'Re-run this audit track to attempt structured extraction. If the issue persists, the codebase may use patterns the auditor cannot parse into discrete findings.'
    }

    return {
      findings: [syntheticFinding],
      score: null,
      summary: preservedSummary || 'Audit analysis completed — structured findings could not be extracted.'
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

  /** Build a continuation prompt for rounds > 1. */
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

  /** Summarize previous findings for continuation context. */
  private summarizePreviousFindings(findings: AuditFinding[]): string {
    if (findings.length === 0) return 'No findings yet.'
    return findings
      .slice(-10) // Last 10 to avoid context overflow
      .map(
        (f) => `- [${f.severity.toUpperCase()}] ${f.title}${f.filePath ? ` (${f.filePath})` : ''}`
      )
      .join('\n')
  }

  /** Check if we have enough coverage to stop early. */
  private hasAdequateCoverage(
    findings: AuditFinding[],
    stats: AuditCoverageStats,
    totalFiles: number
  ): boolean {
    // Stop if we've inspected >= 60% of files OR have enough diverse findings
    const coveragePercent = totalFiles > 0 ? stats.fileCount / totalFiles : 0
    const hasEnoughFindings = findings.length >= 8
    const hasEnoughCoverage = coveragePercent >= 0.6

    return hasEnoughFindings && hasEnoughCoverage
  }
}

// ── Weighted average calculation ───────────────────────────────────────────

function calculateOverallScore(
  results: AuditResultPayload[],
  tracks: Record<AuditTrackId, AuditTrack>
): number | null {
  // Include all completed tracks in the weighted average — even score 0 is a valid
  // result (the auditor ran, inspected files, and found critical issues). Only
  // exclude non-completed tracks (failed/cancelled/pending).
  const completed = results.filter((r) => r.status === 'completed')
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
