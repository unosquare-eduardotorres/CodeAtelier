import type { BrowserWindow } from 'electron'
import { registerChatMessageIpc } from './chat-message.ipc'
import { registerChatPlanIpc } from './chat-plan.ipc'
import { registerChatLifecycleIpc } from './chat-lifecycle.ipc'

/**
 * Registers all chat-related IPC handlers.
 * Split into domain modules for maintainability:
 * - chat-message: Message sending, streaming, generalist communication
 * - chat-plan: Task plan execution, specialist pool coordination, PR generation
 * - chat-lifecycle: CRUD (conversations, rename, delete, close, complete, file changes)
 */
export function registerChatIpc(mainWindow: BrowserWindow): void {
  registerChatMessageIpc(mainWindow)
  registerChatPlanIpc(mainWindow)
  registerChatLifecycleIpc(mainWindow)
}
