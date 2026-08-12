/**
 * btw.ipc — IPC handler for the `/btw` ephemeral side question feature.
 *
 * Runs a one-shot Claude CLI call with conversation context injected as prompt.
 * The question + answer never enter conversation history — truly ephemeral.
 */
import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { validateSender } from './validate-sender'
import { runOneShotClaude } from '../services/one-shot-claude'
import { conversationRepository, messageRepository, workspaceRepository } from '../db/repositories'
import log from 'electron-log/main'

const btwLog = log.scope('btw')

export function registerBtwIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.CHAT_BTW,
    async (event, rawArgs: unknown): Promise<{ answer: string }> => {
      validateSender(event)

      const args = rawArgs as { conversationId: string; question: string }
      const { conversationId, question } = args

      // 1. Load conversation context
      const conversation = conversationRepository.findById(conversationId)
      if (!conversation) throw new Error('Conversation not found')

      const workspace = workspaceRepository.findById(conversation.workspaceId)
      const repoPath = workspace?.repoPath

      // 2. Build context from recent messages (last 20 turns)
      const messages = messageRepository.findRecentByConversation(conversationId, 20)
      const contextText = messages
        .map((m) => `[${m.role}]: ${m.contentMd?.slice(0, 2000) ?? ''}`)
        .join('\n\n')

      // 3. Build the BTW prompt — include conversation context
      const systemPrompt = [
        'You are answering a quick side question. The user is in the middle of a coding session.',
        'Answer concisely from the conversation context provided below.',
        'Do NOT suggest running commands, reading files, or taking actions — just answer from what you know.',
        '',
        '--- CONVERSATION CONTEXT ---',
        contextText,
        '--- END CONTEXT ---'
      ].join('\n')

      // 4. Run ephemeral one-shot query
      const cliArgs = ['-p', `${systemPrompt}\n\nSide question: ${question}`]
      if (repoPath) {
        cliArgs.unshift('--code', repoPath)
      }

      try {
        const { text } = await runOneShotClaude({
          feature: 'btw',
          workspaceId: conversation.workspaceId,
          // No conversationId — truly ephemeral, doesn't pollute per-conversation usage
          args: cliArgs
        })

        return { answer: text }
      } catch (err) {
        btwLog.error('[btw] Failed:', err)
        return { answer: `Failed to answer: ${err instanceof Error ? err.message : String(err)}` }
      }
    }
  )
}
