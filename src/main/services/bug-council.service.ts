import log from 'electron-log/main'
import type {
  BugCouncilPerspective,
  BugCouncilResult
} from '../../shared/types'
import { getDatabase } from '../db/index'
import { SDKExecutor } from './sdk-executor'
import { modelConfigService } from './model-config.service'

const councilLog = log.scope('BugCouncil')

// ── Diagnostic Agent Definitions ──

interface DiagnosticAgent {
  role: BugCouncilPerspective['role']
  displayName: string
  icon: string
  systemPrompt: string
}

const DIAGNOSTIC_AGENTS: DiagnosticAgent[] = [
  {
    role: 'root-cause-analyst',
    displayName: 'Root Cause Analyst',
    icon: '🔍',
    systemPrompt: `You are a Root Cause Analyst. Your job is to identify the true underlying cause of a recurring failure.

## Approach
1. Read the error messages and failure history carefully
2. Distinguish symptoms from root causes
3. Look for the DEEPEST cause — not the surface error
4. Consider: wrong assumptions, missing preconditions, type mismatches, race conditions, state corruption

## Output Format
Respond with ONLY a JSON object:
{
  "finding": "One paragraph describing the root cause. Be specific — name files, functions, and line numbers if apparent from the errors.",
  "confidence": 0.0 to 1.0
}`
  },
  {
    role: 'code-archaeologist',
    displayName: 'Code Archaeologist',
    icon: '🏛️',
    systemPrompt: `You are a Code Archaeologist. Your job is to analyze failure history and identify when and why things started breaking.

## Approach
1. Look for patterns in the failure timeline
2. Identify what changed between working and broken states
3. Check if the failure pattern suggests a recent regression vs a latent bug
4. Consider: recent migrations, dependency changes, API changes, schema evolution

## Output Format
Respond with ONLY a JSON object:
{
  "finding": "One paragraph analyzing the historical context. When did this likely start breaking? What change likely introduced it?",
  "confidence": 0.0 to 1.0
}`
  },
  {
    role: 'pattern-matcher',
    displayName: 'Pattern Matcher',
    icon: '🧩',
    systemPrompt: `You are a Pattern Matcher. Your job is to identify anti-patterns and known bug categories in the failure.

## Approach
1. Classify the failure into known categories: off-by-one, null reference, race condition, infinite loop, memory leak, type coercion, import cycle, missing dependency, schema mismatch
2. Look for recurring anti-patterns in the error messages
3. Check if the fix attempts are making the same mistake repeatedly
4. Consider: are the retries trying the same approach? Is there a fundamental misunderstanding?

## Output Format
Respond with ONLY a JSON object:
{
  "finding": "One paragraph identifying the anti-pattern category and why previous fix attempts failed. What pattern is being repeated?",
  "confidence": 0.0 to 1.0
}`
  },
  {
    role: 'systems-thinker',
    displayName: 'Systems Thinker',
    icon: '🔗',
    systemPrompt: `You are a Systems Thinker. Your job is to identify system-level interactions causing the failure.

## Approach
1. Look beyond the failing component — what systems interact with it?
2. Consider: IPC boundaries, process isolation, database connections, file system state, environment variables, timing dependencies
3. Check if the failure could be caused by a different component than the one erroring
4. Map the dependency chain: what does the failing code depend on, and could any dependency be in a bad state?

## Output Format
Respond with ONLY a JSON object:
{
  "finding": "One paragraph describing the system-level interaction causing the failure. Which components are involved and how do they interact incorrectly?",
  "confidence": 0.0 to 1.0
}`
  },
  {
    role: 'adversarial-tester',
    displayName: 'Adversarial Tester',
    icon: '⚔️',
    systemPrompt: `You are an Adversarial Tester. Your job is to identify edge cases and assumptions that are being violated.

## Approach
1. What assumptions does the code make about its inputs?
2. What edge cases could cause the observed failure: empty arrays, null values, unicode, very long strings, concurrent access, missing files?
3. What happens at boundaries: first item, last item, zero items, maximum items?
4. Could the failure be triggered by an unexpected input combination that previous attempts didn't consider?

## Output Format
Respond with ONLY a JSON object:
{
  "finding": "One paragraph identifying the edge case or violated assumption. What specific input or state condition triggers the failure?",
  "confidence": 0.0 to 1.0
}`
  }
]

