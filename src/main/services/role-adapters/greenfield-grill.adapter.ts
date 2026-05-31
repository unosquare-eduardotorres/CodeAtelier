/**
 * GreenfieldGrillRoleAdapter — drives grill evaluations for NEW project ideas.
 *
 * Key differences vs. GrillRoleAdapter:
 *   - No MCP tools — evaluates an IDEA, not an existing codebase.
 *   - No workspace settings lookup — no workspace exists yet.
 *   - Greenfield prompt focuses on requirements elicitation for a new project.
 *   - Same scoring scale, same grill-evaluation JSON output format.
 */

import type { GrillTrackId, CostPreference, AgentIntent } from '../../../shared/types'
import type {
  AdapterIntentContext,
  AdapterMcpContext,
  AdapterMcpResult,
  AdapterPromptContext,
  AdapterPromptResult,
  AdapterSessionLifecycleCtx,
  AgentRoleAdapter,
  AgentSessionEventName
} from '../agent-session.types'
import type { ControlActionCallbacks } from '../control-actions.tool'
import { GRILL_TRACKS } from '../../../shared/constants'
import { intentDetector } from '../intent-detector'
import { chatAgentLogger } from '../../logger'
import {
  buildReEvalBlock,
  buildGrillEvaluationSchema,
  buildGrillEvaluationSchemaLean,
  GRILL_QUESTION_QUALITY_RULES,
  GRILL_QUESTION_QUALITY_RULES_GREENFIELD_EXTRA,
  GRILL_QUESTION_QUALITY_RULES_LEAN,
  GRILL_SCORING_RULES,
  GRILL_SCORING_RULES_LEAN,
  isGrillLean
} from './grill-prompt-blocks'
import { modelConfigService } from '../model-config.service'
import { sanitizePromptInput } from '../sanitize-prompt-input'

export class GreenfieldGrillRoleAdapter implements AgentRoleAdapter {
  readonly role = 'grill' as const
  readonly agentId: string
  interactionTimeoutMs = 10 * 60_000 // 10 min per evaluation

  private readonly log = chatAgentLogger
  private readonly trackId: GrillTrackId
  private readonly projectName: string
  private readonly projectDescription: string
  private readonly iterationHistory?: string
  private readonly previousScore?: number
  private readonly llmProvider: import('../../../shared/types').LLMProvider

  private systemPrompt: string | null = null

  constructor(params: {
    trackId: GrillTrackId
    projectName: string
    projectDescription: string
    iterationHistory?: string
    previousScore?: number
    llmProvider?: import('../../../shared/types').LLMProvider
  }) {
    this.trackId = params.trackId
    this.projectName = params.projectName
    this.projectDescription = params.projectDescription
    this.iterationHistory = params.iterationHistory
    this.previousScore = params.previousScore
    this.llmProvider = params.llmProvider ?? 'claude'
    this.agentId = `greenfield-grill-${params.trackId}-${Date.now()}`
  }

  async onSessionStart(ctx: AdapterSessionLifecycleCtx): Promise<void> {
    // Increase timeout for local LLMs
    if (this.llmProvider === 'local-llm') {
      this.interactionTimeoutMs = 45 * 60_000
      this.log.info(`[greenfield-grill-adapter] Using extended timeout (45 min) for local LLM`)
    }

    const track = GRILL_TRACKS[this.trackId]
    // Resolve model for lean prompt optimization (Opus 4.8+ gets compressed guidance)
    const isLocal = modelConfigService.isLocalProvider(ctx.workspacePath)
    const resolvedModel = isLocal ? undefined : modelConfigService.getModel(ctx.workspacePath, 'grill')
    this.systemPrompt = this.buildSystemPrompt(track, resolvedModel)

    this.log.info(
      `[greenfield-grill-adapter] ${this.trackId} grill started for project="${this.projectName}"`
    )
  }

  refreshFeatureFlags(_ctx: AdapterSessionLifecycleCtx): void {
    // No-op — single-shot, no feature flags to refresh
  }

  onConversationSwitch(_conversationId: string): void {
    // No-op — grill evaluators don't switch conversations
  }

  buildPrompts(_ctx: AdapterPromptContext): AdapterPromptResult {
    if (!this.systemPrompt) {
      throw new Error(
        `GreenfieldGrillRoleAdapter.buildPrompts() called before onSessionStart() for track=${this.trackId}`
      )
    }

    let effectiveMessage: string
    if (this.iterationHistory) {
      effectiveMessage = `Re-evaluate based on updated decisions:\n\n${this.iterationHistory}`
    } else {
      effectiveMessage = 'Begin your evaluation.'
    }

    return {
      systemPrompt: this.systemPrompt,
      effectiveMessage
    }
  }

