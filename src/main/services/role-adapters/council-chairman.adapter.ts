/**
 * CouncilChairmanRoleAdapter — drives AgentSessionService for the final synthesis.
 *
 * The chairman receives:
 *   - All 5 advisor reviews (de-anonymized)
 *   - All 5 peer reviews
 *   - The original framed input
 *
 * Produces the final verdict: agrees/clashes/blindSpots/recommendation/oneThingFirst.
 * NO MCP tools — pure synthesis of existing reviews.
 */

import type { LLMProvider } from '../../../shared/types'
import type { CouncilReview, CouncilPeerReview, CouncilFramedInput } from '../../../shared/types'
import type {
  AdapterPromptContext,
  AdapterPromptResult,
  AdapterSessionLifecycleCtx,
  AdapterMcpContext,
  AdapterMcpResult
} from '../agent-session.types'
import { resolvePromptVerbosity } from '../../../shared/constants'
import { BaseRoleAdapter, type McpStrategy } from './base.adapter'
import { buildNoToolsConfig } from './evaluation-mcp-config'

export class CouncilChairmanRoleAdapter extends BaseRoleAdapter {
  readonly role = 'council-chairman' as const
  readonly agentId: string
  interactionTimeoutMs = 3 * 60_000 // 3 min for synthesis (no tools)

  private readonly workspaceId: string
  private readonly framedInput: CouncilFramedInput
  private readonly reviews: CouncilReview[]
  private readonly peerReviews: CouncilPeerReview[]
  private readonly llmProvider: LLMProvider

  private systemPrompt: string | null = null
  private resolvedModel: string | undefined

  constructor(params: {
    workspaceId: string
    framedInput: CouncilFramedInput
    reviews: CouncilReview[]
    peerReviews: CouncilPeerReview[]
    llmProvider?: LLMProvider
  }) {
    super()
    this.workspaceId = params.workspaceId
    this.framedInput = params.framedInput
    this.reviews = params.reviews
    this.peerReviews = params.peerReviews
    this.llmProvider = params.llmProvider ?? 'claude'
    this.explicitLlmProvider = params.llmProvider
    this.agentId = `council-chairman-${params.workspaceId}`
  }

  override async onSessionStart(ctx: AdapterSessionLifecycleCtx): Promise<void> {
    // Pattern 3: Centralized local LLM timeout (chairman uses 15 min)
    this.applyLocalLlmTimeout(this.llmProvider, 15)

    // Pattern 1: Centralized model resolution
    this.resolvedModel = this.resolveModel(ctx.workspacePath, 'council-chairman')

    this.systemPrompt = this.buildSystemPrompt()

    this.log.info(
      `[council-chairman] session started for workspace=${this.workspaceId} — ${this.reviews.length} reviews, ${this.peerReviews.length} peer reviews`
    )
  }

  buildPrompts(_ctx: AdapterPromptContext): AdapterPromptResult {
    if (!this.systemPrompt) {
      throw new Error('CouncilChairmanRoleAdapter.buildPrompts() called before onSessionStart()')
    }

    return {
      systemPrompt: this.systemPrompt,
      effectiveMessage: 'Synthesize the council verdict.'
    }
  }

  protected override getMcpStrategy(): McpStrategy {
    return 'custom'
  }

  /** Chairman gets memory_search only — read-only synthesis enrichment from workspace knowledge. */
  protected override buildCustomMcpConfig(_ctx: AdapterMcpContext): AdapterMcpResult {
    const base = buildNoToolsConfig()
    return {
      allowedTools: ['mcp__memory__memory_search'],
      disallowedTools: base.disallowedTools
    }
  }

  override onSessionStop(): void {
    this.systemPrompt = null
    this.resolvedModel = undefined
  }

  // ── Private: prompt construction ───────────────────────────────────

