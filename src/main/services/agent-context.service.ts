/**
 * Agent Context Service — external memory persistence for long-running agents.
 *
 * Implements the Anthropic "lightweight refs" pattern: persists key findings,
 * decisions, and summaries from specialist runs so that future specialists
 * in the same conversation can access them without re-processing.
 *
 * This bridges the gap between ephemeral SubAgent execution (stateless)
 * and persistent cross-agent knowledge (stateful via DB).
 *
 * Usage:
 *   // After specialist completes with findings:
 *   agentContextService.persistFinding(conversationId, agentId, taskId, summary)
 *
 *   // Before specialist runs — inject prior context:
 *   const ctx = agentContextService.getContextForPrompt(conversationId)
 */
import { agentContextRepository } from '../db/repositories'
import type { AgentContextType } from '../db/repositories/agent-context.repository'
import { specialistPoolLogger } from '../logger'

const log = specialistPoolLogger

/** Maximum characters for a single context entry (prevents storing huge outputs) */
const MAX_ENTRY_LENGTH = 2000
/** Default token budget for context injection into prompts */
const DEFAULT_PROMPT_TOKEN_BUDGET = 3000

class AgentContextService {
  /**
   * Persist a finding from a specialist's output.
   * Findings represent discovered facts, analysis results, or investigation conclusions.
   */
  persistFinding(
    conversationId: string,
    agentId: string,
    content: string,
    taskId?: string
  ): void {
    this.persist(conversationId, agentId, 'finding', content, taskId)
  }

  /**
   * Persist a decision made during task execution.
   * Decisions represent architectural choices, tool selections, or strategy changes.
   */
  persistDecision(
    conversationId: string,
    agentId: string,
    content: string,
    taskId?: string
  ): void {
    this.persist(conversationId, agentId, 'decision', content, taskId)
  }

  /**
   * Persist a summary of a specialist's output.
   * Summaries are compact representations of full outputs for cross-agent consumption.
   */
  persistSummary(
    conversationId: string,
    agentId: string,
    content: string,
    taskId?: string
  ): void {
    this.persist(conversationId, agentId, 'summary', content, taskId)
  }

  /**
   * Persist an artifact reference (file path, commit hash, etc.).
   */
  persistArtifact(
    conversationId: string,
    agentId: string,
    content: string,
    taskId?: string
  ): void {
    this.persist(conversationId, agentId, 'artifact', content, taskId)
  }

  /**
   * Build formatted context string for injection into specialist prompts.
   * Returns empty string if no prior context exists.
   */
  getContextForPrompt(conversationId: string, maxTokens: number = DEFAULT_PROMPT_TOKEN_BUDGET): string {
    return agentContextRepository.buildContextForPrompt(conversationId, maxTokens)
  }

  /**
   * Extract a compact summary from specialist output for context persistence.
   * Takes the first ~500 chars as a lightweight ref, preferring the start of output
   * which typically contains the most structured/important content.
   */
  extractSummaryFromOutput(output: string): string {
    if (!output || output.length === 0) return ''

    // Prefer investigation report block if present
    const reportMatch = output.match(/```investigation-report\s*\n([\s\S]*?)```/)
    if (reportMatch) {
      try {
        const parsed = JSON.parse(reportMatch[1].trim())
        const parts: string[] = []
        if (parsed.problem) parts.push(`Problem: ${parsed.problem}`)
        if (parsed.impact) parts.push(`Impact: ${parsed.impact}`)
        if (parsed.rootCause) parts.push(`Root cause: ${parsed.rootCause}`)
        if (parts.length > 0) return parts.join('. ').substring(0, MAX_ENTRY_LENGTH)
      } catch {
        // Fall through to generic extraction
      }
    }

    // Generic: take first meaningful paragraph (skip whitespace and code fences)
    const lines = output.split('\n').filter((l) => l.trim().length > 0 && !l.startsWith('```'))
    const summary = lines.slice(0, 10).join(' ').substring(0, 500)
    return summary || output.substring(0, 500)
  }

  /**
   * Get total estimated tokens of context stored for a conversation.
   * Useful for monitoring context growth.
   */
  getTokenEstimate(conversationId: string): number {
    return agentContextRepository.getTokenEstimate(conversationId)
  }

  /**
   * Clean up all context for a conversation.
   */
  cleanup(conversationId: string): void {
    agentContextRepository.deleteByConversation(conversationId)
    log.debug(`[agent-context] Cleaned up context for conversation ${conversationId}`)
  }

  private persist(
    conversationId: string,
    agentId: string,
    contextType: AgentContextType,
    content: string,
    taskId?: string
  ): void {
    if (!content || content.trim().length === 0) return

    const truncated = content.length > MAX_ENTRY_LENGTH
      ? content.substring(0, MAX_ENTRY_LENGTH) + '…'
      : content

    try {
      agentContextRepository.create(conversationId, agentId, contextType, truncated, taskId)
    } catch (err) {
      log.error(`[agent-context] Failed to persist ${contextType} for ${agentId}:`, err)
    }
  }
}

export const agentContextService = new AgentContextService()
