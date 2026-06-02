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
import { requireObject, requireString, optionalString } from './validate-args'

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
  ipcMain.handle(IPC_CHANNELS.IDEA_LIST, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.IDEA_LIST)
    const workspaceId = requireString(args, 'workspaceId', IPC_CHANNELS.IDEA_LIST)
    return ideaRepository.findByWorkspace(workspaceId)
  })

  // idea:create — create a new idea
  ipcMain.handle(IPC_CHANNELS.IDEA_CREATE, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.IDEA_CREATE)
    const workspaceId = requireString(args, 'workspaceId', IPC_CHANNELS.IDEA_CREATE)
    const title = requireString(args, 'title', IPC_CHANNELS.IDEA_CREATE)
    const description = optionalString(args, 'description', IPC_CHANNELS.IDEA_CREATE) ?? ''
    const idea = ideaRepository.create(workspaceId, title.trim(), description.trim())
    return idea
  })

  // idea:update — update title/description
  ipcMain.handle(IPC_CHANNELS.IDEA_UPDATE, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.IDEA_UPDATE)
    const id = requireString(args, 'id', IPC_CHANNELS.IDEA_UPDATE)
    const title = optionalString(args, 'title', IPC_CHANNELS.IDEA_UPDATE)
    const description = optionalString(args, 'description', IPC_CHANNELS.IDEA_UPDATE)
    const updated = ideaRepository.update(id, { title, description })
    return updated
  })

  // idea:delete — delete an idea
  ipcMain.handle(IPC_CHANNELS.IDEA_DELETE, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.IDEA_DELETE)
    const id = requireString(args, 'id', IPC_CHANNELS.IDEA_DELETE)
    const idea = ideaRepository.findById(id)
    ideaRepository.delete(id)
    if (idea) removeIdeaMemory(idea)
  })

  // idea:startGrill — create/resume a grill conversation for this idea
  ipcMain.handle(IPC_CHANNELS.IDEA_START_GRILL, (event, rawArgs: unknown) => {
    validateSender(event)
    const startGrillArgs = requireObject(rawArgs, IPC_CHANNELS.IDEA_START_GRILL)
    const ideaId = requireString(startGrillArgs, 'ideaId', IPC_CHANNELS.IDEA_START_GRILL)
    const workspaceId = requireString(startGrillArgs, 'workspaceId', IPC_CHANNELS.IDEA_START_GRILL)

    const idea = ideaRepository.findById(ideaId)
    if (!idea) throw new Error('Idea not found')

    // If already has a grill conversation, return it (resume)
    if (idea.grillConversationId) {
      const conv = conversationRepository.findById(idea.grillConversationId)
      if (conv) return { idea, conversation: conv }
    }

    // Read workspace LLM provider for conversation creation
    const wsSettings = workspaceRepository.getSettings(workspaceId)
    const llmProvider: LLMProvider = wsSettings.llmProvider ?? 'claude'

    // Create a new conversation for the grill session
    const conv = conversationRepository.create(
      workspaceId,
      `💡 Grill: ${idea.title}`,
      'plan',
      undefined,
      llmProvider
    )

    // Link it to the idea and update status
    ideaRepository.setGrillConversation(ideaId, conv.id)
    const updated = ideaRepository.updateStatus(ideaId, 'grilling')

    return { idea: updated, conversation: conv }
  })

  // idea:convertDirect — create a work item conversation from idea
  ipcMain.handle(IPC_CHANNELS.IDEA_CONVERT_DIRECT, (event, rawArgs: unknown) => {
    validateSender(event)
    const convertArgs = requireObject(rawArgs, IPC_CHANNELS.IDEA_CONVERT_DIRECT)
    const ideaId = requireString(convertArgs, 'ideaId', IPC_CHANNELS.IDEA_CONVERT_DIRECT)
    const workspaceId = requireString(convertArgs, 'workspaceId', IPC_CHANNELS.IDEA_CONVERT_DIRECT)

    const idea = ideaRepository.findById(ideaId)
    if (!idea) throw new Error('Idea not found')

    // Read workspace LLM provider for conversation creation
    const wsSettingsDirect = workspaceRepository.getSettings(workspaceId)
    const llmProviderDirect: LLMProvider = wsSettingsDirect.llmProvider ?? 'claude'

    // Create conversation with idea title
    const conv = conversationRepository.create(
      workspaceId,
      idea.title,
      'plan',
      undefined,
      llmProviderDirect
    )

    // Mark idea as completed
    ideaRepository.setConvertedConversation(ideaId, conv.id)
    const updated = ideaRepository.updateStatus(ideaId, 'completed')

    if (updated) syncIdeaToMemory(updated)
    return { idea: updated, conversation: conv }
  })

  // idea:saveGrillDecisions — save grill iteration state (score, description, history) as JSON
  ipcMain.handle(IPC_CHANNELS.IDEA_SAVE_GRILL_DECISIONS, (event, rawArgs: unknown) => {
    validateSender(event)
    const grillArgs = requireObject(rawArgs, IPC_CHANNELS.IDEA_SAVE_GRILL_DECISIONS)
    const ideaId = requireString(grillArgs, 'ideaId', IPC_CHANNELS.IDEA_SAVE_GRILL_DECISIONS)
    const decisions = requireString(grillArgs, 'decisions', IPC_CHANNELS.IDEA_SAVE_GRILL_DECISIONS)
    return ideaRepository.saveGrillDecisions(ideaId, decisions)
  })

  // idea:completeFromGrill — find the idea linked to a grill conversation and mark completed
  ipcMain.handle(IPC_CHANNELS.IDEA_COMPLETE_FROM_GRILL, (event, rawArgs: unknown) => {
    validateSender(event)
    const completeArgs = requireObject(rawArgs, IPC_CHANNELS.IDEA_COMPLETE_FROM_GRILL)
    const conversationId = requireString(
      completeArgs,
      'conversationId',
      IPC_CHANNELS.IDEA_COMPLETE_FROM_GRILL
    )
    const summary = optionalString(completeArgs, 'summary', IPC_CHANNELS.IDEA_COMPLETE_FROM_GRILL)

    const idea = ideaRepository.findByGrillConversation(conversationId)
    if (!idea) return null

    if (summary) {
      ideaRepository.setGrillSummary(idea.id, summary)
    }
    const updated = ideaRepository.updateStatus(idea.id, 'completed')
    if (updated) {
      // Re-fetch to get the full data including grillSummary set above
      const refreshed = ideaRepository.findById(updated.id)
      if (refreshed) syncIdeaToMemory(refreshed)
    }
    return updated
  })
}
