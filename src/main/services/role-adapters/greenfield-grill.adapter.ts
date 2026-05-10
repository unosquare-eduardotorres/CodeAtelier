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

  async onSessionStart(_ctx: AdapterSessionLifecycleCtx): Promise<void> {
    // Increase timeout for local LLMs
    if (this.llmProvider === 'local-llm') {
      this.interactionTimeoutMs = 45 * 60_000
      this.log.info(`[greenfield-grill-adapter] Using extended timeout (45 min) for local LLM`)
    }

    const track = GRILL_TRACKS[this.trackId]
    this.systemPrompt = this.buildSystemPrompt(track)

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

  private buildSystemPrompt(track: (typeof GRILL_TRACKS)[GrillTrackId]): string {
    const reEvalBlock =
      this.previousScore != null
        ? `\n## Re-evaluation Context
- Previous score: ${this.previousScore}/100
- ANCHOR your new score to the previous one. Only change when decisions materially fill or reveal gaps.
- Do NOT re-ask questions the user already answered — focus on REMAINING gaps.
- In your analysis, explicitly credit which previous decisions address which criteria.\n`
        : ''

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
**${this.projectName}**

${this.projectDescription || 'No description provided.'}

## Instructions
0. **Narrate your reasoning.** Before each scoring decision, explain what aspects are well-defined and what gaps remain. Help the user understand what makes a well-prepared project brief.
1. Analyze the project idea against each scoring criterion above.
2. Identify what decisions have been made and what remains undefined.
3. Provide your analysis as markdown text — explain what is well-defined and what is missing.
4. After your analysis, emit EXACTLY ONE structured evaluation block in this format:

\`\`\`grill-evaluation
{
  "trackId": "${this.trackId}",
  "score": <number 1-100>,
  "scoreLabel": "<label: Raw | Warming Up | Medium Rare | Well Done | Perfectly Grilled>",
  "feedback": "<2-3 sentence summary of gaps>",
  "questions": [
    {
      "id": "q1",
      "question": "<2-3 sentence question explaining the gap and WHY it matters for implementation>",
      "header": "<short 3-5 word label>",
      "options": [
        { "label": "<concise choice>", "description": "<1-2 sentences: trade-offs, constraints, implications>", "recommended": true, "recommendedReason": "<1 sentence: why this is safest/best given trade-offs>" },
        { "label": "<alternative>", "description": "<trade-offs>" },
        { "label": "<another alternative>", "description": "<trade-offs>" }
      ]
    }
  ],
  "suggestedNextTrack": { "trackId": "<next-track-id>", "reason": "<why>" }
}
\`\`\`

## Question Quality Rules
- Each question MUST target a specific implementation decision, not just "what approach?"
- The "question" field must explain the GAP and its IMPACT (2-3 sentences, not just a label)
- Each option's "description" field is REQUIRED — explain trade-offs, constraints, or implications
- At least 2 of the 5 questions must probe EDGE CASES or FAILURE MODES
- Do NOT ask vague questions like "How should this work?" — ask "What happens when X fails/overflows/conflicts?"
- The recommended option's "recommendedReason" must reference concrete trade-offs (risk, complexity, reversibility) — not just "this is better"
- Since there is NO existing codebase, focus questions on DESIGN CHOICES the user needs to make before building

## Rules
- Score 1-20: Raw — fundamental gaps. Score 21-40: Warming Up. Score 41-60: Medium Rare. Score 61-80: Well Done. Score 81-100: Perfectly Grilled.
- Include exactly 5 questions targeting the weakest areas.
- Each question must have 3-4 options with at most 1 recommended. The recommended option MUST include a "recommendedReason" field.
- suggestedNextTrack is optional — only include if another track would benefit.
- Do NOT emit any other code blocks with the grill-evaluation language tag.`
  }
}
