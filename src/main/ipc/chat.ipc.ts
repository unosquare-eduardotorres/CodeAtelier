import type { BrowserWindow } from 'electron'
import { registerChatMessageIpc } from './chat-message.ipc'
import { registerChatLifecycleIpc } from './chat-lifecycle.ipc'
import { initChatStream } from '../services/chat-stream.service'
import { conversationStateMachine } from '../services/conversation-state-machine'

/**
 * Registers all chat-related IPC handlers.
 *
 * All chat traffic routes directly to the workspace's Project Specialist (or
 * Da Vinci fallback) through the normal chat-message send path — there is no
 * task-pipeline or specialist-pool.
 *
 * Split into domain modules for maintainability:
 * - chat-message: Message sending, validation, delegates to ChatStreamService
 * - chat-lifecycle: CRUD (conversations, rename, delete, close, complete, file changes)
 */
export function registerChatIpc(mainWindow: BrowserWindow): void {
  // Wire state machine → renderer IPC forwarding
  conversationStateMachine.setMainWindow(mainWindow)

  // Initialize stream service. The only lifecycle hook is onStopPipeline,
  // which is a no-op — there is no background pipeline to stop.
  initChatStream(mainWindow, {
    onStopPipeline: async () => {
      // No-op.
    }
  })

  registerChatMessageIpc(mainWindow)
  registerChatLifecycleIpc(mainWindow)
}
