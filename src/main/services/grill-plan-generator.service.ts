/**
 * GrillPlanGeneratorService — Generates a structured implementation plan
 * from a completed grill session's decisions and iteration history.
 *
 * Uses a one-shot Opus call to synthesize grill decisions into a coherent
 * GrillStructuredPlan that can be handed off to Chat, MPA, or Council.
 */

import log from 'electron-log'
import { runOneShotClaude } from './one-shot-claude'
import { modelConfigService } from './model-config.service'
import { grillSessionRepository } from '../db/repositories/grill-session.repository'
import { planRegistryService } from './plan-registry.service'
import type { GrillStructuredPlan, GrillDecision, GrillTrackScore } from '../../shared/types'
import type { GrillSession } from '../db/repositories/grill-session.repository'

const planLog = log.scope('grill-plan-generator')

// ── System Prompt ───────────────────────────────────────────────────────────

const PLAN_GENERATION_SYSTEM_PROMPT = `You are a senior technical architect synthesizing grill evaluation results into a structured implementation plan.

You receive a grill session's decisions, scores, iteration history, and idea description.
Your job is to produce a comprehensive GrillStructuredPlan JSON document.

RULES:
- Synthesize ALL grill decisions into a coherent implementation plan
- Identify specific files, dependencies, and scope per item
- Derive constraints from the grill decisions (e.g., "User chose circuit breaker pattern → must use resilience library")
- Produce the GrillStructuredPlan JSON inside a fenced \`\`\`grill-plan block
- Each implementation item should have a unique short ID (e.g., "item-1", "item-2")
- Order items by dependency — items with no dependsOn come first
- Include a full requirement document as markdown in the requirementDocument field
- The requirement document should be a complete, standalone specification derived from all grill decisions

OUTPUT FORMAT:
\`\`\`grill-plan
{
  "version": 1,
  "title": "...",
  "summary": "...",
  "goalType": "feature|refactor|bugfix|tests",
  "decisions": [...],
  "items": [...],
  "risks": [...],
  "constraints": [...],
  "originalDescription": "...",
  "requirementDocument": "..."
}
\`\`\`

The JSON must be valid and complete. Do not truncate or abbreviate.`

// ── Service ─────────────────────────────────────────────────────────────────

class GrillPlanGeneratorService {
  /**
   * Generate a structured plan from a grill session.
   * Loads the session from DB, builds a prompt from its data, calls Opus,
   * and parses the result into a GrillStructuredPlan.
   */
  async generate(params: {
    sessionId: string
    ideaId?: string
    workspaceId: string
    workspacePath?: string
  }): Promise<GrillStructuredPlan> {
    planLog.info(
      `[plan-gen] Generating plan for idea=${params.ideaId ?? 'n/a'} session=${params.sessionId}`
    )

    // 1. Load grill session from DB.
    // The persisted row's PK is a fresh UUID — NOT the conversation id passed as
    // sessionId — so resolve by ideaId first, falling back to findById for back-compat.
    const session =
      (params.ideaId ? grillSessionRepository.findByIdeaId(params.ideaId) : null) ??
      grillSessionRepository.findById(params.sessionId)
    if (!session) {
      throw new Error(
        `Grill session not found: idea=${params.ideaId ?? 'n/a'} session=${params.sessionId}`
      )
    }

    // 2. Build prompt from session data
    const prompt = this.buildPrompt(session)

    // 3. Resolve model
    const model = modelConfigService.getModelById(params.workspaceId, 'grill:plan')

    // 4. Call Opus via CLI one-shot
    const responseText = await this.callClaude(prompt, model, params.workspaceId)

    // 5. Parse structured plan from response
    const plan = this.parsePlan(responseText, session.feedback ?? '')
    if (!plan) {
      throw new Error('Failed to parse structured plan from Opus response')
    }

    // 6. Persist to DB (use the resolved row id, not the conversation id)
    grillSessionRepository.savePlan(session.id, plan)

    // 7. Dual-write: register in Plan Hub registry (non-critical)
    try {
      planRegistryService.registerGrillPlan({
        workspaceId: params.workspaceId,
        grillSessionId: session.id,
        plan
      })
    } catch (err) {
      planLog.warn('[plan-gen] Plan registry write failed (non-critical):', err)
    }

    planLog.info(
      `[plan-gen] ✓ Plan generated: ${plan.items.length} items, ${plan.risks.length} risks`
    )
    return plan
  }

