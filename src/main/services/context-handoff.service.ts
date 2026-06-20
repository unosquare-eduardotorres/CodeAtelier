/**
 * context-handoff.service — Generates a compact handoff document when
 * switching LLM providers mid-conversation.
 *
 * The handoff captures the conversation's key decisions, open tasks,
 * and context so the new provider can continue without re-asking.
 */

import log from 'electron-log'

const handoffLog = log.scope('context-handoff')

interface MessageSummary {
  role: string
  content: string
}

class ContextHandoffService {
  /**
   * Generate a fallback handoff document from conversation messages.
   * This is a simple extractive summary — it takes the last N messages
   * and formats them into a handoff document.
   *
   * A future version could use an LLM to generate a smarter summary,
   * but for now this gives the new provider enough context to continue.
   */
  generateFallbackHandoff(messages: MessageSummary[]): string {
    const MAX_MESSAGES = 20
    const MAX_CHARS = 8000

    // Take the most recent messages
    const recentMessages = messages.slice(-MAX_MESSAGES)

    if (recentMessages.length === 0) {
      return 'No prior conversation context available.'
    }

    const lines: string[] = ['The following is a summary of the prior conversation context:', '']

    let totalChars = 0
    for (const msg of recentMessages) {
      const prefix = msg.role === 'user' ? 'User' : 'Assistant'
      const content = msg.content?.trim()
      if (!content) continue

      // Truncate individual messages that are too long
      const truncated = content.length > 1000 ? content.slice(0, 1000) + '… [truncated]' : content

      const line = `**${prefix}:** ${truncated}`
      totalChars += line.length

      if (totalChars > MAX_CHARS) {
        lines.push('… [earlier messages omitted for brevity]')
        break
      }

      lines.push(line)
      lines.push('')
    }

    handoffLog.info(
      `[handoff] Generated fallback handoff: ${recentMessages.length} messages, ${totalChars} chars`
    )

    return lines.join('\n')
  }
}

export const contextHandoffService = new ContextHandoffService()
