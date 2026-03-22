import type { BrowserWindow } from 'electron'
import { registerWorkspaceIpc } from './workspace.ipc'
import { registerChatIpc } from './chat.ipc'
import { registerAgentIpc } from './agent.ipc'
import { registerOrchestratorIpc } from './orchestrator.ipc'
import { registerSpecialistIpc } from './specialist.ipc'
import { registerSkillIpc } from './skill.ipc'
import { registerWorkspaceDeployIpc } from './workspace-deploy.ipc'
import { registerSyncIpc } from './sync.ipc'

export function registerAllIpcHandlers(mainWindow: BrowserWindow): void {
  registerWorkspaceIpc()
  registerChatIpc(mainWindow)
  registerAgentIpc(mainWindow)
  registerOrchestratorIpc()
  registerSpecialistIpc()
  registerSkillIpc()
  registerWorkspaceDeployIpc()
  registerSyncIpc()
}
