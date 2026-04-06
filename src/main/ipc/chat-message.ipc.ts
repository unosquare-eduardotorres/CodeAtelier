import { ipcMain, type BrowserWindow } from 'electron'
import { extname } from 'node:path'
import { IPC_CHANNELS } from '../../shared/constants'
import { generalistStreamService } from '../services/generalist-stream.service'
import { chatIpcLogger } from '../logger'
import { validateSender } from './validate-sender'

const log = chatIpcLogger

/** Maximum message text length (1MB) */
const MAX_MESSAGE_LENGTH = 1_000_000
/** Maximum number of attachments per message */
const MAX_ATTACHMENTS = 20
/** Maximum number of image attachments per message */
const MAX_IMAGE_ATTACHMENTS = 5

export function registerChatMessageIpc(_mainWindow: BrowserWindow): void {
  ipcMain.handle(
    IPC_CHANNELS.CHAT_SEND,
    async (event, args: { conversationId: string; text: string; attachments?: string[] }) => {
      validateSender(event)

      // ── Input validation (IPC boundary concern) ──
      if (!args || typeof args !== 'object') {
        throw new Error('Invalid arguments')
      }

      const { conversationId, text, attachments } = args

      if (typeof conversationId !== 'string' || conversationId.trim().length === 0) {
        throw new Error('Invalid conversation ID')
      }

      if (typeof text !== 'string' || text.trim().length === 0) {
        throw new Error('Message text cannot be empty')
      }

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
          throw new Error(
            `Too many image attachments: ${imageCount} (max ${MAX_IMAGE_ATTACHMENTS})`
          )
        }
      }

      log.info('SEND received:', {
        conversationId,
        textLen: text.length,
        attachments: attachments?.length ?? 0
      })

      // ── Delegate to stream service ──
      await generalistStreamService.stream(conversationId, text, attachments)
    }
  )

  // ── Compact conversation context ──
  ipcMain.handle(IPC_CHANNELS.CHAT_COMPACT, async (event) => {
    validateSender(event)
    await generalistStreamService.compact()
  })

  // ── Stop generation ──
  ipcMain.handle(IPC_CHANNELS.CHAT_STOP, async (event) => {
    validateSender(event)
    await generalistStreamService.stop()
  })
}
