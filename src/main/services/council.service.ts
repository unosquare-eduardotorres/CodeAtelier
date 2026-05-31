/**
 * CouncilService — orchestrates the full LLM Council process.
 *
 * Implements Karpathy's 3-stage pipeline:
 *   Step 1: Frame the question (context enrichment)
 *   Step 2: Convene the council (5 parallel advisor sessions)
 *   Step 3: Peer review (5 parallel anonymous reviews)
 *   Step 4: Chairman synthesis (final verdict)
 *   Step 5: Emit results to renderer
 *   Step 6: Save transcript
 *
 * Follows the same Map<workspaceId, Session> concurrency pattern as
 * GrillAgentService and AuditAgentService.
 */

import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import { promisify } from 'node:util'
import log from 'electron-log'
import type {
  CouncilAdvisorRole,
  CouncilReview,
  CouncilPeerReview,
  CouncilVerdict,
  CouncilFramedInput,
  CouncilPhase,
  CouncilMemberStatus,
  CouncilInputType,
  LLMProvider,
  StructuredPlan
} from '../../shared/types'
import type { StreamChunk } from './agent-base.service'
import { AgentSessionService } from './agent-session.service'
import { CouncilMemberRoleAdapter } from './role-adapters/council-member.adapter'
import { CouncilChairmanRoleAdapter } from './role-adapters/council-chairman.adapter'
import { COUNCIL_ADVISOR_ROLES } from '../../shared/constants'
import {
  parseCouncilReview,
  parsePeerReview,
  parseCouncilVerdict
} from './council-parser'

const councilLog = log.scope('council')
const execFileAsync = promisify(execFile)

