import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { costTrackerService } from '../services/cost-tracker.service'
import { agentSessionRepository, messageRepository } from '../db/repositories'
import { validateSender } from './validate-sender'
import { requireObject, requireString } from './validate-args'

export function registerInsightsIpc(): void {
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_INSIGHTS, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.CONVERSATION_INSIGHTS)
    const conversationId = requireString(args, 'conversationId', IPC_CHANNELS.CONVERSATION_INSIGHTS)

    // Token/cost summary
    const costCents = costTrackerService.getConversationCostCents(conversationId)
    const tokenSummary = agentSessionRepository.getConversationTokenSummary(conversationId)

    // Message counts — exclude hidden (auto-sent) messages so counts match visible chat bubbles
    const allMessages = messageRepository.findByConversation(conversationId)
    const messages = allMessages.filter((m) => !m.hidden)
    const userMessages = messages.filter((m) => m.role === 'user').length
    const assistantMessages = messages.filter((m) => m.role !== 'user').length

    // Duration (first visible message → last visible message)
    const firstMsg = messages[0]
    const lastMsg = messages[messages.length - 1]
    const durationMs =
      firstMsg && lastMsg
        ? new Date(lastMsg.createdAt).getTime() - new Date(firstMsg.createdAt).getTime()
        : 0

    return {
      messageCount: { user: userMessages, assistant: assistantMessages },
      tokenSummary: {
        inputTokens: tokenSummary.totalInputTokens,
        outputTokens: tokenSummary.totalOutputTokens
      },
      costCents,
      durationMs
    }
  })
}
