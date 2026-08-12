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

import { EventEmitter } from 'node:events'
import os from 'node:os'
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
  StructuredPlan,
  AgentStatus
} from '../../shared/types'
import type { StreamChunk } from './agent-base.service'
import { runOneShotClaude } from './one-shot-claude'
import { AgentSessionService } from './agent-session.service'
import { CouncilMemberRoleAdapter } from './role-adapters/council-member.adapter'
import { CouncilChairmanRoleAdapter } from './role-adapters/council-chairman.adapter'
import { COUNCIL_ADVISOR_ROLES } from '../../shared/constants'
import { parseCouncilReview, parsePeerReview, parseCouncilVerdict } from './council-parser'
import { councilSessionRepository } from '../db/repositories/council-session.repository'

const councilLog = log.scope('council')

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
  /** Per-conversation cancel: track the syntheticConvId used for send(). */
  lastConversationId?: string
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
  /** Database session ID for persistence (set after createSession) */
  dbSessionId?: string
}

// ── Service ────────────────────────────────────────────────────────────
// TODO: DRY — CouncilService, GrillAgentService, AuditAgentService, and
// MpaOrchestrationService all share identical isRunning/isRunningForWorkspace/
// shutdown/cancel boilerplate (~20 lines each). Extract a shared
// MultiWorkspaceEvaluatorBase<T extends { running: boolean }> abstract class.

