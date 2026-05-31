/**
 * CouncilMemberRoleAdapter — drives AgentSessionService for a single council advisor.
 *
 * Key differences vs. GrillRoleAdapter:
 *   - Each instance represents one of five advisor "thinking styles" (not job titles).
 *   - The Outsider role gets NO MCP tools (deliberate — evaluates plan as pure text).
 *   - All other roles get the same read-only suite as Grill (code-graph, semantic-search, etc.).
 *   - Single-shot: one message → one response → done.
 *   - Output is a ```council-review fenced JSON block.
 */

import type { CostPreference, AgentIntent, CouncilAdvisorRole, LLMProvider } from '../../../shared/types'
import type { CouncilFramedInput } from '../../../shared/types'
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
import { COUNCIL_ADVISORS, resolvePromptVerbosity } from '../../../shared/constants'
import { workspaceRepository } from '../../db/repositories'
import { intentDetector } from '../intent-detector'
import { appendMcpToolGuidance, type PromptFeatureFlags } from '../prompt-assembly-helpers'
import { modelConfigService } from '../model-config.service'
import { chatAgentLogger } from '../../logger'
import { buildReadOnlyToolConfig, buildNoToolsConfig } from './evaluation-mcp-config'

export class CouncilMemberRoleAdapter implements AgentRoleAdapter {
  readonly role = 'council-member' as const
  readonly agentId: string
  interactionTimeoutMs = 5 * 60_000 // 5 min per advisor (same as plan in audit)

  private readonly log = chatAgentLogger
  private readonly workspaceId: string
  private readonly advisorRole: CouncilAdvisorRole
  private readonly framedInput: CouncilFramedInput
  private readonly llmProvider: LLMProvider

  private systemPrompt: string | null = null

  // Feature flags read on session start
  private repomapEnabled = true
  private semanticSearchEnabled = true
  private resolvedModel: string | undefined

  constructor(params: {
    workspaceId: string
    advisorRole: CouncilAdvisorRole
    framedInput: CouncilFramedInput
    llmProvider?: LLMProvider
  }) {
    this.workspaceId = params.workspaceId
    this.advisorRole = params.advisorRole
    this.framedInput = params.framedInput
    this.llmProvider = params.llmProvider ?? 'claude'
    this.agentId = `council-${params.advisorRole}-${params.workspaceId}`
  }

  async onSessionStart(ctx: AdapterSessionLifecycleCtx): Promise<void> {
    // Read workspace settings for MCP flags
    try {
      const settings = workspaceRepository.getSettings(this.workspaceId)
      this.repomapEnabled = settings.repomapEnabled !== false
      this.semanticSearchEnabled = settings.semanticSearchEnabled !== false
    } catch {
      /* non-fatal */
    }

    // Increase timeout for local LLMs
    if (this.llmProvider === 'local-llm') {
      this.interactionTimeoutMs = 45 * 60_000
      this.log.info(`[council-member:${this.advisorRole}] Using extended timeout (45 min) for local LLM`)
    }

    // Resolve model for lean prompt gating
    const isLocal = modelConfigService.isLocalProvider(ctx.workspacePath)
    this.resolvedModel = isLocal
      ? undefined
      : modelConfigService.getModel(ctx.workspacePath, 'council-member')

    this.systemPrompt = this.buildSystemPrompt()

    // Append MCP tool guidance for roles with tool access (not Outsider)
    const advisor = COUNCIL_ADVISORS[this.advisorRole]
    if (advisor.toolAccess !== 'none') {
      const featureFlags: PromptFeatureFlags = {
        repomapEnabled: this.repomapEnabled,
        semanticSearchEnabled: this.semanticSearchEnabled,
        githubConfigured: false,
        includeGitContext: false, // council members don't mount git-context tools
        includeCheckpoint: false  // council members don't mount checkpoint tools
      }
      this.systemPrompt = appendMcpToolGuidance(this.systemPrompt, 1, featureFlags, this.resolvedModel)
    }

    this.log.info(
      `[council-member:${this.advisorRole}] session started for workspace=${this.workspaceId}`
    )
  }

  refreshFeatureFlags(_ctx: AdapterSessionLifecycleCtx): void {
    // No-op — single-shot, no need to refresh mid-evaluation
  }

  onConversationSwitch(_conversationId: string): void {
    // No-op — council members don't switch conversations
  }

  buildPrompts(_ctx: AdapterPromptContext): AdapterPromptResult {
    if (!this.systemPrompt) {
      throw new Error(
        `CouncilMemberRoleAdapter.buildPrompts() called before onSessionStart() for role=${this.advisorRole}`
      )
    }

    return {
      systemPrompt: this.systemPrompt,
      effectiveMessage: 'Begin your review.'
    }
  }

