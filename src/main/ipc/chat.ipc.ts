import type { BrowserWindow } from 'electron'
import { registerChatMessageIpc } from './chat-message.ipc'
import { registerChatPlanIpc } from './chat-plan.ipc'
import { registerChatLifecycleIpc } from './chat-lifecycle.ipc'
import { initGeneralistStream } from '../services/generalist-stream.service'
import { taskPipeline } from '../services/task-pipeline.service'
import { specialistPoolService } from '../services/specialist-pool.service'

/**
 * Registers all chat-related IPC handlers.
 * Split into domain modules for maintainability:
 * - chat-message: Message sending, validation, delegates to GeneralistStreamService
 * - chat-plan: Task plan execution, specialist pool coordination, PR generation
 * - chat-lifecycle: CRUD (conversations, rename, delete, close, complete, file changes)
 */
export function registerChatIpc(mainWindow: BrowserWindow): void {
  // Initialize stream service with pipeline callbacks
  initGeneralistStream(mainWindow, {
    onHandoff: (conversationId, brief) =>
      taskPipeline.prepare({ type: 'handoff', conversationId, brief }),
    onStopPipeline: () => specialistPoolService.stopAll()
  })

  registerChatMessageIpc(mainWindow)
  registerChatPlanIpc(mainWindow)
  registerChatLifecycleIpc(mainWindow)
}
