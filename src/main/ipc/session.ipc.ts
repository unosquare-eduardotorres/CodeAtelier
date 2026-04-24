import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { validateSender } from './validate-sender'
import {
  requireObject,
  requireString,
  optionalString,
  optionalNumber,
  optionalBoolean,
  optionalNullableString
} from './validate-args'

/**
 * Session Management IPC handlers — bridges renderer requests to SDK
 * top-level session functions (listSessions, getSessionInfo, etc.).
 *
 * These do NOT require an active Query — they operate on persisted sessions.
 *
 * Every handler runs `validateSender` first, then performs field-level runtime
 * validation on its args. TypeScript at the call site gives compile-time
 * guarantees, but the main process still treats IPC as untrusted input — a
 * malformed renderer message should fail fast with a clear error message, not
 * forward garbage into the SDK.
 */
export function registerSessionIpc(): void {
  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async (event, args?: unknown) => {
    validateSender(event)
    const channel = IPC_CHANNELS.SESSION_LIST
    // args is optional for SESSION_LIST — listSessions has its own defaults.
    let parsed: { dir?: string; limit?: number; offset?: number } | undefined
    if (args !== undefined) {
      const obj = requireObject(args, channel)
      parsed = {
        dir: optionalString(obj, 'dir', channel),
        limit: optionalNumber(obj, 'limit', channel),
        offset: optionalNumber(obj, 'offset', channel)
      }
    }
    const { listSessions } = await import('@anthropic-ai/claude-agent-sdk')
    return listSessions(parsed)
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_GET_INFO, async (event, args: unknown) => {
    validateSender(event)
    const channel = IPC_CHANNELS.SESSION_GET_INFO
    const obj = requireObject(args, channel)
    const sessionId = requireString(obj, 'sessionId', channel)
    const dir = optionalString(obj, 'dir', channel)
    const { getSessionInfo } = await import('@anthropic-ai/claude-agent-sdk')
    return getSessionInfo(sessionId, { dir })
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_GET_MESSAGES, async (event, args: unknown) => {
    validateSender(event)
    const channel = IPC_CHANNELS.SESSION_GET_MESSAGES
    const obj = requireObject(args, channel)
    const sessionId = requireString(obj, 'sessionId', channel)
    const dir = optionalString(obj, 'dir', channel)
    const includeSystemMessages = optionalBoolean(obj, 'includeSystemMessages', channel)
    const { getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk')
    return getSessionMessages(sessionId, { dir, includeSystemMessages })
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_RENAME, async (event, args: unknown) => {
    validateSender(event)
    const channel = IPC_CHANNELS.SESSION_RENAME
    const obj = requireObject(args, channel)
    const sessionId = requireString(obj, 'sessionId', channel)
    const title = requireString(obj, 'title', channel)
    const dir = optionalString(obj, 'dir', channel)
    const { renameSession } = await import('@anthropic-ai/claude-agent-sdk')
    return renameSession(sessionId, title, { dir })
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_TAG, async (event, args: unknown) => {
    validateSender(event)
    const channel = IPC_CHANNELS.SESSION_TAG
    const obj = requireObject(args, channel)
    const sessionId = requireString(obj, 'sessionId', channel)
    // `tag` is string | null — explicit null clears the tag. An omitted field
    // is an error because "no change" is expressed by not calling the handler.
    const tagRaw = optionalNullableString(obj, 'tag', channel)
    if (tagRaw === undefined) {
      throw new Error(`${channel}: field 'tag' is required (use null to clear)`)
    }
    const dir = optionalString(obj, 'dir', channel)
    const { tagSession } = await import('@anthropic-ai/claude-agent-sdk')
    return tagSession(sessionId, tagRaw, { dir })
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_FORK, async (event, args: unknown) => {
    validateSender(event)
    const channel = IPC_CHANNELS.SESSION_FORK
    const obj = requireObject(args, channel)
    const sessionId = requireString(obj, 'sessionId', channel)
    const upToMessageId = optionalString(obj, 'upToMessageId', channel)
    const title = optionalString(obj, 'title', channel)
    const dir = optionalString(obj, 'dir', channel)
    const { forkSession } = await import('@anthropic-ai/claude-agent-sdk')
    return forkSession(sessionId, { dir, upToMessageId, title })
  })
}