  /**
   * Generate a structured plan directly from grill decisions/scores, without a
   * persisted grill session. Mirrors {@link generate} but skips the DB load and
   * savePlan steps — used by the greenfield Create Project wizard, which runs
   * session-less. Returns the synthesized GrillStructuredPlan for handoff.
   */
  async generateFromDecisions(params: {
    projectName: string
    description: string
    grillDecisions: GrillDecision[]
    trackScores?: GrillTrackScore[]
    workspaceId: string
  }): Promise<GrillStructuredPlan> {
    planLog.info(
      `[plan-gen] Generating plan from decisions for project="${params.projectName}" (${params.grillDecisions.length} decisions)`
    )

    // 1. Build prompt from passed-in data
    const prompt = this.buildPromptFromDecisions(params)

    // 2. Resolve model (reuse the grill:plan model config)
    const model = modelConfigService.getModelById(params.workspaceId, 'grill:plan')

    // 3. Call Claude via CLI one-shot
    const responseText = await this.callClaude(prompt, model, params.workspaceId)

    // 4. Parse structured plan from response
    const plan = this.parsePlan(responseText, params.description.trim())
    if (!plan) {
      throw new Error('Failed to parse structured plan from Claude response')
    }

    planLog.info(
      `[plan-gen] ✓ Plan generated from decisions: ${plan.items.length} items, ${plan.risks.length} risks`
    )
    return plan
  }

  /** Build the user prompt from passed-in grill decisions/scores (session-less) */
  private buildPromptFromDecisions(params: {
    projectName: string
    description: string
    grillDecisions: GrillDecision[]
    trackScores?: GrillTrackScore[]
  }): string {
    const sections: string[] = []

    sections.push(`# Grill Session: Plan Generation\n`)

    // Idea context
    sections.push(`## Idea\n`)
    sections.push(`- **Project Name**: ${params.projectName.trim() || 'Untitled'}`)
    if (params.description.trim()) {
      sections.push(`- **Description**: ${params.description.trim()}`)
    }
    sections.push('')

    // Track scores
    if (params.trackScores && params.trackScores.length > 0) {
      sections.push(`## Track Scores\n`)
      for (const track of params.trackScores) {
        sections.push(
          `- **${track.trackId}**: ${track.score}/10${track.scoreLabel ? ` (${track.scoreLabel})` : ''}`
        )
      }
      sections.push('')
    }

    // Decisions
    if (params.grillDecisions.length > 0) {
      sections.push(`## Current Decisions\n`)
      for (const d of params.grillDecisions) {
        const answer = d.selectedOption + (d.otherText ? ` (${d.otherText})` : '')
        sections.push(`- **${d.questionText}**: ${answer}`)
      }
      sections.push('')
    }

    sections.push(
      `\n---\nGenerate a comprehensive GrillStructuredPlan based on the above grill decisions.`
    )

    return sections.join('\n')
  }

