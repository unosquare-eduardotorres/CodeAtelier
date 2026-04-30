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
import { workspaceRepository } from '../../db/repositories'
import { modelConfigService } from '../model-config.service'
import { codeGraphMcpService } from '../code-graph.tool'
import { semanticSearchMcpService } from '../semantic-search.tool'
import { gitContextMcpService } from '../git-context.tool'
import { codeAnalysisMcpService } from '../code-analysis.tool'
import { intentDetector } from '../intent-detector'
import { appendMcpToolGuidance, type PromptFeatureFlags } from '../prompt-assembly-helpers'
import { chatAgentLogger } from '../../logger'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'

export class GrillRoleAdapter implements AgentRoleAdapter {
  readonly role = 'grill' as const
  readonly agentId: string
  interactionTimeoutMs = 10 * 60_000 // 10 min per evaluation (adjusted for local LLMs in onSessionStart)

  private readonly log = chatAgentLogger
  private readonly workspaceId: string
  private readonly trackId: GrillTrackId
  private readonly ideaTitle: string
  private readonly ideaDescription: string
  private readonly iterationHistory?: string
  private readonly previousScore?: number

  private systemPrompt: string | null = null

  // Feature flags read on session start
  private repomapEnabled = false
  private semanticSearchEnabled = false

  constructor(params: {
    workspaceId: string
    trackId: GrillTrackId
    ideaTitle: string
    ideaDescription: string
    iterationHistory?: string
    previousScore?: number
  }) {
    this.workspaceId = params.workspaceId
    this.trackId = params.trackId
    this.ideaTitle = params.ideaTitle
    this.ideaDescription = params.ideaDescription
    this.iterationHistory = params.iterationHistory
    this.previousScore = params.previousScore
    this.agentId = `grill-${params.trackId}-${params.workspaceId}`
  }

  async onSessionStart(_ctx: AdapterSessionLifecycleCtx): Promise<void> {
    // Read workspace settings for MCP flags
    try {
      const workspace = workspaceRepository.findById(this.workspaceId)
      if (workspace) {
        const settings = JSON.parse(workspace.settingsJson || '{}')
        this.repomapEnabled = !!settings.repomapEnabled
        this.semanticSearchEnabled = !!settings.semanticSearchEnabled
      }
    } catch {
      /* non-fatal */
    }

    // Increase timeout for local LLMs
    try {
      const workspace = workspaceRepository.findById(this.workspaceId)
      if (workspace && modelConfigService.isLocalProvider(workspace.repoPath)) {
        this.interactionTimeoutMs = 45 * 60_000 // 45 min for local LLMs
        this.log.info(`[grill-adapter] Using extended timeout (45 min) for local LLM`)
      }
    } catch {
      /* non-fatal — keep 10 min default */
    }

    const track = GRILL_TRACKS[this.trackId]

    this.systemPrompt = this.buildSystemPrompt(track)

    // Append MCP tool guidance (same as DaVinci) so the agent knows how to use custom tools
    const featureFlags: PromptFeatureFlags = {
      repomapEnabled: this.repomapEnabled,
      semanticSearchEnabled: this.semanticSearchEnabled,
      githubConfigured: false // grill doesn't mount GitHub tools
    }
    this.systemPrompt = appendMcpToolGuidance(this.systemPrompt, 1, featureFlags)

    this.log.info(`[grill-adapter] ${this.trackId} grill started for workspace=${this.workspaceId}`)
  }

  refreshFeatureFlags(_ctx: AdapterSessionLifecycleCtx): void {
    // No-op — single-shot, no need to refresh mid-evaluation
  }

