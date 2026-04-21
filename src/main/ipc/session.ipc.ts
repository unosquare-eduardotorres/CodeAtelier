import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { validateSender } from './validate-sender'

/**
 * Session Management IPC handlers — bridges renderer requests to SDK
 * top-level session functions (listSessions, getSessionInfo, etc.).
 *
 * These do NOT require an active Query — they operate on persisted sessions.
 */
export function registerSessionIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.SESSION_LIST,
    async (event, args?: { dir?: string; limit?: number; offset?: number }) => {
      validateSender(event)
      const { listSessions } = await import('@anthropic-ai/claude-agent-sdk')
      return listSessions(args)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SESSION_GET_INFO,
    async (event, args: { sessionId: string; dir?: string }) => {
      validateSender(event)
      const { getSessionInfo } = await import('@anthropic-ai/claude-agent-sdk')
      return getSessionInfo(args.sessionId, { dir: args.dir })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SESSION_GET_MESSAGES,
    async (
      event,
      args: { sessionId: string; dir?: string; includeSystemMessages?: boolean }
    ) => {
      validateSender(event)
      const { getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk')
      return getSessionMessages(args.sessionId, {
        dir: args.dir,
        includeSystemMessages: args.includeSystemMessages
      })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SESSION_RENAME,
    async (event, args: { sessionId: string; title: string; dir?: string }) => {
      validateSender(event)
      const { renameSession } = await import('@anthropic-ai/claude-agent-sdk')
      return renameSession(args.sessionId, args.title, { dir: args.dir })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SESSION_TAG,
    async (event, args: { sessionId: string; tag: string | null; dir?: string }) => {
      validateSender(event)
      const { tagSession } = await import('@anthropic-ai/claude-agent-sdk')
      return tagSession(args.sessionId, args.tag, { dir: args.dir })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SESSION_FORK,
    async (
      event,
      args: { sessionId: string; upToMessageId?: string; title?: string; dir?: string }
    ) => {
      validateSender(event)
      const { forkSession } = await import('@anthropic-ai/claude-agent-sdk')
      return forkSession(args.sessionId, {
        dir: args.dir,
        upToMessageId: args.upToMessageId,
        title: args.title
      })
    }
  )
}