const SYNTHESIS_SYSTEM_PROMPT = `You are a Bug Council Synthesizer. You receive findings from 5 diagnostic perspectives on a recurring bug. Your job is to synthesize them into one actionable solution.

## Rules
1. Weigh each perspective by its confidence score
2. Look for agreement — findings that multiple perspectives support are more likely correct
3. Produce a SPECIFIC, ACTIONABLE solution — not general advice
4. Include exact steps the specialist should take
5. Assess the risk of the proposed solution

## Output Format
Respond with ONLY a JSON object:
{
  "solution": "Specific, step-by-step instructions for fixing the bug. Reference exact files, functions, and changes needed.",
  "riskAssessment": "Brief assessment: what could go wrong with this fix? What should be tested?"
}`

// ── Bug Council Service ──

export class BugCouncilService {
  private sdkExecutor = new SDKExecutor()

  /**
   * Convene the Bug Council — run 5 diagnostic agents in parallel,
   * then synthesize their findings into an actionable solution.
   *
   * @param taskId - The failing task
   * @param agentId - The specialist that keeps failing
   * @param taskDescription - What the task was trying to do
   * @param failureHistory - Array of error messages from failed attempts
   * @param files - Relevant file paths for context
   * @param conversationId - For DB tracking
   * @param cwd - Working directory for SDK execution
   */
  async convene(params: {
    taskId: string
    agentId: string
    taskDescription: string
    failureHistory: string[]
    files?: string[]
    conversationId?: string
    cwd: string
  }): Promise<BugCouncilResult> {
    const { taskId, agentId, taskDescription, failureHistory, files, conversationId, cwd } = params

    councilLog.info(
      `Bug Council convened for ${agentId}/${taskId} — ${failureHistory.length} failures`
    )

    // Create DB session
    const sessionId = this.createSession({
      taskId,
      agentId,
      taskDescription,
      failureHistory,
      conversationId
    })

    this.updateSessionStatus(sessionId, 'analyzing')

    // Build the shared context that all diagnostic agents will analyze
    const diagnosticContext = this.buildDiagnosticContext(
      taskDescription,
      failureHistory,
      files
    )

    // Run 5 diagnostic agents in parallel (using Haiku for cost efficiency)
    const haikuModel = modelConfigService.getModel(undefined, 'specialist:simple') // Haiku-tier
    const perspectives: BugCouncilPerspective[] = []

    try {
      const diagnosticPromises = DIAGNOSTIC_AGENTS.map((agent) =>
        this.runDiagnosticAgent(agent, diagnosticContext, haikuModel, cwd)
      )

      const results = await Promise.allSettled(diagnosticPromises)

      for (let i = 0; i < results.length; i++) {
        const result = results[i]
        const agent = DIAGNOSTIC_AGENTS[i]

        if (result.status === 'fulfilled') {
          perspectives.push(result.value)
        } else {
          councilLog.warn(`Diagnostic agent ${agent.role} failed:`, result.reason)
          perspectives.push({
            role: agent.role,
            displayName: agent.displayName,
            icon: agent.icon,
            finding: `Analysis failed: ${result.reason instanceof Error ? result.reason.message : 'Unknown error'}`,
            confidence: 0
          })
        }
      }

      // Update DB with perspectives
      this.updateSessionPerspectives(sessionId, perspectives)
      this.updateSessionStatus(sessionId, 'synthesizing')

      // Synthesize findings using Sonnet
      const sonnetModel = modelConfigService.getModel(undefined, 'specialist:moderate') // Sonnet-tier
      const synthesis = await this.synthesize(perspectives, diagnosticContext, sonnetModel, cwd)

      // Build final result
      const result: BugCouncilResult = {
        sessionId,
        taskId,
        agentId,
        taskDescription,
        failureHistory,
        perspectives,
        synthesizedSolution: synthesis.solution,
        riskAssessment: synthesis.riskAssessment,
        finalAttemptSucceeded: null, // set later after retry
        status: 'complete',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString()
      }

      this.updateSessionComplete(sessionId, synthesis.solution, synthesis.riskAssessment)

      councilLog.info(
        `Bug Council complete for ${agentId}/${taskId} — solution: ${synthesis.solution.substring(0, 100)}...`
      )

      return result
    } catch (error) {
      councilLog.error(`Bug Council failed for ${agentId}/${taskId}:`, error)
      this.updateSessionStatus(sessionId, 'failed')

      return {
        sessionId,
        taskId,
        agentId,
        taskDescription,
        failureHistory,
        perspectives,
        synthesizedSolution: '',
        riskAssessment: '',
        finalAttemptSucceeded: null,
        status: 'failed',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString()
      }
    }
  }