  onConversationSwitch(_conversationId: string): void {
    // No-op — grill evaluators don't switch conversations
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

  buildMcpConfig(ctx: AdapterMcpContext): AdapterMcpResult {
    const servers: Record<string, McpServerConfig> = {}

    // Code graph (conditional on workspace flag)
    if (this.repomapEnabled && ctx.workspaceId) {
      Object.assign(
        servers,
        codeGraphMcpService.getMcpServersConfig(ctx.workspaceId, ctx.workspacePath)
      )
    }

    // Semantic search (conditional on workspace flag)
    if (this.semanticSearchEnabled && ctx.workspaceId) {
      Object.assign(servers, semanticSearchMcpService.getMcpServersConfig(ctx.workspaceId))
    }

    // Git context: always on
    Object.assign(servers, gitContextMcpService.getMcpServersConfig(ctx.workspacePath))

    // Code analysis: always on
    Object.assign(servers, codeAnalysisMcpService.getMcpServersConfig(ctx.workspacePath))

    // Read-only — NO control-actions MCP, NO checkpoint-context, NO github-context

    return {
      ...(Object.keys(servers).length > 0 ? { mcpServers: servers } : {}),
      // Explicit allow-list: read-only tools only
      allowedTools: [
        'Read',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        // Code graph MCP tools (if mounted)
        ...(this.repomapEnabled && ctx.workspaceId
          ? [
              'mcp__code-graph__graph_map',
              'mcp__code-graph__search_identifiers',
              'mcp__code-graph__find_dead_code',
              'mcp__code-graph__file_outline',
              'mcp__code-graph__find_callers',
              'mcp__code-graph__find_callees',
              'mcp__code-graph__find_references',
              'mcp__code-graph__file_dependencies',
              'mcp__code-graph__file_dependents',
              'mcp__code-graph__symbol_hotspots',
              'mcp__code-graph__coupling_analysis',
              'mcp__code-graph__circular_dependencies',
              'mcp__code-graph__module_boundary_health'
            ]
          : []),
        // Semantic search (if mounted)
        ...(this.semanticSearchEnabled && ctx.workspaceId
          ? [
              'mcp__semantic-search__semantic_search',
              'mcp__semantic-search__similar_code',
              'mcp__semantic-search__codebase_concepts'
            ]
          : []),
        // Git context (always)
        'mcp__git-context__git_log',
        'mcp__git-context__git_diff',
        'mcp__git-context__git_blame',
        // Code analysis (always)
        'mcp__code-analysis__todo_scanner',
        'mcp__code-analysis__dependency_health',
        'mcp__code-analysis__test_coverage_map'
      ],
      // Explicitly block all write + agent tools
      disallowedTools: [
        'Write',
        'Edit',
        'Bash',
        'Agent',
        'ToolSearch',
        'ExitPlanMode',
        'AskUserQuestion',
        'TodoWrite' // Prevent grill from modifying todos
      ]
    }
  }

  buildControlCallbacks(_params: {
    conversationId: string | null
    emit: (event: AgentSessionEventName, payload: unknown) => void
    getAccumulatedText: () => string
  }): ControlActionCallbacks {
    // No-op — grill evaluators don't use control tools
    return {
      onPlan: () => {},
      onAskUser: () => {},
      onMemory: () => {}
    }
  }

  emitDetectedIntents(ctx: AdapterIntentContext): void {
    // Use intentDetector to find grill-evaluation blocks in the accumulated text
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
    this.repomapEnabled = false
    this.semanticSearchEnabled = false
  }

  // ── Private: prompt construction ───────────────────────────────────

  private buildSystemPrompt(track: (typeof GRILL_TRACKS)[GrillTrackId]): string {
    const reEvalBlock = this.previousScore != null
      ? `\n## Re-evaluation Context
- Previous score: ${this.previousScore}/100
- ANCHOR your new score to the previous one. Only change when decisions materially fill or reveal gaps.
- Do NOT re-ask questions the user already answered — focus on REMAINING gaps.
- In your analysis, explicitly credit which previous decisions address which criteria.\n`
      : ''

    return `You are a Grill Analyst — a requirement completeness evaluator.${reEvalBlock}

## Your Task
Evaluate the completeness of a software requirement for the **${track.name}** track.

## Evaluation Criteria
${track.scoringFocus.map((f) => `- ${f}`).join('\n')}

## Requirement
**${this.ideaTitle}**

${this.ideaDescription || 'No description provided.'}

## Instructions
0. **Narrate your process.** Before each tool call, write a brief sentence explaining what you're about to look at and why (e.g., "Let me check the authentication module to assess error handling…"). This helps the user follow along in real time.
1. **Use your tools to ground your analysis.** The tool guidance sections below describe your full toolbox (Code Graph, Semantic Search, Git Context, Code Analysis, Read/Glob/Grep). Follow their priority rules — prefer structured tools (search_identifiers, semantic_search, dependency_health) over raw Read/Grep. Investigate the codebase to ensure your questions target REAL gaps, not hypothetical ones. Do NOT perform a broad codebase scan or read documentation files (README, Roadmap, etc.).
2. Analyze the requirement against each scoring criterion above.
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
        { "label": "<concise choice>", "description": "<1-2 sentences: trade-offs, constraints, implications>", "recommended": true },
        { "label": "<alternative>", "description": "<trade-offs>", "recommended": false }
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

## Rules
- Score 1-20: Raw — fundamental gaps. Score 21-40: Warming Up. Score 41-60: Medium Rare. Score 61-80: Well Done. Score 81-100: Perfectly Grilled.
- Include exactly 5 questions targeting the weakest areas.
- Each question must have 2-4 options with at most 1 recommended.
- suggestedNextTrack is optional — only include if another track would benefit.
- Do NOT emit any other code blocks with the grill-evaluation language tag.`
  }
}
