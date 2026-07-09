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

import type { CouncilAdvisorRole, LLMProvider } from '../../../shared/types'
import type { CouncilFramedInput } from '../../../shared/types'
import type {
  AdapterMcpContext,
  AdapterPromptContext,
  AdapterPromptResult,
  AdapterSessionLifecycleCtx
} from '../agent-session.types'
import type { AdapterMcpResult } from '../agent-session.types'
import { COUNCIL_ADVISORS, resolvePromptVerbosity } from '../../../shared/constants'
import { buildNoToolsConfig } from './evaluation-mcp-config'
import { BaseRoleAdapter, type McpStrategy } from './base.adapter'

export class CouncilMemberRoleAdapter extends BaseRoleAdapter {
  readonly role = 'council-member' as const
  readonly agentId: string
  interactionTimeoutMs = 5 * 60_000 // 5 min per advisor (same as plan in audit)

  private readonly workspaceId: string
  private readonly advisorRole: CouncilAdvisorRole
  private readonly framedInput: CouncilFramedInput
  private readonly llmProvider: LLMProvider

  private systemPrompt: string | null = null
  private resolvedModel: string | undefined

  constructor(params: {
    workspaceId: string
    advisorRole: CouncilAdvisorRole
    framedInput: CouncilFramedInput
    llmProvider?: LLMProvider
  }) {
    super()
    this.workspaceId = params.workspaceId
    this.advisorRole = params.advisorRole
    this.framedInput = params.framedInput
    this.llmProvider = params.llmProvider ?? 'claude'
    this.agentId = `council-${params.advisorRole}-${params.workspaceId}`
  }

  override async onSessionStart(ctx: AdapterSessionLifecycleCtx): Promise<void> {
    // Pattern 2: Centralized workspace feature flag refresh
    this.refreshWorkspaceFeatureFlags(this.workspaceId)

    // Pattern 3: Centralized local LLM timeout
    this.applyLocalLlmTimeout(this.llmProvider)

    // Pattern 1: Centralized model resolution
    this.resolvedModel = this.resolveModel(ctx.workspacePath, 'council-member')

    this.systemPrompt = this.buildSystemPrompt()

    // Append MCP tool guidance for roles with tool access (not Outsider)
    const advisor = COUNCIL_ADVISORS[this.advisorRole]
    if (advisor.toolAccess !== 'none') {
      this.systemPrompt = this.appendToolGuidance(this.systemPrompt, 1, this.resolvedModel)
    }

    this.log.info(
      `[council-member:${this.advisorRole}] session started for workspace=${this.workspaceId}`
    )
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

  protected override getMcpStrategy(_ctx?: AdapterMcpContext): McpStrategy {
    const advisor = COUNCIL_ADVISORS[this.advisorRole]
    return advisor.toolAccess === 'none' ? 'none' : 'readonly'
  }

  override buildMcpConfig(ctx: AdapterMcpContext): AdapterMcpResult {
    // Outsider role has no tools; other roles get read-only
    const advisor = COUNCIL_ADVISORS[this.advisorRole]
    if (advisor.toolAccess === 'none') return buildNoToolsConfig()
    return super.buildMcpConfig(ctx)
  }

  protected override getIncludeGitContext(): boolean {
    return this.llmProvider !== 'local-llm'
  }

  override onSessionStop(): void {
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

    let prompt: string

    if (isLean) {
      prompt = `You are a Council Advisor — ${advisor.name}.

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
    } else {
      prompt = `You are a Council Advisor — ${advisor.name}.

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

    return prompt
  }
}