/** Collect non-null fulfilled values from Promise.allSettled results. */
function collectSettled<T>(results: PromiseSettledResult<T | null>[]): T[] {
  return results
    .filter((r): r is PromiseFulfilledResult<T | null> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((r): r is T => r !== null)
}

// ── Internal session state ────────────────────────────────────────────

interface AdvisorInstance {
  role: CouncilAdvisorRole
  session: AgentSessionService | null
  status: CouncilMemberStatus
  review: CouncilReview | null
}

interface CouncilSessionEntry {
  workspaceId: string
  workspacePath: string
  conversationId?: string
  inputType: CouncilInputType
  framedInput: CouncilFramedInput
  advisors: Map<CouncilAdvisorRole, AdvisorInstance>
  phase: CouncilPhase
  verdict: CouncilVerdict | null
  running: boolean
  llmProvider: LLMProvider
}

// ── Service ────────────────────────────────────────────────────────────
// TODO: DRY — CouncilService, GrillAgentService, AuditAgentService, and
// MpaOrchestrationService all share identical isRunning/isRunningForWorkspace/
// shutdown/cancel boilerplate (~20 lines each). Extract a shared
// MultiWorkspaceEvaluatorBase<T extends { running: boolean }> abstract class.

export class CouncilService extends EventEmitter {
  private sessions = new Map<string, CouncilSessionEntry>()

  /** Check if ANY council is running. */
  get isRunning(): boolean {
    for (const entry of this.sessions.values()) {
      if (entry.running) return true
    }
    return false
  }

  /** Check if a specific workspace has a running council. */
  isRunningForWorkspace(workspaceId: string): boolean {
    return this.sessions.get(workspaceId)?.running ?? false
  }

  /**
   * Run the full council process for a workspace.
   *
   * Emits:
   *   'phase-changed'    — { workspaceId, phase }
   *   'member-stream'    — { workspaceId, advisorRole, chunk }
   *   'member-complete'  — { workspaceId, advisorRole, review }
   *   'peer-review-complete' — { workspaceId, peerReviews }
   *   'verdict'          — { workspaceId, verdict }
   *   'complete'         — { workspaceId }
   */
  async evaluate(params: {
    workspaceId: string
    workspacePath: string
    inputType: CouncilInputType
    planContent: string
    structuredPlan: StructuredPlan | null
    originalUserRequest: string
    workspaceContext: string
    filesInScope: string[]
    conversationId?: string
    llmProvider?: LLMProvider
  }): Promise<void> {
    councilLog.info(`[council] evaluate called — workspace=${params.workspaceId}`)

    if (this.sessions.get(params.workspaceId)?.running) {
      councilLog.warn(`[council] Already running for workspace ${params.workspaceId} — ignoring`)
      return
    }

    const framedInput: CouncilFramedInput = {
      planContent: params.planContent,
      structuredPlan: params.structuredPlan,
      originalUserRequest: params.originalUserRequest,
      workspaceContext: params.workspaceContext,
      filesInScope: params.filesInScope,
      inputType: params.inputType
    }

    // Initialize advisor instances
    const advisors = new Map<CouncilAdvisorRole, AdvisorInstance>()
    for (const role of COUNCIL_ADVISOR_ROLES) {
      advisors.set(role, {
        role,
        session: null,
        status: 'pending',
        review: null
      })
    }

    const entry: CouncilSessionEntry = {
      workspaceId: params.workspaceId,
      workspacePath: params.workspacePath,
      conversationId: params.conversationId,
      inputType: params.inputType,
      framedInput,
      advisors,
      phase: 'framing',
      verdict: null,
      running: true,
      llmProvider: params.llmProvider ?? 'claude'
    }

    this.sessions.set(params.workspaceId, entry)

    try {
      // Step 1: Frame the question (context already provided by params)
      this.setPhase(entry, 'framing')

      // Step 2: Convene the council — 5 parallel advisor sessions
      this.setPhase(entry, 'deliberating')
      const reviews = await this.runAdvisors(entry)

      if (!entry.running) return // Cancelled

      // Step 3: Peer review — 5 parallel anonymous reviews
      this.setPhase(entry, 'peer-review')
      const peerReviews = await this.runPeerReviews(entry, reviews)

      if (!entry.running) return // Cancelled

      // Step 4: Chairman synthesis
      this.setPhase(entry, 'synthesizing')
      const verdict = await this.runChairman(entry, reviews, peerReviews)

      if (!entry.running) return // Cancelled

      entry.verdict = verdict

      if (verdict) {
        this.emit('verdict', { workspaceId: params.workspaceId, verdict })
      }

      // Step 5: Complete
      this.setPhase(entry, 'complete')
    } catch (err) {
      councilLog.error('[council] evaluate failed:', err)
      this.setPhase(entry, 'failed')
    } finally {
      entry.running = false
      // Defensive cleanup — stop any sessions still held by advisors
      for (const advisor of entry.advisors.values()) {
        if (advisor.session) {
          try { await advisor.session.stop() } catch { /* non-fatal */ }
        }
      }
      this.sessions.delete(params.workspaceId)
      this.emit('complete', { workspaceId: params.workspaceId })
    }
  }

  /** Cancel the running council for a specific workspace. */
  cancel(workspaceId?: string): void {
    councilLog.info(`[council] Cancel requested${workspaceId ? ` for workspace ${workspaceId}` : ''}`)

    if (workspaceId) {
      const entry = this.sessions.get(workspaceId)
      if (entry) {
        this.cancelSession(entry)
      }
    } else {
      for (const entry of this.sessions.values()) {
        this.cancelSession(entry)
      }
    }
  }

  /** Get the current session state for a workspace. */
  getSessionState(workspaceId: string): {
    phase: CouncilPhase
    memberStatuses: Record<CouncilAdvisorRole, CouncilMemberStatus>
    reviews: CouncilReview[]
    verdict: CouncilVerdict | null
  } | null {
    const entry = this.sessions.get(workspaceId)
    if (!entry) return null

    const memberStatuses = {} as Record<CouncilAdvisorRole, CouncilMemberStatus>
    const reviews: CouncilReview[] = []

    for (const [role, advisor] of entry.advisors) {
      memberStatuses[role] = advisor.status
      if (advisor.review) reviews.push(advisor.review)
    }

    return {
      phase: entry.phase,
      memberStatuses,
      reviews,
      verdict: entry.verdict
    }
  }

  // ── Private: phase management ──────────────────────────────────────

  private setPhase(entry: CouncilSessionEntry, phase: CouncilPhase): void {
    entry.phase = phase
    this.emit('phase-changed', { workspaceId: entry.workspaceId, phase })
    councilLog.info(`[council] Phase → ${phase} (workspace=${entry.workspaceId})`)
  }

  // ── Private: Step 2 — run 5 advisors in parallel ──────────────────

  private async runAdvisors(entry: CouncilSessionEntry): Promise<CouncilReview[]> {
    const advisorPromises = COUNCIL_ADVISOR_ROLES.map(async (role) => {
      const advisor = entry.advisors.get(role)!
      advisor.status = 'running'

      try {
        const adapter = new CouncilMemberRoleAdapter({
          workspaceId: entry.workspaceId,
          advisorRole: role,
          framedInput: entry.framedInput,
          llmProvider: entry.llmProvider
        })

        const session = new AgentSessionService(adapter)
        advisor.session = session

        // Wire streaming events — tagged with advisor role
        session.on('chunk', (chunk: StreamChunk) => {
          this.emit('member-stream', {
            workspaceId: entry.workspaceId,
            advisorRole: role,
            chunk
          })
        })

        // Start session in plan mode (read-only)
        await session.start(entry.workspacePath, 'plan')

        const syntheticConvId = `council-${role}-${Date.now()}`
        await session.send('Begin your review.', syntheticConvId, [])

        // Collect response and parse
        const responseText = session.getStreamedContent()
        const review = parseCouncilReview(responseText, role)

        if (review) {
          advisor.review = review
          advisor.status = 'completed'
          councilLog.info(`[council:${role}] completed — score=${review.score}`)
        } else {
          advisor.status = 'completed'
          councilLog.warn(`[council:${role}] completed but no council-review block found`)
        }

        this.emit('member-complete', {
          workspaceId: entry.workspaceId,
          advisorRole: role,
          review: advisor.review
        })

        return advisor.review
      } catch (err) {
        councilLog.error(`[council:${role}] failed:`, err)
        advisor.status = 'failed'
        this.emit('member-complete', {
          workspaceId: entry.workspaceId,
          advisorRole: role,
          review: null
        })
        return null
      } finally {
        try { await session.stop() } catch { /* non-fatal */ }
      }
    })

    const results = await Promise.allSettled(advisorPromises)
    return collectSettled(results)
  }

  // ── Private: Step 3 — peer review (5 parallel, no tools) ──────────

  private async runPeerReviews(
    entry: CouncilSessionEntry,
    reviews: CouncilReview[]
  ): Promise<CouncilPeerReview[]> {
    if (reviews.length < 2) {
      councilLog.warn('[council] Not enough reviews for peer review — skipping')
      return []
    }

    // Anonymize reviews: randomized mapping to letters A-E
    const shuffled = [...reviews].sort(() => Math.random() - 0.5)
    const anonymized = shuffled.map((r, i) => ({
      label: String.fromCharCode(65 + i), // A, B, C, D, E
      ...r,
      advisorRole: undefined // Strip role identity
    }))

    const anonymizedText = anonymized
      .map(
        (r) => `### Response ${r.label} (Score: ${r.score}/100, Verdict: ${r.verdict})
${r.summary}

Key Findings: ${r.keyFindings.join('; ')}
Blind Spots: ${r.blindSpots.join('; ')}`
      )
      .join('\n\n---\n\n')

    const systemPrompt = `You are a peer reviewer in an LLM Council. You are reading ${reviews.length} anonymized advisor responses (labeled A through ${String.fromCharCode(64 + reviews.length)}).

Answer these three questions as JSON:
1. Which response is the strongest and why? (pick one letter)
2. Which response has the biggest blind spot and what is it? (pick one letter)
3. What did ALL responses miss that the council should consider?

Respond ONLY with a JSON block:
\`\`\`council-peer-review
{
  "strongestResponse": "<letter>",
  "strongestReason": "<1-2 sentences>",
  "biggestBlindSpot": "<letter>",
  "blindSpotDescription": "<1-2 sentences>",
  "missedByAll": "<1-2 sentences>"
}
\`\`\``

    const peerPromises = COUNCIL_ADVISOR_ROLES.map(async (role) => {
      try {
        const { stdout } = await execFileAsync('claude', [
          '-p', `Review these advisor responses:\n\n${anonymizedText}`,
          '--model', 'claude-haiku-4-5-20251001',
          '--system-prompt', systemPrompt,
          '--permission-mode', 'plan',
          '--max-turns', '1',
          '--output-format', 'text'
        ], {
          encoding: 'utf-8',
          timeout: 120_000 // 2 min timeout
        })

        const parsed = parsePeerReview(stdout, role)
        if (parsed) {
          councilLog.info(`[council:peer-review:${role}] completed`)
          return parsed
        }
        return null
      } catch (err) {
        councilLog.error(`[council:peer-review:${role}] failed:`, err)
        return null
      }
    })

    const results = await Promise.allSettled(peerPromises)
    const peerReviews = collectSettled(results)

    this.emit('peer-review-complete', {
      workspaceId: entry.workspaceId,
      peerReviews
    })

    return peerReviews
  }

  // ── Private: Step 4 — chairman synthesis ───────────────────────────

  private async runChairman(
    entry: CouncilSessionEntry,
    reviews: CouncilReview[],
    peerReviews: CouncilPeerReview[]
  ): Promise<CouncilVerdict | null> {
    try {
      const adapter = new CouncilChairmanRoleAdapter({
        workspaceId: entry.workspaceId,
        framedInput: entry.framedInput,
        reviews,
        peerReviews,
        llmProvider: entry.llmProvider
      })

      const session = new AgentSessionService(adapter)

      // Wire streaming events
      session.on('chunk', (chunk: StreamChunk) => {
        this.emit('member-stream', {
          workspaceId: entry.workspaceId,
          advisorRole: 'chairman' as string,
          chunk
        })
      })

      // Use OS temp dir as working directory (chairman has no tools)
      const workDir = os.tmpdir()

      await session.start(workDir, 'plan')
      const syntheticConvId = `council-chairman-${Date.now()}`
      await session.send('Synthesize the council verdict.', syntheticConvId, [])

      const responseText = session.getStreamedContent()
      const verdict = parseCouncilVerdict(responseText)

      if (verdict) {
        councilLog.info(`[council:chairman] completed — overall score=${verdict.overallScore}`)
      } else {
        councilLog.warn('[council:chairman] completed but no council-verdict block found')
      }

      return verdict
    } catch (err) {
      councilLog.error('[council:chairman] failed:', err)
      return null
    } finally {
      try { await session.stop() } catch { /* non-fatal */ }
    }
  }

  // ── Private: session cancellation ──────────────────────────────────

  private cancelSession(entry: CouncilSessionEntry): void {
    entry.running = false
    for (const advisor of entry.advisors.values()) {
      if (advisor.session) {
        try { advisor.session.cancelCurrentQuery() } catch { /* non-fatal */ }
        try { advisor.session.stop() } catch { /* non-fatal — stop() may be sync or already stopped */ }
      }
    }
    this.setPhase(entry, 'cancelled')
  }

  /** Graceful shutdown — cancel all councils and clear state. Called on app quit. */
  async shutdown(): Promise<void> {
    councilLog.info(`[council] Shutdown initiated — ${this.sessions.size} active sessions`)
    this.cancel()
    this.sessions.clear()
  }

  // Parsing functions extracted to council-parser.ts for testability
}

export const councilService = new CouncilService()
