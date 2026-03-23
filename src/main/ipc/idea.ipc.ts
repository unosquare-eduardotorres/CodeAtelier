import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { ideaRepository, conversationRepository } from '../db/repositories'
import { validateSender } from './validate-sender'

export function registerIdeaIpc(): void {
  // idea:list — returns all ideas for a workspace
  ipcMain.handle(
    IPC_CHANNELS.IDEA_LIST,
    (event, args: { workspaceId: string }) => {
      validateSender(event)
      if (!args?.workspaceId) throw new Error('workspaceId is required')
      return ideaRepository.findByWorkspace(args.workspaceId)
    }
  )

  // idea:create — create a new idea
  ipcMain.handle(
    IPC_CHANNELS.IDEA_CREATE,
    (event, args: { workspaceId: string; title: string; description: string }) => {
      validateSender(event)
      if (!args?.workspaceId) throw new Error('workspaceId is required')
      if (!args.title || typeof args.title !== 'string' || args.title.trim().length === 0) {
        throw new Error('title is required')
      }
      return ideaRepository.create(args.workspaceId, args.title.trim(), args.description?.trim() ?? '')
    }
  )

  // idea:update — update title/description
  ipcMain.handle(
    IPC_CHANNELS.IDEA_UPDATE,
    (event, args: { id: string; title?: string; description?: string }) => {
      validateSender(event)
      if (!args?.id) throw new Error('id is required')
      return ideaRepository.update(args.id, {
        title: args.title,
        description: args.description
      })
    }
  )

  // idea:delete — delete an idea
  ipcMain.handle(IPC_CHANNELS.IDEA_DELETE, (event, args: { id: string }) => {
    validateSender(event)
    if (!args?.id) throw new Error('id is required')
    ideaRepository.delete(args.id)
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

      // Create a new conversation for the grill session
      const conv = conversationRepository.create(
        args.workspaceId,
        `💡 Grill: ${idea.title}`,
        'plan'
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

      // Create conversation with idea title
      const conv = conversationRepository.create(args.workspaceId, idea.title, 'plan')

      // Mark idea as completed
      ideaRepository.setConvertedConversation(args.ideaId, conv.id)
      const updated = ideaRepository.updateStatus(args.ideaId, 'completed')

      return { idea: updated, conversation: conv }
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
      return updated
    }
  )
}