export class CouncilService extends EventEmitter {
  private sessions = new Map<string, CouncilSessionEntry>()
  /** Guards against concurrent evaluate/resumeSession for the same workspace. */
  private readonly startLocks = new Set<string>()

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
    grillSessionId?: string
    llmProvider?: LLMProvider
    dbSessionId?: string
  }): Promise<void> {
    councilLog.info(`[council] evaluate called — workspace=${params.workspaceId}`)

    if (this.startLocks.has(params.workspaceId)) {
      councilLog.warn(`[council] Start lock held for workspace ${params.workspaceId} — ignoring`)
      return
    }
    if (this.sessions.get(params.workspaceId)?.running) {
      councilLog.warn(`[council] Already running for workspace ${params.workspaceId} — ignoring`)
      return
    }
    this.startLocks.add(params.workspaceId)

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

    this.initCouncilDbSession(entry, {
      workspaceId: params.workspaceId,
      inputType: params.inputType,
      planContent: params.planContent,
      grillSessionId: params.grillSessionId,
      structuredPlan: params.structuredPlan,
      conversationId: params.conversationId,
      dbSessionId: params.dbSessionId
    })

    await this.runCouncilPipeline(entry)
  }

  // ── Private: DB session initialization ───────────────────────────

  /** Set up DB session — use pre-created ID or create a new row. */
  private initCouncilDbSession(
    entry: CouncilSessionEntry,
    params: {
      workspaceId: string
      inputType: CouncilInputType
      planContent: string
      grillSessionId?: string
      structuredPlan: StructuredPlan | null
      conversationId?: string
      dbSessionId?: string
    }
  ): void {
    if (params.dbSessionId) {
      entry.dbSessionId = params.dbSessionId
    } else {
      try {
        const dbSession = councilSessionRepository.createSession({
          workspaceId: params.workspaceId,
          inputType: params.inputType,
          inputContent: params.planContent,
          grillSessionId: params.grillSessionId,
          structuredPlanJson: params.structuredPlan
            ? JSON.stringify(params.structuredPlan)
            : undefined,
          conversationId: params.conversationId
        })
        entry.dbSessionId = dbSession.id
      } catch (err) {
        // COUNCIL-02: Fail fast — without a DB session, all subsequent writes
        // silently skip, causing invisible data loss
        councilLog.error('[council] Failed to create DB session — aborting evaluate:', err)
        entry.running = false
        this.startLocks.delete(params.workspaceId)
        this.sessions.delete(params.workspaceId)
        throw new Error(`Council DB session creation failed: ${(err as Error).message}`)
      }
    }
  }

  // ── Private: council pipeline ───────────────────────────────────

  /** Run the 5-step council pipeline: frame → deliberate → peer-review → synthesize → complete. */
  private async runCouncilPipeline(entry: CouncilSessionEntry): Promise<void> {
    try {
      // Step 1: Frame the question (context already provided by params)
      this.setPhase(entry, 'framing')

      // Step 2: Convene the council — 5 parallel advisor sessions
      this.setPhase(entry, 'deliberating')
      if (entry.dbSessionId) councilSessionRepository.updatePhase(entry.dbSessionId, 'deliberating')
      const reviews = await this.runAdvisors(entry)

      if (!entry.running) return // Cancelled

      // Step 3: Peer review — 5 parallel anonymous reviews
      this.setPhase(entry, 'peer-review')
      if (entry.dbSessionId) councilSessionRepository.updatePhase(entry.dbSessionId, 'peer-review')
      const peerReviews = await this.runPeerReviews(entry, reviews)

      if (!entry.running) return // Cancelled

      // Persist peer reviews
      if (entry.dbSessionId)
        councilSessionRepository.savePeerReviews(entry.dbSessionId, peerReviews)

      // Step 4: Chairman synthesis
      this.setPhase(entry, 'synthesizing')
      if (entry.dbSessionId) councilSessionRepository.updatePhase(entry.dbSessionId, 'synthesizing')
      const verdict = await this.runChairman(entry, reviews, peerReviews)

      if (!entry.running) return // Cancelled

      entry.verdict = verdict

      if (verdict) {
        if (entry.dbSessionId) councilSessionRepository.saveVerdict(entry.dbSessionId, verdict)
        this.emit('verdict', { workspaceId: entry.workspaceId, verdict })

        // MEM-COUNCIL-01: Write council verdict as a direct decision fact.
        // Contains recommendation, blind spots, and score — high-value memory.
        try {
          const { memoryEngineService } = await import('./memory-engine.service')
          const { workspaceRepository } = await import('../db/repositories')
          const ws = workspaceRepository.findById(entry.workspaceId)
          const wsSettings = workspaceRepository.getSettings(entry.workspaceId)
          if ((wsSettings as any).memoryCaptureBlueprints !== false && ws) {
            await memoryEngineService.writeFact({
              workspaceId: entry.workspaceId,
              category: 'decision',
              title: `Council verdict: ${entry.framedInput.planContent.substring(0, 80)}`,
              content: [
                `**Score**: ${verdict.overallScore}/10`,
                `**Recommendation**: ${verdict.sections.recommendation}`,
                verdict.sections.blindSpots
                  ? `**Blind Spots**: ${verdict.sections.blindSpots}`
                  : '',
                verdict.sections.oneThingFirst
                  ? `**Do First**: ${verdict.sections.oneThingFirst}`
                  : ''
              ]
                .filter(Boolean)
                .join('\n\n'),
              tags: ['council', 'verdict'],
              sourceType: 'blueprint',
              sourceRef: entry.dbSessionId ?? null,
              workspacePath: ws.repoPath
            })
          }
        } catch (memErr) {
          councilLog.warn('[council] Failed to write verdict memory fact:', memErr)
        }
      }

      // Step 5: Complete
      this.setPhase(entry, 'complete')
      if (entry.dbSessionId) councilSessionRepository.updateStatus(entry.dbSessionId, 'completed')
    } catch (err) {
      councilLog.error('[council] evaluate failed:', err)
      this.setPhase(entry, 'failed')
      if (entry.dbSessionId) councilSessionRepository.updateStatus(entry.dbSessionId, 'failed')
    } finally {
      entry.running = false
      this.startLocks.delete(entry.workspaceId)
      // Defensive cleanup — stop any sessions still held by advisors
      for (const advisor of entry.advisors.values()) {
        if (advisor.session) {
          try {
            await advisor.session.stop()
          } catch {
            /* non-fatal */
          }
        }
      }
      this.sessions.delete(entry.workspaceId)
      // Signal session teardown (NOT 'complete' — that's phase-specific via setPhase)
      this.emit('session-ended', { workspaceId: entry.workspaceId })
    }
  }

  /** Cancel the running council for a specific workspace. */
  cancel(workspaceId?: string): void {
    councilLog.info(
      `[council] Cancel requested${workspaceId ? ` for workspace ${workspaceId}` : ''}`
    )

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
      let session: AgentSessionService | null = null

      try {
        const adapter = new CouncilMemberRoleAdapter({
          workspaceId: entry.workspaceId,
          advisorRole: role,
          framedInput: entry.framedInput,
          llmProvider: entry.llmProvider
        })

        session = new AgentSessionService(adapter)
        advisor.session = session

        // Wire streaming events — tagged with advisor role
        session.on('chunk', (chunk: StreamChunk) => {
          this.emit('member-stream', {
            workspaceId: entry.workspaceId,
            advisorRole: role,
            chunk
          })
        })
        session.on('statusUpdate', (status: AgentStatus) => {
          this.emit('status', { workspaceId: entry.workspaceId, status })
        })

        // Start session in plan mode (read-only)
        await session.start(entry.workspacePath, 'plan')

        const syntheticConvId = `council-${role}-${crypto.randomUUID().slice(0, 8)}`
        advisor.lastConversationId = syntheticConvId
        await session.send('Begin your review.', syntheticConvId, [])

        // Collect response and parse
        const responseText = session.getStreamedContent(syntheticConvId)
        const review = parseCouncilReview(responseText, role)

        if (review) {
          advisor.review = review
          advisor.status = 'completed'
          councilLog.info(`[council:${role}] completed — score=${review.score}`)
          // Persist review incrementally
          if (entry.dbSessionId) {
            try {
              councilSessionRepository.appendAdvisorReview(entry.dbSessionId, review)
            } catch (e) {
              councilLog.warn(`[council:${role}] DB persist failed (non-fatal):`, e)
            }
          }
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
        try {
          if (session) await session.stop()
        } catch {
          /* non-fatal */
        }
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
        const { text: stdout } = await runOneShotClaude({
          feature: 'council_peer_review',
          model: 'claude-haiku-4-5-20251001',
          workspaceId: entry.workspaceId,
          args: [
            '-p',
            `Review these advisor responses:\n\n${anonymizedText}`,
            '--model',
            'claude-haiku-4-5-20251001',
            '--system-prompt',
            systemPrompt,
            '--permission-mode',
            'plan',
            '--max-turns',
            '1'
          ],
          cli: {
            timeout: 120_000 // 2 min timeout
          }
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
    let session: AgentSessionService | null = null

    try {
      const adapter = new CouncilChairmanRoleAdapter({
        workspaceId: entry.workspaceId,
        framedInput: entry.framedInput,
        reviews,
        peerReviews,
        llmProvider: entry.llmProvider
      })

      session = new AgentSessionService(adapter)

      // Wire streaming events
      session.on('chunk', (chunk: StreamChunk) => {
        this.emit('member-stream', {
          workspaceId: entry.workspaceId,
          advisorRole: 'chairman' as string,
          chunk
        })
      })
      session.on('statusUpdate', (status: AgentStatus) => {
        this.emit('status', { workspaceId: entry.workspaceId, status })
      })

      // Use OS temp dir as working directory (chairman has no tools)
      const workDir = os.tmpdir()

      await session.start(workDir, 'plan')
      const syntheticConvId = `council-chairman-${crypto.randomUUID().slice(0, 8)}`
      await session.send('Synthesize the council verdict.', syntheticConvId, [])

      const responseText = session.getStreamedContent(syntheticConvId)
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
      try {
        if (session) await session.stop()
      } catch {
        /* non-fatal */
      }
    }
  }

  // ── Private: session cancellation ──────────────────────────────────

  private cancelSession(entry: CouncilSessionEntry): void {
    entry.running = false
    for (const advisor of entry.advisors.values()) {
      if (advisor.session) {
        try {
          advisor.session.cancelCurrentQuery(advisor.lastConversationId)
        } catch {
          /* non-fatal */
        }
        try {
          advisor.session.stop()
        } catch {
          /* non-fatal — stop() may be sync or already stopped */
        }
      }
    }
    this.setPhase(entry, 'cancelled')
  }

  // ── Resume ──

  /**
   * Resume a failed or stale council session from where it left off.
   * Loads persisted reviews from DB, determines resume point, and
   * re-runs only the incomplete portions of the pipeline.
   */
  async resumeSession(params: {
    sessionId: string
    workspaceId: string
    workspacePath: string
    llmProvider?: LLMProvider
  }): Promise<void> {
    councilLog.info(`[council:resume] Resuming session=${params.sessionId}`)

    const dbSession = councilSessionRepository.findById(params.sessionId)
    if (!dbSession) throw new Error(`Council session not found: ${params.sessionId}`)
    if (dbSession.status === 'completed') throw new Error('Session already complete')

    if (this.startLocks.has(params.workspaceId)) {
      throw new Error(`Council start lock held for workspace ${params.workspaceId}`)
    }
    if (this.sessions.get(params.workspaceId)?.running) {
      throw new Error(`Council already running for workspace ${params.workspaceId}`)
    }
    this.startLocks.add(params.workspaceId)

    // Reconstruct framed input from persisted data
    const structuredPlan = dbSession.structuredPlanJson
      ? (JSON.parse(dbSession.structuredPlanJson) as StructuredPlan)
      : null

    const framedInput: CouncilFramedInput = {
      planContent: dbSession.inputContent,
      structuredPlan,
      originalUserRequest: dbSession.inputContent.slice(0, 200),
      workspaceContext: '',
      filesInScope: [],
      inputType: dbSession.inputType
    }

    // Initialize advisor instances with existing reviews
    const advisors = new Map<CouncilAdvisorRole, AdvisorInstance>()
    const existingReviews = dbSession.advisorReviews
    const completedRoles = new Set(dbSession.completedAdvisors)

    for (const role of COUNCIL_ADVISOR_ROLES) {
      const existingReview = existingReviews.find((r) => r.advisorRole === role) ?? null
      advisors.set(role, {
        role,
        session: null,
        status: completedRoles.has(role) ? 'completed' : 'pending',
        review: existingReview
      })
    }

    const entry: CouncilSessionEntry = {
      workspaceId: params.workspaceId,
      workspacePath: params.workspacePath,
      conversationId: dbSession.conversationId ?? undefined,
      inputType: dbSession.inputType,
      framedInput,
      advisors,
      phase: dbSession.phase,
      verdict: dbSession.verdict,
      running: true,
      llmProvider: params.llmProvider ?? 'claude',
      dbSessionId: params.sessionId
    }

    this.sessions.set(params.workspaceId, entry)

    // Update status to running
    councilSessionRepository.updateStatus(params.sessionId, 'running')

    try {
      // Determine resume point based on last phase
      switch (dbSession.phase) {
        case 'framing':
        case 'deliberating': {
          // Re-run only incomplete advisors, then continue through remaining stages
          this.setPhase(entry, 'deliberating')
          councilSessionRepository.updatePhase(params.sessionId, 'deliberating')
          const reviews = await this.runAdvisorsWithExisting(entry, existingReviews)
          if (!entry.running) return
          await this.runRemainingStages(entry, params.sessionId, reviews)
          break
        }

        case 'peer-review':
          // Reviews exist — re-run peer review + chairman
          await this.runRemainingStages(entry, params.sessionId, existingReviews)
          break

        case 'synthesizing':
          // Peer reviews exist — re-run chairman only
          await this.runRemainingStages(
            entry,
            params.sessionId,
            existingReviews,
            dbSession.peerReviews
          )
          break

        case 'complete':
          throw new Error('Session already complete')

        default:
          throw new Error(`Unknown phase: ${dbSession.phase}`)
      }
    } catch (err) {
      councilLog.error('[council:resume] failed:', err)
      this.setPhase(entry, 'failed')
      councilSessionRepository.updateStatus(params.sessionId, 'failed')
    } finally {
      entry.running = false
      this.startLocks.delete(params.workspaceId)
      for (const advisor of entry.advisors.values()) {
        if (advisor.session) {
          try {
            await advisor.session.stop()
          } catch {
            /* non-fatal */
          }
        }
      }
      this.sessions.delete(params.workspaceId)
      this.emit('complete', { workspaceId: params.workspaceId })
    }
  }

  /**
   * Run the peer-review → synthesizing → complete pipeline from a given point.
   * If existingPeerReviews is provided, peer-review is skipped (chairman only).
   * Shared by all resume switch branches to avoid duplication.
   */
  private async runRemainingStages(
    entry: CouncilSessionEntry,
    sessionId: string,
    reviews: CouncilReview[],
    existingPeerReviews?: CouncilPeerReview[]
  ): Promise<void> {
    let peerReviews: CouncilPeerReview[]

    if (existingPeerReviews) {
      // Skip peer-review — already have results
      peerReviews = existingPeerReviews
    } else {
      // Run peer reviews
      this.setPhase(entry, 'peer-review')
      councilSessionRepository.updatePhase(sessionId, 'peer-review')
      peerReviews = await this.runPeerReviews(entry, reviews)

      if (!entry.running) return
      councilSessionRepository.savePeerReviews(sessionId, peerReviews)
    }

    // Chairman synthesis
    this.setPhase(entry, 'synthesizing')
    councilSessionRepository.updatePhase(sessionId, 'synthesizing')
    const verdict = await this.runChairman(entry, reviews, peerReviews)

    if (!entry.running) return
    entry.verdict = verdict
    if (verdict) {
      councilSessionRepository.saveVerdict(sessionId, verdict)
      this.emit('verdict', { workspaceId: entry.workspaceId, verdict })

      // MEM-COUNCIL-01: Write council verdict (resume path — same as primary path)
      try {
        const { memoryEngineService } = await import('./memory-engine.service')
        const { workspaceRepository } = await import('../db/repositories')
        const ws = workspaceRepository.findById(entry.workspaceId)
        const wsSettings = workspaceRepository.getSettings(entry.workspaceId)
        if ((wsSettings as any).memoryCaptureBlueprints !== false && ws) {
          await memoryEngineService.writeFact({
            workspaceId: entry.workspaceId,
            category: 'decision',
            title: `Council verdict: ${entry.framedInput.planContent.substring(0, 80)}`,
            content: [
              `**Score**: ${verdict.overallScore}/10`,
              `**Recommendation**: ${verdict.sections.recommendation}`,
              verdict.sections.blindSpots ? `**Blind Spots**: ${verdict.sections.blindSpots}` : '',
              verdict.sections.oneThingFirst
                ? `**Do First**: ${verdict.sections.oneThingFirst}`
                : ''
            ]
              .filter(Boolean)
              .join('\n\n'),
            tags: ['council', 'verdict'],
            sourceType: 'blueprint',
            sourceRef: sessionId,
            workspacePath: ws.repoPath
          })
        }
      } catch (memErr) {
        councilLog.warn('[council] Failed to write verdict memory fact (resume):', memErr)
      }
    }

    this.setPhase(entry, 'complete')
    councilSessionRepository.updateStatus(sessionId, 'completed')
  }

  /**
   * Run advisors with partial resume — only executes advisors that haven't completed.
   * Merges existing reviews with newly-completed ones.
   */
  private async runAdvisorsWithExisting(
    entry: CouncilSessionEntry,
    existingReviews: CouncilReview[]
  ): Promise<CouncilReview[]> {
    const reviewsMap = new Map<string, CouncilReview>()

    // Seed with existing reviews
    for (const review of existingReviews) {
      reviewsMap.set(review.advisorRole, review)
    }

    // Only run advisors that don't have completed reviews
    const pendingRoles = COUNCIL_ADVISOR_ROLES.filter((role) => !reviewsMap.has(role))

    if (pendingRoles.length === 0) {
      councilLog.info('[council:resume] All advisors already completed')
      return existingReviews
    }

    councilLog.info(
      `[council:resume] Running ${pendingRoles.length} pending advisor(s): ${pendingRoles.join(', ')}`
    )

    const advisorPromises = pendingRoles.map(async (role) => {
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

        session.on('chunk', (chunk: StreamChunk) => {
          this.emit('member-stream', {
            workspaceId: entry.workspaceId,
            advisorRole: role,
            chunk
          })
        })
        session.on('statusUpdate', (status: AgentStatus) => {
          this.emit('status', { workspaceId: entry.workspaceId, status })
        })

        await session.start(entry.workspacePath, 'plan')
        const syntheticConvId = `council-resume-${role}-${crypto.randomUUID().slice(0, 8)}`
        advisor.lastConversationId = syntheticConvId
        await session.send('Begin your review.', syntheticConvId, [])

        const responseText = session.getStreamedContent(syntheticConvId)
        const review = parseCouncilReview(responseText, role)

        if (review) {
          advisor.review = review
          advisor.status = 'completed'
          reviewsMap.set(role, review)
          if (entry.dbSessionId) {
            try {
              councilSessionRepository.appendAdvisorReview(entry.dbSessionId, review)
            } catch (e) {
              councilLog.warn(`[council:resume:${role}] DB persist failed:`, e)
            }
          }
        } else {
          advisor.status = 'completed'
        }

        this.emit('member-complete', {
          workspaceId: entry.workspaceId,
          advisorRole: role,
          review: advisor.review
        })

        return review
      } catch (err) {
        councilLog.error(`[council:resume:${role}] failed:`, err)
        advisor.status = 'failed'
        this.emit('member-complete', {
          workspaceId: entry.workspaceId,
          advisorRole: role,
          review: null
        })
        return null
      } finally {
        try {
          await advisor.session?.stop()
        } catch {
          /* non-fatal */
        }
      }
    })

    await Promise.allSettled(advisorPromises)

    return Array.from(reviewsMap.values())
  }

  /**
   * Mark stale 'running' sessions as 'failed'.
   * Called on app startup to detect sessions interrupted by crash/restart.
   */
  reconcileStaleRuns(): void {
    const staleCount = councilSessionRepository.markStaleAsFailed()
    if (staleCount > 0) {
      councilLog.info(`[council:reconcile] Marked ${staleCount} stale council session(s) as failed`)
    }
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
