/**
 * S12: Message-Based Context Reconstruction — rebuilds context from stored messages.
 *
 * When session resume isn't available (local LLMs have no SDK sessions),
 * this reconstructor builds a condensed context from the conversation's
 * stored messages + plan state. No LLM call needed — just DB reads and
 * string concatenation.
 *
 * If the system prompt prefix is byte-identical across turns (S5 produces
 * a stable prompt), oMLX's SSD KV cache restores it instantly (~<5s TTFT
 * instead of 30-90s on long contexts).
 */

import type { ContextWindowTier } from './context-management'
import { messageRepository, conversationRepository } from '../db/repositories'
import { parseDbTimestamp } from '../../shared/db-time'
import { localPlanStateService } from './local-plan-state.service'
import { chatAgentLogger } from '../logger'
import { sanitizePromptInput } from './sanitize-prompt-input'

const log = chatAgentLogger

/**
 * Reconstruct context from stored messages and plan state.
 * Returns null if there's no useful context to reconstruct.
 */
export class LocalContextReconstructor {
  /**
   * Build a context summary from stored conversation history.
   *
   * @param conversationId - The conversation to reconstruct context from
   * @param maxTokenBudget - Maximum tokens to spend on context (typically 25% of window)
   * @param tier - Context window tier for budget scaling
   * @returns A structured context string, or null if no useful context exists
   */
  buildContextFromHistory(params: {
    conversationId: string
    maxTokenBudget: number
    tier: ContextWindowTier
  }): string | null {
    const { conversationId, maxTokenBudget } = params
    const maxChars = Math.floor(maxTokenBudget * 3.5) // Convert tokens → chars

    const parts: string[] = []
    let charCount = 0

    // 1. Load plan state (S3) — most structured, highest priority
    try {
      const planState = localPlanStateService.getForConversation(conversationId)
      if (planState) {
        const planSection = this.buildPlanStateSection(planState)
        if (planSection && charCount + planSection.length <= maxChars) {
          parts.push(planSection)
          charCount += planSection.length
        }
      }
    } catch {
      /* plan state table may not exist yet */
    }

    // 2. Load conversation summary (S6) — if plan state wasn't available
    if (parts.length === 0) {
      try {
        const summary = conversationRepository.getSummary(conversationId)
        if (summary && charCount + summary.length <= maxChars) {
          parts.push(`## Previous Summary\n${summary}`)
          charCount += summary.length

          // Warn when injecting a potentially stale summary — helps diagnose
          // cases where the model receives outdated context.
          try {
            const lastMsgTime = messageRepository.getLastMessageTimestamp(conversationId)
            if (lastMsgTime) {
              const ageDays = (Date.now() - parseDbTimestamp(lastMsgTime).getTime()) / 86400000
              if (ageDays > 3) {
                log.warn(
                  `[S12:stale-summary] conversationId=${conversationId} — injecting summary from ${Math.round(ageDays)}d-old conversation`
                )
              }
            }
          } catch { /* non-fatal */ }
        }
      } catch {
        /* non-fatal */
      }
    }

    // 3. Load recent messages — user messages verbatim, assistant truncated
    // F5: Use findRecentByConversation with SQL LIMIT to avoid loading
    // entire conversation history (wasteful for 50+ message conversations).
    try {
      const messages = messageRepository.findRecentByConversation(conversationId, 10)
      if (messages.length > 0) {
        const messageSection = this.buildMessageSection(messages, maxChars - charCount)
        if (messageSection) {
          parts.push(messageSection)
        }
      }
    } catch {
      /* non-fatal */
    }

    if (parts.length === 0) return null

    let result = parts.join('\n\n')
    // PROMPT-06: Enforce total budget — join separators add chars not tracked by charCount
    if (result.length > maxChars) {
      result = result.slice(0, maxChars)
    }
    log.info(
      `[S12:context-reconstructed] conversationId=${conversationId} ` +
        `parts=${parts.length} chars=${result.length}`
    )
    return result
  }

  /**
   * Build a section from plan state data.
   */
  private buildPlanStateSection(planState: {
    originalRequest: string
    discoveredContext: {
      filesExplored: string[]
      keyFindings: string[]
      planItems: string[]
      nextSteps: string[]
    }
    planText: string
    continuationCount: number
  }): string | null {
    const parts: string[] = []

    if (planState.originalRequest) {
      parts.push(`### Original Request\n${sanitizePromptInput(planState.originalRequest).slice(0, 500)}`)
    }

    const ctx = planState.discoveredContext
    if (ctx.filesExplored.length > 0) {
      parts.push(`### Files Explored\n${ctx.filesExplored.map((f) => `- ${f}`).join('\n')}`)
    }
    if (ctx.planItems.length > 0) {
      parts.push(`### Plan Items\n${ctx.planItems.map((p) => sanitizePromptInput(p)).join('\n')}`)
    }
    if (ctx.keyFindings.length > 0) {
      parts.push(`### Key Findings\n${ctx.keyFindings.map((f) => sanitizePromptInput(f)).join('\n')}`)
    }

    if (planState.planText && planState.planText.length > 50) {
      parts.push(`### Partial Plan\n${sanitizePromptInput(planState.planText).slice(0, 1000)}`)
    }

    if (parts.length === 0) return null
    return `## Saved Plan State (continuation #${planState.continuationCount})\n\n${parts.join('\n\n')}`
  }

  /**
   * Build a section from recent messages.
   * User messages included verbatim (usually short).
   * Assistant messages truncated to first 300 chars.
   */
  private buildMessageSection(
    messages: { role: string; contentMd: string }[],
    maxChars: number
  ): string | null {
    // Take last N messages that fit in budget
    const recent = messages.slice(-10) // At most last 10
    const lines: string[] = []
    let charCount = 0

    for (const msg of recent) {
      const role = msg.role === 'user' ? 'User' : 'Assistant'
      const content = sanitizePromptInput(
        msg.role === 'user'
          ? msg.contentMd.slice(0, 500) // User messages are usually short
          : msg.contentMd.slice(0, 300) // Truncate assistant messages
      )

      const line = `**${role}:** ${content}${content.length < msg.contentMd.length ? '...' : ''}`
      if (charCount + line.length > maxChars) break

      lines.push(line)
      charCount += line.length
    }

    if (lines.length === 0) return null
    return `## Recent Messages\n${lines.join('\n\n')}`
  }
}

export const localContextReconstructor = new LocalContextReconstructor()
