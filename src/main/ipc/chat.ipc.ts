import type { BrowserWindow } from 'electron'
import { registerChatMessageIpc } from './chat-message.ipc'
import { registerChatLifecycleIpc } from './chat-lifecycle.ipc'
import { initChatStream } from '../services/chat-stream.service'
import { conversationStateMachine } from '../services/conversation-state-machine'

/**
 * Registers all chat-related IPC handlers.
 *
 * Post-migration 66: no more task-pipeline / specialist-pool. Handoffs and
 * plan executions route directly to the workspace's Project Specialist (or
 * Da Vinci fallback) through the normal chat-message send path.
 *
 * Split into domain modules for maintainability:
 * - chat-message: Message sending, validation, delegates to ChatStreamService
 * - chat-lifecycle: CRUD (conversations, rename, delete, close, complete, file changes)
 */
export function registerChatIpc(mainWindow: BrowserWindow): void {
  // Wire state machine → renderer IPC forwarding
  conversationStateMachine.setMainWindow(mainWindow)

  // Initialize stream service. Post-handoff-removal the only lifecycle hook
  // is onStopPipeline (no-op — no background pipeline to stop).
  initChatStream(mainWindow, {
    onStopPipeline: async () => {
      // No-op.
    }
  })

  registerChatMessageIpc(mainWindow)
  registerChatLifecycleIpc(mainWindow)
}
