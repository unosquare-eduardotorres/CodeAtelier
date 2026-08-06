/**
 * autofix-pr.ipc — IPC handler for the `/autofix-pr` command.
 *
 * Gathers CI failures + review comments for a PR, then sends a fix prompt
 * to the current conversation's agent session via chatStreamService.stream().
 */
import { ipcMain, type BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { validateSender } from './validate-sender'
import { safeWindowSend } from './safe-send'
import { autofixPrService } from '../services/autofix-pr.service'
import { conversationRepository } from '../db/repositories'
import { chatStreamService } from '../services/chat-stream.service'
import log from 'electron-log/main'

const autofixLog = log.scope('autofix-pr')

export function registerAutofixPrIpc(mainWindow: BrowserWindow): void {
  ipcMain.handle(IPC_CHANNELS.AUTOFIX_PR_START, async (event, rawArgs: unknown): Promise<void> => {
    validateSender(event)

    const args = rawArgs as { conversationId: string; prNumber?: number }
    const conversation = conversationRepository.findById(args.conversationId)
    if (!conversation) throw new Error('Conversation not found')

    try {
      // 1. Build the fix prompt (gathers CI + review context)
      const { prompt, context } = await autofixPrService.buildFixPrompt({
        workspaceId: conversation.workspaceId,
        prNumber: args.prNumber
      })

      // 2. Send progress event to renderer
      safeWindowSend(mainWindow, IPC_CHANNELS.AUTOFIX_PR_STATUS, {
        conversationId: args.conversationId,
        status: 'fixing',
        context
      })

      // 3. Send the fix prompt as a regular message to the current agent session.
      //    This reuses the existing agent (with its tools, MCP servers, code context).
      await chatStreamService.stream(args.conversationId, prompt, [], { optimizePrompt: false })
    } catch (err) {
      autofixLog.error('[autofix-pr] Failed:', err)
      throw err // Re-throw so the renderer catch block handles it
    }
  })
}
