import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import type { Idea, LLMProvider } from '../../shared/types'
import {
  ideaRepository,
  conversationRepository,
  memoryRepository,
  workspaceRepository
} from '../db/repositories'
import { validateSender } from './validate-sender'

/**
 * Sync a completed idea into the auto memory system.
 * Creates a 'project' memory so the generalist and dream system
 * can reference refined ideas in future conversations.
 */
function syncIdeaToMemory(idea: Idea): void {
  // Only completed ideas become memories
  if (idea.status !== 'completed') return

  // Check if a memory already exists for this idea (idempotency)
  // Use a stable tag convention: idea:{id}
  const ideaTag = `idea:${idea.id}`
  const existing = memoryRepository
    .findByType(idea.workspaceId, 'project')
    .filter((m) => m.tags.includes(ideaTag))

  // Build memory content from idea + optional grill summary
  const contentParts = [idea.description]
  if (idea.grillSummary) {
    contentParts.push(`\n### Grill Summary\n${idea.grillSummary}`)
  }
  const content = contentParts.filter(Boolean).join('\n')

  if (existing.length > 0) {
    // Update existing memory (in case grillSummary was added later)
    memoryRepository.update(existing[0].id, {
      title: `Idea: ${idea.title}`,
      content,
      tags: ['idea', ideaTag]
    })
  } else {
    // Create new memory
    memoryRepository.create({
      workspaceId: idea.workspaceId,
      type: 'project',
      title: `Idea: ${idea.title}`,
      content,
      tags: ['idea', ideaTag],
      importance: idea.grillSummary ? 7 : 5 // Grilled ideas are more important
    })
  }
}

/**
 * Remove the memory linked to a deleted idea.
 */
function removeIdeaMemory(idea: Idea): void {
  const ideaTag = `idea:${idea.id}`
  const existing = memoryRepository
    .findByType(idea.workspaceId, 'project')
    .filter((m) => m.tags.includes(ideaTag))
  for (const memory of existing) {
    memoryRepository.delete(memory.id)
  }
}