  buildMcpConfig(_ctx: AdapterMcpContext): AdapterMcpResult {
    // No MCP tools — greenfield evaluation is purely conversational
    return {
      allowedTools: ['WebSearch', 'WebFetch'],
      disallowedTools: [
        'Read',
        'Write',
        'Edit',
        'Bash',
        'Glob',
        'Grep',
        'Agent',
        'ToolSearch',
        'ExitPlanMode',
        'AskUserQuestion',
        'TodoWrite', // deprecated — kept for backward compat
        'TaskCreate', // new Task tools (SDK 0.2.136+)
        'TaskUpdate'
      ]
    }
  }

  buildControlCallbacks(_params: {
    conversationId: string | null
    emit: (event: AgentSessionEventName, payload: unknown) => void
    getAccumulatedText: () => string
  }): ControlActionCallbacks {
    // No-op — greenfield grill doesn't use control tools
    return {
      onPlan: () => {},
      onAskUser: () => {},
      onMemory: () => {}
    }
  }

  emitDetectedIntents(ctx: AdapterIntentContext): void {
    // Use intentDetector to find grill-evaluation blocks
    const detectedIntents = intentDetector.detectAll(
      ctx.accumulatedText,
      ctx.controlToolState,
      ctx.mode
    )

    for (const intent of detectedIntents) {
      ctx.emit('intent', intent)
    }

    if (detectedIntents.length === 0) {
      ctx.emit('intent', {
        type: 'response',
        content: ctx.accumulatedText
      } as AgentIntent)
    }
  }

  getCompactionThresholds(
    _costPreference: CostPreference
  ): { suggest: number; auto: number } | null {
    return null
  }

  getPersonaId(): string | null {
    return null
  }

  onSessionStop(): void {
    this.systemPrompt = null
  }

  // ── Private: prompt construction ────────────────────────────────────

  private buildSystemPrompt(track: (typeof GRILL_TRACKS)[GrillTrackId], model?: string): string {
    const lean = isGrillLean(model)
    const reEvalBlock = buildReEvalBlock(this.previousScore)

    const evaluationSchema = lean
      ? buildGrillEvaluationSchemaLean(this.trackId)
      : buildGrillEvaluationSchema(this.trackId)

    const questionRules = lean
      ? GRILL_QUESTION_QUALITY_RULES_LEAN
      : `${GRILL_QUESTION_QUALITY_RULES}\n${GRILL_QUESTION_QUALITY_RULES_GREENFIELD_EXTRA}`

    const scoringRules = lean
      ? GRILL_SCORING_RULES_LEAN
      : GRILL_SCORING_RULES

    // Lean: compressed instructions — Opus narrates naturally
    const instructions = lean
      ? `## Instructions
0. Narrate your reasoning — explain what’s well-defined and what gaps remain.
1. Analyze the project idea against each criterion.
2. Identify decisions made vs. undefined.
3. Provide markdown analysis of gaps.
4. ${evaluationSchema}`
      : `## Instructions
0. **Narrate your reasoning.** Before each scoring decision, explain what aspects are well-defined and what gaps remain. Help the user understand what makes a well-prepared project brief.
1. Analyze the project idea against each scoring criterion above.
2. Identify what decisions have been made and what remains undefined.
3. Provide your analysis as markdown text — explain what is well-defined and what is missing.
4. After your analysis, emit EXACTLY ONE structured evaluation block in this format:

${evaluationSchema}`

    return `You are a Grill Analyst — a requirement completeness evaluator for a NEW project idea.${reEvalBlock}

## Context
You are evaluating a project IDEA, not an existing codebase. There is no code to analyze yet.
Focus on eliciting concrete decisions about scope, tech stack, architecture, user flows,
constraints, and trade-offs that will guide the project's creation.

## Your Task
Evaluate the completeness of a new project idea for the **${track.name}** track.

## Evaluation Criteria
${track.scoringFocus.map((f) => `- ${f}`).join('\n')}

## Project Idea
**${sanitizePromptInput(this.projectName)}**

${sanitizePromptInput(this.projectDescription || 'No description provided.')}

${instructions}

${questionRules}

${scoringRules}`
  }
}