  private buildSystemPrompt(): string {
    const isLean = resolvePromptVerbosity(this.resolvedModel ?? '') === 'lean'

    const reviewsSection = this.reviews
      .map((r) => {
        return `### ${r.advisorRole.toUpperCase()} (Score: ${r.score}/100, Verdict: ${r.verdict})

${r.summary}

**Key Findings:**
${r.keyFindings.map((f) => `- ${f}`).join('\n')}

**Blind Spots:**
${r.blindSpots.map((b) => `- ${b}`).join('\n')}

**Evidence:**
${r.evidence.map((e) => `- \`${e.file}\`: ${e.finding}`).join('\n')}`
      })
      .join('\n\n---\n\n')

    const peerReviewsSection = this.peerReviews
      .map((pr) => {
        return `### Peer Review by ${pr.reviewerRole.toUpperCase()}
- **Strongest response:** ${pr.strongestResponse} — ${pr.strongestReason}
- **Biggest blind spot:** ${pr.biggestBlindSpot} — ${pr.blindSpotDescription}
- **Missed by all:** ${pr.missedByAll}`
      })
      .join('\n\n')

    const averageScore =
      this.reviews.length > 0
        ? Math.round(this.reviews.reduce((sum, r) => sum + r.score, 0) / this.reviews.length)
        : 0

    if (isLean) {
      return `You are the Council Chairman — impartial synthesizer of five advisor reviews.

## Rules
Don't be diplomatic — present disagreements directly. Weight evidence over assertion. Convergence (3+ advisors) = strong signal. Peer review reveals blind spots. End with ONE concrete next action.

## Input Summary
- **Type:** ${this.framedInput.inputType}
- **Average score:** ${averageScore}/100
- **Range:** ${Math.min(...this.reviews.map((r) => r.score))}–${Math.max(...this.reviews.map((r) => r.score))}

## Original Request
${this.framedInput.originalUserRequest}

## Advisor Reviews

${reviewsSection}

## Peer Reviews

${peerReviewsSection}

## Output
Emit ONE \`\`\`council-verdict block:
{"overallScore": 1-100, "sections": {"agrees": "...", "clashes": "...", "blindSpots": "...", "recommendation": "...", "oneThingFirst": "..."}, "revisions": [{"priority": "high|medium|low", "description": "...", "consensus": "X/5", "evidence": "..."}], "individualScores": {"contrarian": N, "first-principles": N, "expansionist": N, "outsider": N, "executor": N}, "rankingsMatrix": {}}`
    }

    return `You are the Council Chairman — the impartial synthesizer of five independent advisor reviews.

## Your Task
You have received reviews from five advisors with different thinking styles, plus their anonymous peer reviews of each other. Your job is to synthesize a clear, actionable verdict.

## Ground Rules
1. **Don't be diplomatic.** If the advisors disagree, present both sides — don't water it down.
2. **Weight evidence over assertion.** Reviews backed by code evidence (file references, tool findings) carry more weight than opinions.
3. **Convergence matters.** When 3+ advisors independently reach the same conclusion, that's a strong signal.
4. **Peer review reveals blindspots.** Pay special attention to things reviewers flagged about each other.
5. **One Thing First.** End with a single, concrete next action — not a list.

## Input Summary
- **Input type:** ${this.framedInput.inputType}
- **Average score:** ${averageScore}/100
- **Score range:** ${Math.min(...this.reviews.map((r) => r.score))} — ${Math.max(...this.reviews.map((r) => r.score))}

## Original Request
${this.framedInput.originalUserRequest}

## Advisor Reviews

${reviewsSection}

## Peer Reviews

${peerReviewsSection}

## Output Format
Emit EXACTLY ONE structured output block:

\`\`\`council-verdict
{
  "overallScore": <weighted average, 1-100>,
  "sections": {
    "agrees": "Points multiple advisors converged on independently...",
    "clashes": "Genuine disagreements — present both sides, don't resolve artificially...",
    "blindSpots": "Things that only emerged through peer review or were missed by all...",
    "recommendation": "Clear, direct recommendation — not 'it depends'...",
    "oneThingFirst": "A single concrete next step — specific enough to act on immediately"
  },
  "revisions": [
    {
      "priority": "high" | "medium" | "low",
      "description": "What needs to change",
      "consensus": "X/5 advisors",
      "evidence": "File or tool reference backing this"
    }
  ],
  "individualScores": {
    "contrarian": <score>,
    "first-principles": <score>,
    "expansionist": <score>,
    "outsider": <score>,
    "executor": <score>
  },
  "rankingsMatrix": {}
}
\`\`\``
  }
}
