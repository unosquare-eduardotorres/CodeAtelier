import { ipcMain, type BrowserWindow } from 'electron'
import { extname } from 'node:path'
import { IPC_CHANNELS } from '../../shared/constants'
import { chatStreamService } from '../services/chat-stream.service'
import { conversationStateMachine } from '../services/conversation-state-machine'
import { conversationLifecycle } from '../services/conversation-lifecycle'

import { chatIpcLogger } from '../logger'
import { validateSender } from './validate-sender'
import { requireObject, requireString } from './validate-args'

const log = chatIpcLogger

/** Maximum message text length (1MB) */
const MAX_MESSAGE_LENGTH = 1_000_000
/** Maximum number of attachments per message */
const MAX_ATTACHMENTS = 20
/** Maximum number of image attachments per message */
const MAX_IMAGE_ATTACHMENTS = 5

export function registerChatMessageIpc(_mainWindow: BrowserWindow): void {
  ipcMain.handle(IPC_CHANNELS.CHAT_SEND, async (event, rawArgs: unknown) => {
    validateSender(event)

    // ── Input validation (IPC boundary concern) ──
    const ch = IPC_CHANNELS.CHAT_SEND
    const args = requireObject(rawArgs, ch)
    const conversationId = requireString(args, 'conversationId', ch)
    const text = requireString(args, 'text', ch)
    const attachments = args.attachments as string[] | undefined

    if (text.length > MAX_MESSAGE_LENGTH) {
      throw new Error(`Message too long: ${text.length} chars (max ${MAX_MESSAGE_LENGTH})`)
    }

    if (attachments !== undefined) {
      if (!Array.isArray(attachments)) {
        throw new Error('Attachments must be an array')
      }
      if (attachments.length > MAX_ATTACHMENTS) {
        throw new Error(`Too many attachments: ${attachments.length} (max ${MAX_ATTACHMENTS})`)
      }
      for (const filePath of attachments) {
        if (typeof filePath !== 'string') {
          throw new Error('Each attachment must be a file path string')
        }
      }
      const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
      const imageCount = attachments.filter((p) =>
        imageExtensions.has(extname(p).toLowerCase())
      ).length
      if (imageCount > MAX_IMAGE_ATTACHMENTS) {
        throw new Error(`Too many image attachments: ${imageCount} (max ${MAX_IMAGE_ATTACHMENTS})`)
      }
    }

    log.info('SEND received:', {
      conversationId,
      textLen: text.length,
      attachments: attachments?.length ?? 0
    })

    // ── Delegate to stream service ──
    // stream() returns a StreamHandle. We await it to get the handle (validates inputs,
    // starts streaming), but let the `done` promise run in the background — the renderer
    // receives progress via IPC events, not via this handler's return value.
    const handle = await chatStreamService.stream(conversationId, text, attachments)

    // Fire-and-forget: let pipeline complete asynchronously.
    // Errors are surfaced to the renderer via CHAT_MESSAGE_CHUNK error events.
    handle.done.catch((err) => {
      log.warn('[CHAT_SEND] Stream pipeline error (already surfaced via IPC):', err)
    })

    // Return the backend-generated requestId so the renderer can correlate
    // streaming chunks. This is the SINGLE SOURCE OF TRUTH for requestId —
    // the renderer must NOT generate its own.
    return { requestId: handle.requestId }
  })

  // ── Compact conversation context ──
  ipcMain.handle(IPC_CHANNELS.CHAT_COMPACT, async (event, args?: { extractNuance?: boolean }) => {
    validateSender(event)
    const extractNuance = args?.extractNuance ?? false
    await chatStreamService.compact(extractNuance)
  })

  // ── Stop generation ──
  ipcMain.handle(IPC_CHANNELS.CHAT_STOP, async (event) => {
    validateSender(event)
    await chatStreamService.stop()
    // Specialist pool removed in migration 66 — nothing else to stop.
  })

  // ── Query streaming state (for conversation switch restore) ──
  ipcMain.handle(IPC_CHANNELS.CHAT_GET_STREAMING_STATE, (event) => {
    validateSender(event)
    return {
      isStreaming: conversationStateMachine.isStreaming(),
      conversationId: conversationStateMachine.activeConversationId,
      state: conversationStateMachine.currentState,
      requestId: conversationLifecycle.requestId
    }
  })
}