  /**
   * Run a single diagnostic agent and parse its response.
   */
  private async runDiagnosticAgent(
    agent: DiagnosticAgent,
    context: string,
    model: string,
    cwd: string
  ): Promise<BugCouncilPerspective> {
    councilLog.info(`Running diagnostic agent: ${agent.role}`)

    const result = await this.sdkExecutor.executeAndCollect({
      prompt: context,
      systemPrompt: agent.systemPrompt,
      model,
      cwd,
      permissionMode: 'plan',
      maxTurns: 1,
      thinking: { type: 'disabled' },
      maxOutputTokens: 500
    })

    // Parse JSON response
    let finding = ''
    let confidence = 0.5

    const responseText = result.result || ''
    try {
      // Extract JSON from response (may have markdown code fences)
      const jsonMatch = responseText.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as { finding?: string; confidence?: number }
        finding = parsed.finding || responseText
        confidence = typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5
      } else {
        finding = responseText
      }
    } catch {
      finding = responseText || 'No analysis produced'
    }

    return {
      role: agent.role,
      displayName: agent.displayName,
      icon: agent.icon,
      finding,
      confidence
    }
  }

  /**
   * Synthesize 5 diagnostic perspectives into an actionable solution.
   */
  private async synthesize(
    perspectives: BugCouncilPerspective[],
    originalContext: string,
    model: string,
    cwd: string
  ): Promise<{ solution: string; riskAssessment: string }> {
    councilLog.info('Synthesizing Bug Council findings')

    const perspectiveText = perspectives
      .map(
        (p) =>
          `### ${p.icon} ${p.displayName} (confidence: ${(p.confidence * 100).toFixed(0)}%)\n${p.finding}`
      )
      .join('\n\n')

    const prompt = `## Original Context\n${originalContext}\n\n## Diagnostic Findings\n\n${perspectiveText}`

    const result = await this.sdkExecutor.executeAndCollect({
      prompt,
      systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
      model,
      cwd,
      permissionMode: 'plan',
      maxTurns: 1,
      thinking: { type: 'enabled', budgetTokens: 5000 },
      maxOutputTokens: 1000
    })

    const responseText = result.result || ''
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as {
          solution?: string
          riskAssessment?: string
        }
        return {
          solution: parsed.solution || 'No solution produced',
          riskAssessment: parsed.riskAssessment || 'Unknown risk'
        }
      }
    } catch {
      // fallback
    }

    return {
      solution: responseText || 'Synthesis failed — review diagnostic findings manually',
      riskAssessment: 'Could not assess risk — manual review recommended'
    }
  }

  /**
   * Build the diagnostic context shared by all 5 agents.
   */
  private buildDiagnosticContext(
    taskDescription: string,
    failureHistory: string[],
    files?: string[]
  ): string {
    const parts: string[] = []

    parts.push(`## Task Description\n${taskDescription}`)
    parts.push(
      `## Failure History (${failureHistory.length} consecutive failures)\n` +
        failureHistory
          .map((f, i) => `### Attempt ${i + 1}\n${f.substring(0, 2000)}`)
          .join('\n\n')
    )

    if (files && files.length > 0) {
      parts.push(`## Relevant Files\n${files.map((f) => `- ${f}`).join('\n')}`)
    }

    parts.push(
      `\n## Your Task\nAnalyze the above from your specialist perspective. Why does this keep failing? What is everyone missing?`
    )

    return parts.join('\n\n')
  }

  /**
   * Record the final attempt result (success/failure after council guidance).
   */
  updateFinalAttemptResult(sessionId: string, succeeded: boolean): void {
    try {
      const db = getDatabase()
      db.prepare(
        `UPDATE bug_council_sessions SET final_attempt_succeeded = ?, completed_at = datetime('now') WHERE id = ?`
      ).run(succeeded ? 1 : 0, sessionId)
    } catch (err) {
      councilLog.warn('Failed to update final attempt result:', err)
    }
  }

  /**
   * Get a council session by ID.
   */
  getSession(sessionId: string): BugCouncilResult | null {
    try {
      const db = getDatabase()
      const row = db
        .prepare('SELECT * FROM bug_council_sessions WHERE id = ?')
        .get(sessionId) as BugCouncilSessionRow | undefined
      return row ? this.mapRow(row) : null
    } catch (err) {
      councilLog.warn('Failed to get council session:', err)
      return null
    }
  }

  /**
   * List council sessions for a conversation.
   */
  listSessions(conversationId: string): BugCouncilResult[] {
    try {
      const db = getDatabase()
      const rows = db
        .prepare(
          'SELECT * FROM bug_council_sessions WHERE conversation_id = ? ORDER BY created_at DESC'
        )
        .all(conversationId) as BugCouncilSessionRow[]
      return rows.map((r) => this.mapRow(r))
    } catch (err) {
      councilLog.warn('Failed to list council sessions:', err)
      return []
    }
  }

  // ── DB Helpers ──

  private createSession(params: {
    taskId: string
    agentId: string
    taskDescription: string
    failureHistory: string[]
    conversationId?: string
  }): string {
    const db = getDatabase()
    const row = db
      .prepare(
        `INSERT INTO bug_council_sessions (task_id, agent_id, task_description, failure_history_json, conversation_id)
         VALUES (?, ?, ?, ?, ?)
         RETURNING id`
      )
      .get(
        params.taskId,
        params.agentId,
        params.taskDescription,
        JSON.stringify(params.failureHistory),
        params.conversationId ?? null
      ) as { id: string }
    return row.id
  }

  private updateSessionStatus(sessionId: string, status: string): void {
    const db = getDatabase()
    db.prepare('UPDATE bug_council_sessions SET status = ? WHERE id = ?').run(status, sessionId)
  }

  private updateSessionPerspectives(
    sessionId: string,
    perspectives: BugCouncilPerspective[]
  ): void {
    const db = getDatabase()
    db.prepare('UPDATE bug_council_sessions SET perspectives_json = ? WHERE id = ?').run(
      JSON.stringify(perspectives),
      sessionId
    )
  }

  private updateSessionComplete(
    sessionId: string,
    solution: string,
    riskAssessment: string
  ): void {
    const db = getDatabase()
    db.prepare(
      `UPDATE bug_council_sessions SET
        synthesized_solution = ?,
        risk_assessment = ?,
        status = 'complete',
        completed_at = datetime('now')
       WHERE id = ?`
    ).run(solution, riskAssessment, sessionId)
  }

  private mapRow(row: BugCouncilSessionRow): BugCouncilResult {
    return {
      sessionId: row.id,
      taskId: row.task_id,
      agentId: row.agent_id,
      taskDescription: row.task_description,
      failureHistory: JSON.parse(row.failure_history_json || '[]'),
      perspectives: JSON.parse(row.perspectives_json || '[]'),
      synthesizedSolution: row.synthesized_solution || '',
      riskAssessment: row.risk_assessment || '',
      finalAttemptSucceeded:
        row.final_attempt_succeeded === null ? null : row.final_attempt_succeeded === 1,
      status: row.status as BugCouncilResult['status'],
      createdAt: row.created_at,
      completedAt: row.completed_at
    }
  }
}

interface BugCouncilSessionRow {
  id: string
  conversation_id: string | null
  task_id: string
  agent_id: string
  task_description: string
  failure_history_json: string
  perspectives_json: string
  synthesized_solution: string | null
  risk_assessment: string | null
  final_attempt_succeeded: number | null
  status: string
  created_at: string
  completed_at: string | null
}

export const bugCouncilService = new BugCouncilService()