  buildMcpConfig(ctx: AdapterMcpContext): AdapterMcpResult {
    const advisor = COUNCIL_ADVISORS[this.advisorRole]

    // Outsider: NO tools at all — pure text evaluation
    if (advisor.toolAccess === 'none') {
      return buildNoToolsConfig()
    }

    // All other roles: read-only suite (same as GrillRoleAdapter)
    return buildReadOnlyToolConfig({
      repomapEnabled: this.repomapEnabled,
      semanticSearchEnabled: this.semanticSearchEnabled,
      hasWorkspace: !!ctx.workspaceId,
      includeGitContext: this.llmProvider !== 'local-llm'
    })
  }

  buildControlCallbacks(_params: {
    conversationId: string | null
    emit: (event: AgentSessionEventName, payload: unknown) => void
    getAccumulatedText: () => string
  }): ControlActionCallbacks {
    // No-op — council members don't use control tools
    return {
      onPlan: () => {},
      onAskUser: () => {},
      onMemory: () => {}
    }
  }

  emitDetectedIntents(ctx: AdapterIntentContext): void {
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
    this.repomapEnabled = true
    this.semanticSearchEnabled = true
    this.resolvedModel = undefined
  }

  // ── Private: prompt construction ───────────────────────────────────

  private buildSystemPrompt(): string {
    const advisor = COUNCIL_ADVISORS[this.advisorRole]
    const { framedInput } = this
    const isLean = resolvePromptVerbosity(this.resolvedModel ?? '') === 'lean'

    const planSection = framedInput.structuredPlan
      ? `## Structured Plan
\`\`\`json
${JSON.stringify(framedInput.structuredPlan, null, 2)}
\`\`\`

## Plan Content (Markdown)
${framedInput.planContent}`
      : `## Input
${framedInput.planContent}`

    const filesSection =
      framedInput.filesInScope.length > 0
        ? `\n## Files in Scope\n${framedInput.filesInScope.map((f) => `- ${f}`).join('\n')}`
        : ''

    const contextSection = framedInput.workspaceContext
      ? `\n## Workspace Context\n${framedInput.workspaceContext}`
      : ''

    if (isLean) {
      return `You are a Council Advisor — ${advisor.emoji} ${advisor.name}.

## Thinking Style
${advisor.thinkingStyle}

## Task
One of five independent advisors reviewing a ${framedInput.inputType}. Bring YOUR unique perspective — lean into your role.

## Original Request
${framedInput.originalUserRequest}

${planSection}
${filesSection}
${contextSection}

## Tool Guidance
${advisor.toolGuidance}

## Output
Narrate findings, then emit ONE \`\`\`council-review block:
{"advisorRole": "${this.advisorRole}", "score": 1-100, "verdict": "proceed-with-changes"|"needs-revision"|"rethink", "keyFindings": [...], "blindSpots": [...], "evidence": [{"file": "path", "finding": "..."}], "summary": "150-300 words"}

Scoring: 80-100 excellent, 60-79 good, 40-59 concerning, 1-39 problematic.
Verdict: proceed-with-changes = sound approach, needs-revision = material issues, rethink = fundamental problems.`
    }

    return `You are a Council Advisor — ${advisor.emoji} ${advisor.name}.

## Your Thinking Style
${advisor.thinkingStyle}

## Your Task
You are one of five independent advisors reviewing a ${framedInput.inputType}. You do NOT know what the other advisors think. Your job is to bring YOUR unique perspective — don't try to be balanced or diplomatic. Lean into your role.

## Original Request
${framedInput.originalUserRequest}

${planSection}
${filesSection}
${contextSection}

## Tool Guidance
${advisor.toolGuidance}

## Output Format
After your analysis, narrate your thought process and findings, then emit EXACTLY ONE structured output block:

\`\`\`council-review
{
  "advisorRole": "${this.advisorRole}",
  "score": <1-100>,
  "verdict": "proceed-with-changes" | "needs-revision" | "rethink",
  "keyFindings": ["finding 1", "finding 2", "finding 3"],
  "blindSpots": ["blind spot 1"],
  "evidence": [
    { "file": "src/example.ts", "finding": "description of what you found" }
  ],
  "summary": "150-300 word summary of your analysis"
}
\`\`\`

## Scoring Guide
- **80-100**: Excellent — ready to proceed as-is or with minor tweaks
- **60-79**: Good — has merit but needs specific improvements
- **40-59**: Concerning — significant issues that need addressing before proceeding
- **1-39**: Problematic — fundamental issues; recommend rethinking the approach

## Verdict Guide
- **proceed-with-changes**: The approach is sound; listed changes improve it but aren't blocking
- **needs-revision**: Material issues that should be fixed before proceeding
- **rethink**: Fundamental problems with the approach itself`
  }
}
