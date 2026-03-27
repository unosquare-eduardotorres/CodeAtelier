import { dbLogger } from '../logger'
import { memoryRepository } from '../db/repositories'
import type { Memory, MemoryType } from '../../shared/types'

const log = dbLogger

/** Regex to detect memory blocks emitted by the generalist */
const MEMORY_BLOCK_REGEX = /```memory\n([\s\S]*?)```/g

/** Maximum character budget for memory context in prompts (10K chars ≈ 2.5K tokens) */
const DEFAULT_PROMPT_BUDGET = 10000

/**
 * Service for managing auto memories — persistent cross-session knowledge
 * extracted from conversations and injected into agent prompts.
 */
class MemoryService {
  /**
   * Build a formatted string of memories suitable for injection into an agent's system prompt.
   * Orders by importance DESC, respects a character budget.
   */
  getContextForPrompt(workspaceId: string, maxChars: number = DEFAULT_PROMPT_BUDGET): string {
    try {
      const memories = memoryRepository.getForPrompt(workspaceId, maxChars)
      if (memories.length === 0) return ''

      // Touch memories so we track last_accessed_at
      memoryRepository.touchMemories(memories.map((m) => m.id))

      // Group by type for structured output
      const grouped: Record<string, Memory[]> = {}
      for (const mem of memories) {
        if (!grouped[mem.type]) grouped[mem.type] = []
        grouped[mem.type].push(mem)
      }

      const sections: string[] = []

      // User preferences first (cross-workspace)
      if (grouped.user) {
        sections.push(
          '### User Preferences\n' +
            grouped.user.map((m) => `- **${m.title}**: ${m.content}`).join('\n')
        )
      }

      // Project memories (per-workspace)
      if (grouped.project) {
        sections.push(
          '### Project Knowledge\n' +
            grouped.project.map((m) => `- **${m.title}**: ${m.content}`).join('\n')
        )
      }

      // Reference memories
      if (grouped.reference) {
        sections.push(
          '### References\n' +
            grouped.reference.map((m) => `- **${m.title}**: ${m.content}`).join('\n')
        )
      }

      // Feedback & corrections placed LAST — recency bias in attention means
      // content at the end of the context window gets stronger weighting.
      // This ensures behavioral corrections are most likely to be followed.
      if (grouped.feedback) {
        sections.push(
          '### Feedback & Corrections (IMPORTANT — follow these)\n' +
            grouped.feedback.map((m) => `- **${m.title}**: ${m.content}`).join('\n')
        )
      }

      return sections.join('\n\n')
    } catch (error) {
      log.error('Failed to build memory context for prompt:', error)
      return ''
    }
  }

  /**
   * Parse memory blocks from accumulated text and persist them to the database.
   * Returns the number of memories created.
   *
   * Memory blocks look like:
   * ```memory
   * {"type": "user", "title": "Preferred testing approach", "content": "..."}
   * ```
   */
  processMemoryBlocks(
    text: string,
    conversationId: string,
    agentId: string,
    workspaceId: string
  ): number {
    let created = 0
    let match: RegExpExecArray | null

    // Reset lastIndex for global regex
    MEMORY_BLOCK_REGEX.lastIndex = 0

    while ((match = MEMORY_BLOCK_REGEX.exec(text)) !== null) {
      try {
        const data = JSON.parse(match[1].trim())
        if (!data.type || !data.title || !data.content) {
          log.warn('Skipping memory block with missing fields:', data)
          continue
        }

        const validTypes: MemoryType[] = ['user', 'feedback', 'project', 'reference']
        if (!validTypes.includes(data.type)) {
          log.warn(`Skipping memory block with invalid type: ${data.type}`)
          continue
        }

        // Determine workspace scope: user/feedback are cross-workspace (null), project/reference are per-workspace
        const memWorkspaceId = data.type === 'user' || data.type === 'feedback' ? null : workspaceId

        memoryRepository.create({
          workspaceId: memWorkspaceId,
          type: data.type,
          title: data.title,
          content: data.content,
          tags: Array.isArray(data.tags) ? data.tags : [],
          sourceConversationId: conversationId,
          sourceAgentId: agentId,
          importance: typeof data.importance === 'number' ? data.importance : 5
        })

        created++
        log.info(`Memory created: [${data.type}] ${data.title}`)
      } catch (error) {
        log.error('Failed to parse memory block:', error)
      }
    }

    return created
  }

  /**
   * Get feedback memories filtered by specialist domain.
   * Used to inject relevant corrections into specialist prompts.
   */
  getFeedbackForSpecialist(
    workspaceId: string,
    specialistId: string,
    maxChars: number = 2000
  ): string {
    try {
      const feedbackMemories = memoryRepository.findByType(workspaceId, 'feedback')
      if (feedbackMemories.length === 0) return ''

      // Filter feedback that may be relevant to this specialist
      // Simple heuristic: check if specialist ID appears in tags or content
      const relevant = feedbackMemories.filter(
        (m) =>
          m.tags.includes(specialistId) ||
          m.content.toLowerCase().includes(specialistId.replace('-', ' '))
      )

      // If no specialist-specific feedback, take top feedback by importance
      const selected = relevant.length > 0 ? relevant : feedbackMemories.slice(0, 5)

      let result = ''
      for (const mem of selected) {
        const entry = `- **${mem.title}**: ${mem.content}\n`
        if (result.length + entry.length > maxChars) break
        result += entry
      }

      return result ? `### Past Feedback\n${result}` : ''
    } catch (error) {
      log.error('Failed to get feedback for specialist:', error)
      return ''
    }
  }

  /**
   * List all memories for a workspace.
   */
  list(workspaceId: string): Memory[] {
    return memoryRepository.findByWorkspace(workspaceId)
  }

  /**
   * Search memories by query string.
   */
  search(workspaceId: string, query: string): Memory[] {
    return memoryRepository.search(workspaceId, query)
  }

  /**
   * Create a memory manually.
   */
  create(params: {
    workspaceId: string | null
    type: MemoryType
    title: string
    content: string
    tags?: string[]
    importance?: number
  }): Memory {
    return memoryRepository.create(params)
  }

  /**
   * Update a memory.
   */
  update(
    id: string,
    params: { title?: string; content?: string; tags?: string[]; importance?: number }
  ): Memory {
    return memoryRepository.update(id, params)
  }

  /**
   * Delete a memory.
   */
  delete(id: string): void {
    memoryRepository.delete(id)
  }
}

export const memoryService = new MemoryService()
