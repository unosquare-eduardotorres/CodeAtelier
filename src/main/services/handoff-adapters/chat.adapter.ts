/**
 * chat.adapter — Converts Chat conversation context into a HandoffEnvelope.
 *
 * Uses three tiers of context (matching LocalContextReconstructor):
 *  1. Plan state (highest quality, structured)
 *  2. Stored summary (medium quality)
 *  3. Recent messages (lowest quality, unstructured)
 *
 * Confidence score reflects the tier used.
 */

import { HandoffSourceAdapter } from './base.adapter'
import type {
  CompletedStep,
  RemainingStep,
  HandoffDecision,
  HandoffRisk,
  ArtifactRef,
  HandoffSource
} from '../../../shared/handoff-types'
import type { Conversation, Message, StructuredPlan } from '../../../shared/types'

// ── Input Shape ──────────────────────────────────────────────────────

export interface ChatAdapterInput {
  conversation: Conversation
  recentMessages: Message[]
  plan: StructuredPlan | null
  planRecordId?: string
  focusDescription?: string // Optional user-provided focus for the handoff
}

// ── Adapter ──────────────────────────────────────────────────────────

class ChatHandoffAdapter extends HandoffSourceAdapter<ChatAdapterInput> {
  readonly source: HandoffSource = 'chat'

  extractIntent(input: ChatAdapterInput): string {
    if (input.focusDescription) {
      return input.focusDescription.slice(0, 120)
    }
    if (input.plan) {
      return `Continue plan: ${input.plan.title}`
    }
    return `Continue conversation: ${input.conversation.title}`
  }

  extractOriginalGoal(input: ChatAdapterInput): string {
    // Find the first user message as the original goal
    const firstUser = input.recentMessages.find((m) => m.role === 'user')
    if (firstUser) {
      return firstUser.contentMd.slice(0, 500)
    }
    return input.conversation.title
  }

  extractContextSummary(input: ChatAdapterInput): string {
    const lines: string[] = []
    lines.push(`## Chat Context`)
    lines.push(`**Title:** ${input.conversation.title}`)
    lines.push(`**Mode:** ${input.conversation.mode}`)
    lines.push(`**Messages:** ${input.recentMessages.length}`)

    if (input.conversation.summary) {
      lines.push(`\n### Conversation Summary`)
      lines.push(input.conversation.summary)
    }

    if (input.plan) {
      lines.push(`\n### Active Plan: ${input.plan.title}`)
      lines.push(input.plan.summary)
      if (input.plan.phases) {
        lines.push(`**Phases:** ${input.plan.phases.length}`)
      }
    }

    // Include last few message snippets for context
    const lastMessages = input.recentMessages.slice(-5)
    if (lastMessages.length > 0) {
      lines.push(`\n### Recent Messages`)
      for (const msg of lastMessages) {
        const prefix = msg.role === 'user' ? 'User' : 'Assistant'
        const content = msg.contentMd.slice(0, 200)
        lines.push(`- **${prefix}:** ${content}${msg.contentMd.length > 200 ? '...' : ''}`)
      }
    }

    return lines.join('\n')
  }

  extractCompletedWork(input: ChatAdapterInput): CompletedStep[] {
    if (!input.plan) return []

    const steps: CompletedStep[] = []

    // If there's a plan with phases, extract completed ones
    if (input.plan.phases) {
      // Since chat plans don't track phase completion per se, we report the plan as context
      steps.push({
        title: 'Plan created',
        outcome: `${input.plan.title}: ${input.plan.phases.length} phases defined`,
        filesModified: input.plan.files,
      })
    }

    return steps
  }

  extractRemainingWork(input: ChatAdapterInput): RemainingStep[] {
    if (!input.plan?.phases) return []

    return input.plan.phases.map((phase) => ({
      title: phase.title,
      description: phase.description,
      priority: phase.risk === 'high' ? 'high' as const : 'medium' as const,
      estimatedComplexity: phase.complexity,
    }))
  }

  extractDecisions(input: ChatAdapterInput): HandoffDecision[] {
    // Only extract from structured plan data — never from LLM summarization
    if (!input.plan?.decisions) return []
    return input.plan.decisions.map((d) => ({
      what: d.what,
      why: d.why,
    }))
  }

  extractConstraints(input: ChatAdapterInput): string[] {
    return input.plan?.constraints ?? []
  }

  extractRisks(input: ChatAdapterInput): HandoffRisk[] {
    if (!input.plan?.risks) return []
    return input.plan.risks.map((r) => ({
      risk: r.risk,
      severity: r.severity,
      mitigation: r.mitigation,
    }))
  }

  extractArtifacts(input: ChatAdapterInput): ArtifactRef[] {
    const refs: ArtifactRef[] = []
    // Always include a reference to the conversation
    refs.push({
      type: 'plan',
      path: `conversation:${input.conversation.id}`,
      description: `Chat: ${input.conversation.title}`,
    })
    return refs
  }

  extractFilesToReadFirst(input: ChatAdapterInput): string[] {
    if (!input.plan?.files) return []
    return input.plan.files.slice(0, 20)
  }

  extractCommandsToRunFirst(input: ChatAdapterInput): string[] {
    // Suggest running tests/build if the plan has verification steps
    if (input.plan?.verification?.length) {
      return ['npm test', 'npm run build']
    }
    return []
  }

  extractStructuredPlanRef(input: ChatAdapterInput): string | undefined {
    return input.planRecordId
  }

  extractExtensions(input: ChatAdapterInput): Record<string, unknown> {
    return {
      conversationId: input.conversation.id,
      conversationMode: input.conversation.mode,
      messageCount: input.recentMessages.length,
      hasPlan: !!input.plan,
    }
  }
}

export const chatAdapter = new ChatHandoffAdapter()
