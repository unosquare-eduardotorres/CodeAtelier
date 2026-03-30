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
import { registerMemoryIpc } from './memory.ipc'
import { registerDreamIpc } from './dream.ipc'
import { registerTokenIpc } from './token.ipc'
import { registerIdeaIpc } from './idea.ipc'
import { registerUpdateIpc } from './update.ipc'
import { registerDocsIpc } from './docs.ipc'
import { registerGithubIpc } from './github.ipc'
import { registerRepoIpc } from './repo.ipc'
import { registerUserProfileIpc } from './user-profile.ipc'
import { registerCoreAgentAliasIpc } from './core-agent-alias.ipc'
import { registerCoreAgentPromptIpc } from './core-agent-prompt.ipc'
import { registerLogIpc } from './log.ipc'
import { registerZoomIpc } from './zoom.ipc'
import { registerSpecialistDeployIpc } from './specialist-deploy.ipc'
import { registerShellIpc } from './shell.ipc'
import { registerCheckpointIpc } from './checkpoint.ipc'
import { registerCostIpc } from './cost.ipc'
import { registerEventsIpc } from './events.ipc'
import { registerGateIpc } from './gate.ipc'
import { registerToolApprovalIpc } from './tool-approval.ipc'

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
  registerMemoryIpc(mainWindow)
  registerDreamIpc(mainWindow)
  registerTokenIpc()
  registerIdeaIpc()
  registerUpdateIpc()
  registerDocsIpc()
  registerGithubIpc()
  registerRepoIpc()
  registerUserProfileIpc()
  registerCoreAgentAliasIpc()
  registerCoreAgentPromptIpc()
  registerLogIpc()
  registerZoomIpc(mainWindow)
  registerSpecialistDeployIpc()
  registerShellIpc()
  registerCheckpointIpc()
  registerCostIpc()
  registerEventsIpc()
  registerGateIpc()
  registerToolApprovalIpc()
}