export function registerIdeaIpc(): void {
  // idea:list — returns all ideas for a workspace
  ipcMain.handle(IPC_CHANNELS.IDEA_LIST, (event, args: { workspaceId: string }) => {
    validateSender(event)
    if (!args?.workspaceId) throw new Error('workspaceId is required')
    return ideaRepository.findByWorkspace(args.workspaceId)
  })

  // idea:create — create a new idea
  ipcMain.handle(
    IPC_CHANNELS.IDEA_CREATE,
    (event, args: { workspaceId: string; title: string; description: string }) => {
      validateSender(event)
      if (!args?.workspaceId) throw new Error('workspaceId is required')
      if (!args.title || typeof args.title !== 'string' || args.title.trim().length === 0) {
        throw new Error('title is required')
      }
      const idea = ideaRepository.create(
        args.workspaceId,
        args.title.trim(),
        args.description?.trim() ?? ''
      )
      return idea
    }
  )

  // idea:update — update title/description
  ipcMain.handle(
    IPC_CHANNELS.IDEA_UPDATE,
    (event, args: { id: string; title?: string; description?: string }) => {
      validateSender(event)
      if (!args?.id) throw new Error('id is required')
      const updated = ideaRepository.update(args.id, {
        title: args.title,
        description: args.description
      })
      return updated
    }
  )

  // idea:delete — delete an idea
  ipcMain.handle(IPC_CHANNELS.IDEA_DELETE, (event, args: { id: string }) => {
    validateSender(event)
    if (!args?.id) throw new Error('id is required')
    const idea = ideaRepository.findById(args.id)
    ideaRepository.delete(args.id)
    if (idea) removeIdeaMemory(idea)
  })

  // idea:startGrill — create/resume a grill conversation for this idea
  ipcMain.handle(
    IPC_CHANNELS.IDEA_START_GRILL,
    (event, args: { ideaId: string; workspaceId: string }) => {
      validateSender(event)
      if (!args?.ideaId) throw new Error('ideaId is required')
      if (!args?.workspaceId) throw new Error('workspaceId is required')

      const idea = ideaRepository.findById(args.ideaId)
      if (!idea) throw new Error('Idea not found')

      // If already has a grill conversation, return it (resume)
      if (idea.grillConversationId) {
        const conv = conversationRepository.findById(idea.grillConversationId)
        if (conv) return { idea, conversation: conv }
      }

      // Read workspace LLM provider for conversation creation
      const wsRow = workspaceRepository.findById(args.workspaceId)
      const wsSettings = JSON.parse(wsRow?.settingsJson ?? '{}')
      const llmProvider: LLMProvider = wsSettings.llmProvider ?? 'claude'

      // Create a new conversation for the grill session
      const conv = conversationRepository.create(
        args.workspaceId,
        `💡 Grill: ${idea.title}`,
        'plan',
        undefined,
        llmProvider
      )

      // Link it to the idea and update status
      ideaRepository.setGrillConversation(args.ideaId, conv.id)
      const updated = ideaRepository.updateStatus(args.ideaId, 'grilling')

      return { idea: updated, conversation: conv }
    }
  )

  // idea:convertDirect — create a work item conversation from idea
  ipcMain.handle(
    IPC_CHANNELS.IDEA_CONVERT_DIRECT,
    (event, args: { ideaId: string; workspaceId: string }) => {
      validateSender(event)
      if (!args?.ideaId) throw new Error('ideaId is required')
      if (!args?.workspaceId) throw new Error('workspaceId is required')

      const idea = ideaRepository.findById(args.ideaId)
      if (!idea) throw new Error('Idea not found')

      // Read workspace LLM provider for conversation creation
      const wsRowDirect = workspaceRepository.findById(args.workspaceId)
      const wsSettingsDirect = JSON.parse(wsRowDirect?.settingsJson ?? '{}')
      const llmProviderDirect: LLMProvider = wsSettingsDirect.llmProvider ?? 'claude'

      // Create conversation with idea title
      const conv = conversationRepository.create(
        args.workspaceId,
        idea.title,
        'plan',
        undefined,
        llmProviderDirect
      )

      // Mark idea as completed
      ideaRepository.setConvertedConversation(args.ideaId, conv.id)
      const updated = ideaRepository.updateStatus(args.ideaId, 'completed')

      if (updated) syncIdeaToMemory(updated)
      return { idea: updated, conversation: conv }
    }
  )

  // idea:saveGrillDecisions — save grill iteration state (score, description, history) as JSON
  ipcMain.handle(
    IPC_CHANNELS.IDEA_SAVE_GRILL_DECISIONS,
    (event, args: { ideaId: string; decisions: string }) => {
      validateSender(event)
      if (!args?.ideaId) throw new Error('ideaId is required')
      if (!args?.decisions) throw new Error('decisions is required')
      return ideaRepository.saveGrillDecisions(args.ideaId, args.decisions)
    }
  )

  // idea:completeFromGrill — find the idea linked to a grill conversation and mark completed
  ipcMain.handle(
    IPC_CHANNELS.IDEA_COMPLETE_FROM_GRILL,
    (event, args: { conversationId: string; summary?: string }) => {
      validateSender(event)
      if (!args?.conversationId) throw new Error('conversationId is required')

      const idea = ideaRepository.findByGrillConversation(args.conversationId)
      if (!idea) return null

      if (args.summary) {
        ideaRepository.setGrillSummary(idea.id, args.summary)
      }
      const updated = ideaRepository.updateStatus(idea.id, 'completed')
      if (updated) {
        // Re-fetch to get the full data including grillSummary set above
        const refreshed = ideaRepository.findById(updated.id)
        if (refreshed) syncIdeaToMemory(refreshed)
      }
      return updated
    }
  )
}
