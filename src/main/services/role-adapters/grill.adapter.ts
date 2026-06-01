/**
 * GrillRoleAdapter — drives AgentSessionService for a single grill evaluation.
 *
 * Key differences vs. chat adapters:
 *   - Single-shot: one message ("Begin your evaluation.") → one response → done.
 *   - Read-only: write tools are explicitly disallowed.
 *   - No personas, no control-tool callbacks.
 *   - Always runs in 'plan' mode (no build mode).
 *   - Longer interaction timeout (10 min per evaluation).
 *   - MCP servers mounted: code-graph + semantic-search + git-context + code-analysis (NO control-actions).
 *   - Uses intentDetector.detectAll() to find grill-evaluation regex blocks.
 */

import type { GrillTrackId } from '../../../shared/types'
import type {
  AdapterPromptContext,
  AdapterPromptResult,
  AdapterSessionLifecycleCtx
} from '../agent-session.types'
import { GRILL_TRACKS } from '../../../shared/constants'
import { BaseRoleAdapter, type McpStrategy } from './base.adapter'
import {
  buildReEvalBlock,
  buildGrillEvaluationSchema,
  buildGrillEvaluationSchemaLean,
  GRILL_QUESTION_QUALITY_RULES,
  GRILL_QUESTION_QUALITY_RULES_LEAN,
  GRILL_SCORING_RULES,
  GRILL_SCORING_RULES_LEAN,
  isGrillLean
} from './grill-prompt-blocks'
import { sanitizePromptInput } from '../sanitize-prompt-input'


export class GrillRoleAdapter extends BaseRoleAdapter {
  readonly role = 'grill' as const
  readonly agentId: string
  interactionTimeoutMs = 10 * 60_000 // 10 min per evaluation (adjusted for local LLMs in onSessionStart)

  private readonly workspaceId: string
  private readonly trackId: GrillTrackId
  private readonly ideaTitle: string
  private readonly ideaDescription: string
  private readonly iterationHistory?: string
  private readonly previousScore?: number

  private readonly llmProvider: import('../../../shared/types').LLMProvider

  private systemPrompt: string | null = null

  constructor(params: {
    workspaceId: string
    trackId: GrillTrackId
    ideaTitle: string
    ideaDescription: string
    iterationHistory?: string
    previousScore?: number
    llmProvider?: import('../../../shared/types').LLMProvider
  }) {
    super()
    this.workspaceId = params.workspaceId
    this.trackId = params.trackId
    this.ideaTitle = params.ideaTitle
    this.ideaDescription = params.ideaDescription
    this.iterationHistory = params.iterationHistory
    this.previousScore = params.previousScore
    this.llmProvider = params.llmProvider ?? 'claude'
    this.agentId = `grill-${params.trackId}-${params.workspaceId}`
  }

  override async onSessionStart(ctx: AdapterSessionLifecycleCtx): Promise<void> {
    // Pattern 2: Centralized workspace feature flag refresh
    this.refreshWorkspaceFeatureFlags(this.workspaceId)

    // Pattern 3: Centralized local LLM timeout
    this.applyLocalLlmTimeout(this.llmProvider)

    const track = GRILL_TRACKS[this.trackId]

    // Pattern 1: Centralized model resolution
    const resolvedModel = this.resolveModel(ctx.workspacePath, 'grill')

    this.systemPrompt = this.buildSystemPrompt(track, resolvedModel)

    // Append MCP tool guidance via base class helper
    this.systemPrompt = this.appendToolGuidance(this.systemPrompt, 1, resolvedModel)

    this.log.info(`[grill-adapter] ${this.trackId} grill started for workspace=${this.workspaceId}`)
  }



  buildPrompts(_ctx: AdapterPromptContext): AdapterPromptResult {
    if (!this.systemPrompt) {
      throw new Error(
        `GrillRoleAdapter.buildPrompts() called before onSessionStart() for track=${this.trackId}`
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

  protected override getMcpStrategy(): McpStrategy { return 'readonly' }
  protected override getIncludeGitContext(): boolean { return this.llmProvider !== 'local-llm' }

  /** No-op memory persistence for evaluation adapters. */
  protected override persistMemory(): void { /* no-op */ }

  override onSessionStop(): void {
    this.systemPrompt = null
    this.repomapEnabled = true
    this.semanticSearchEnabled = true
  }

  // ── Private: prompt construction ───────────────────────────────────

  private buildSystemPrompt(track: (typeof GRILL_TRACKS)[GrillTrackId], model?: string): string {
    const lean = isGrillLean(model)
    const reEvalBlock = buildReEvalBlock(this.previousScore)

    const evaluationSchema = lean
      ? buildGrillEvaluationSchemaLean(this.trackId)
      : buildGrillEvaluationSchema(this.trackId)

    const questionRules = lean
      ? GRILL_QUESTION_QUALITY_RULES_LEAN
      : GRILL_QUESTION_QUALITY_RULES

    const scoringRules = lean
      ? GRILL_SCORING_RULES_LEAN
      : GRILL_SCORING_RULES

    // Lean: compressed instructions — Opus narrates naturally and uses tools-first from schema
    const instructions = lean
      ? `## Instructions
0. Narrate your process — explain what you're checking and why before each tool call.
1. Use Code Graph + Code Analysis tools FIRST (≥1 each) before Read/Grep.
2. No broad codebase scans or documentation reads.
3. Analyze the requirement against each criterion.
4. Provide markdown analysis of gaps.
5. ${evaluationSchema}`
      : `## Instructions
0. **Narrate your process.** Before each tool call, write a brief sentence explaining what you're about to look at and why (e.g., "Let me check the authentication module to assess error handling…"). This helps the user follow along in real time.

1. Use structured tools (Code Graph, Code Analysis) FIRST — see tool guidance sections below. Call at least one Code Graph tool AND one Code Analysis tool before falling back to Read or Grep.
2. Do NOT perform a broad codebase scan or read documentation files (README, Roadmap, etc.).
3. Analyze the requirement against each scoring criterion above.
4. Provide your analysis as markdown text — explain what is well-defined and what is missing.
5. After your analysis, emit EXACTLY ONE structured evaluation block in this format:

${evaluationSchema}`

    return `You are a Grill Analyst — a requirement completeness evaluator.${reEvalBlock}

## Your Task
Evaluate the completeness of a software requirement for the **${track.name}** track.

## Evaluation Criteria
${track.scoringFocus.map((f) => `- ${f}`).join('\n')}

## Requirement
**${sanitizePromptInput(this.ideaTitle)}**

${sanitizePromptInput(this.ideaDescription || 'No description provided.')}

${instructions}

${questionRules}

${scoringRules}`
  }
}
