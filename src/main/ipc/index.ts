import type { BrowserWindow } from 'electron'
import { registerWorkspaceIpc } from './workspace.ipc'
import { registerChatIpc } from './chat.ipc'
import { registerAgentIpc } from './agent.ipc'
import { registerOrchestratorIpc } from './orchestrator.ipc'
import { registerSpecialistIpc } from './specialist.ipc'
import { registerSkillIpc } from './skill.ipc'
import { registerWorkspaceDeployIpc } from './workspace-deploy.ipc'
import { registerSyncIpc } from './sync.ipc'
import { registerWorktreeIpc } from './worktree.ipc'
import { registerPixelOfficeHandlers } from './pixel-office.ipc'
import { registerBrainIpc } from './brain.ipc'
import { registerTokenIpc } from './token.ipc'
import { registerIdeaIpc } from './idea.ipc'
import { registerUpdateIpc } from './update.ipc'

export function registerAllIpcHandlers(mainWindow: BrowserWindow): void {
  registerWorkspaceIpc()
  registerChatIpc(mainWindow)
  registerAgentIpc(mainWindow)
  registerOrchestratorIpc(mainWindow)
  registerSpecialistIpc()
  registerSkillIpc()
  registerWorkspaceDeployIpc()
  registerSyncIpc()
  registerWorktreeIpc()
  registerPixelOfficeHandlers()
  registerBrainIpc(mainWindow)
  registerTokenIpc()
  registerIdeaIpc()
  registerUpdateIpc()
}