  /** Build the user prompt from grill session data */
  private buildPrompt(session: GrillSession): string {
    const sections: string[] = []

    sections.push(`# Grill Session: Plan Generation\n`)

    // Idea context
    sections.push(`## Idea\n`)
    sections.push(`- **Session ID**: ${session.id}`)
    sections.push(`- **Status**: ${session.status}`)
    sections.push(`- **Current Score**: ${session.currentScore ?? 'N/A'}`)
    sections.push(`- **Score Label**: ${session.scoreLabel ?? 'N/A'}`)
    sections.push(`- **Iteration Count**: ${session.iterationCount}`)
    sections.push('')

    // Track scores
    if (session.trackScores && (session.trackScores as unknown[]).length > 0) {
      sections.push(`## Track Scores\n`)
      for (const track of session.trackScores as Array<{
        trackId: string
        score: number
        label?: string
      }>) {
        sections.push(
          `- **${track.trackId}**: ${track.score}/10${track.label ? ` (${track.label})` : ''}`
        )
      }
      sections.push('')
    }

    // Feedback / evaluation
    if (session.feedback) {
      sections.push(`## Latest Feedback\n`)
      sections.push(session.feedback)
      sections.push('')
    }

    // Iteration history
    if (session.history && (session.history as unknown[]).length > 0) {
      sections.push(`## Iteration History\n`)
      for (const entry of session.history as Array<{
        trackId?: string
        score?: number
        feedback?: string
        decisions?: unknown[]
      }>) {
        sections.push(
          `### Iteration (${entry.trackId ?? 'unknown'}) — Score: ${entry.score ?? 'N/A'}`
        )
        if (entry.feedback) sections.push(entry.feedback)
        if (entry.decisions && Array.isArray(entry.decisions)) {
          sections.push(`\nDecisions:`)
          for (const d of entry.decisions as Array<{
            question?: string
            answer?: string
            rationale?: string
          }>) {
            sections.push(
              `- Q: ${d.question ?? '?'}\n  A: ${d.answer ?? '?'}${d.rationale ? `\n  Rationale: ${d.rationale}` : ''}`
            )
          }
        }
        sections.push('')
      }
    }

    // Question states (current iteration answers)
    if (session.questionStates) {
      sections.push(`## Current Decisions\n`)
      const states = session.questionStates as Record<
        string,
        { question?: string; answer?: string; rationale?: string }
      >
      for (const [key, state] of Object.entries(states)) {
        if (state.answer) {
          sections.push(
            `- **${state.question ?? key}**: ${state.answer}${state.rationale ? ` (${state.rationale})` : ''}`
          )
        }
      }
      sections.push('')
    }

    // Messages (conversation context)
    if (session.messages && (session.messages as unknown[]).length > 0) {
      sections.push(`## Conversation Context (last 10 messages)\n`)
      const msgs = session.messages as Array<{ role?: string; content?: string }>
      const lastMessages = msgs.slice(-10)
      for (const msg of lastMessages) {
        if (msg.content && typeof msg.content === 'string') {
          const preview = msg.content.length > 500 ? msg.content.slice(0, 500) + '...' : msg.content
          sections.push(`[${msg.role ?? 'unknown'}]: ${preview}\n`)
        }
      }
    }

    sections.push(
      `\n---\nGenerate a comprehensive GrillStructuredPlan based on the above grill session data.`
    )

    return sections.join('\n')
  }

  /** Call Claude CLI in one-shot mode */
  private async callClaude(prompt: string, model: string, workspaceId?: string): Promise<string> {
    try {
      const { text } = await runOneShotClaude({
        feature: 'grill_plan',
        model,
        workspaceId: workspaceId || null,
        args: [
          '-p',
          prompt,
          '--model',
          model,
          '--system-prompt',
          PLAN_GENERATION_SYSTEM_PROMPT,
          '--permission-mode',
          'plan',
          '--max-turns',
          '1'
        ],
        cli: {
          timeout: 180_000, // 3 minutes — plan generation is heavier
          maxBuffer: 1024 * 1024 * 10 // 10MB buffer for large plans
        }
      })
      return text
    } catch (err) {
      planLog.error('[plan-gen] Claude CLI call failed:', err)
      throw new Error(`Plan generation failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Parse the grill-plan JSON block from Claude's response */
  private parsePlan(text: string, fallbackDescription: string): GrillStructuredPlan | null {
    const regex = /```grill-plan\n([\s\S]*?)```/g
    let lastMatch: RegExpExecArray | null = null
    let match: RegExpExecArray | null

    while ((match = regex.exec(text)) !== null) {
      lastMatch = match
    }

    if (!lastMatch) {
      planLog.error('[plan-gen] No ```grill-plan``` block found in response')
      return null
    }

    try {
      const parsed = JSON.parse(lastMatch[1]) as GrillStructuredPlan

      // Validate required fields
      if (!parsed.title || !parsed.summary || !Array.isArray(parsed.items)) {
        planLog.error('[plan-gen] Parsed plan missing required fields')
        return null
      }

      // Ensure version is set
      parsed.version = 1

      // Ensure originalDescription is populated from the fallback if missing
      if (!parsed.originalDescription) {
        parsed.originalDescription = fallbackDescription
      }

      return parsed
    } catch (err) {
      planLog.error('[plan-gen] Failed to parse grill-plan JSON:', err)
      return null
    }
  }
}

export const grillPlanGeneratorService = new GrillPlanGeneratorService()
