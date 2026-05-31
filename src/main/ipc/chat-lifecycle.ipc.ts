import type { BrowserWindow } from 'electron'
import { registerConversationCrudIpc } from './conversation-crud.ipc'
import { registerChatModeIpc } from './chat-mode.ipc'
import { registerChatCompletionIpc } from './chat-completion.ipc'

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Main entry point — orchestrates all chat lifecycle IPC registrations
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function registerChatLifecycleIpc(_mainWindow: BrowserWindow): void {
  registerConversationCrudIpc()
  registerChatModeIpc()
  registerChatCompletionIpc()
}
