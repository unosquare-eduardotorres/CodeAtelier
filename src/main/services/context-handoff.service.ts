/**
 * context-handoff.service — Generates structured context extraction
 * when switching providers mid-conversation.
 *
 * Uses the OUTGOING model (which has context in memory) to produce
 * a structured handoff document that captures the essential conversation
 * state for the incoming model.
 */

import log from 'electron-log'

const handoffLog = log.scope('context-handoff')

/** The extraction prompt sent to the outgoing model */
export const HANDOFF_EXTRACTION_PROMPT = `You are about to hand off this conversation to a different AI model.
Generate a structured handoff document that captures the essential context.

## Required Sections:
### Goal
What is the user trying to accomplish? One paragraph.

### Decisions Made
Bullet list of key decisions with brief rationale.

### Progress
What has been done so far — files modified, features implemented, tests passing.

### Open Questions
Unresolved items that need attention.

### Key Code Context
Files, directories, and patterns currently being worked on.

### Current State
Where things left off — what the user would expect to continue with.

Be concise but complete. This document will be the ONLY context the next model receives.`

class ContextHandoffService {
  /**
   * Format a handoff document as a system prompt section.
   * This is injected into the new model's system prompt after a cross-provider switch.
   */
  formatAsSystemPreamble(handoffDocument: string): string {
    return `## Prior Session Context (Handoff)

The previous AI model in this conversation generated the following context summary
before handing off to you. Use this to understand the conversation state:

${handoffDocument}

---

`
  }

  /**
   * Generate a minimal handoff from conversation messages when the outgoing
   * model is unavailable (e.g., session already terminated).
   *
   * Extracts the last N messages as a condensed context summary.
   */
  generateFallbackHandoff(messages: Array<{ role: string; content: string }>): string {
    const recent = messages.slice(-10) // Last 10 messages
    const sections: string[] = []

    sections.push('### Conversation History (Last Messages)')
    for (const msg of recent) {
      const role = msg.role === 'user' ? 'User' : 'Assistant'
      // Truncate long messages
      const content =
        msg.content.length > 500 ? msg.content.slice(0, 500) + '…' : msg.content
      sections.push(`**${role}:** ${content}`)
    }

    handoffLog.info(
      `[fallback] Generated fallback handoff from ${recent.length} messages`
    )

    return sections.join('\n\n')
  }
}

export const contextHandoffService = new ContextHandoffService()
