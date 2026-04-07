import type { BrowserWindow } from 'electron'
import { registerWorkspaceIpc } from './workspace.ipc'
import { registerChatIpc } from './chat.ipc'
import { registerAgentIpc } from './agent.ipc'
import { registerAgentLifecycleIpc } from './agent-lifecycle.ipc'
import { registerSpecialistIpc } from './specialist.ipc'
import { registerSpecialistConversationIpc } from './specialist-conversation.ipc'
import { registerSpecialistConversationHistoryIpc } from './specialist-conversation-history.ipc'
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
import { registerSubscriptionIpc } from './subscription.ipc'
import { registerConversationSpecialistIpc } from './conversation-specialist.ipc'
import { registerAppPreferenceIpc } from './app-preference.ipc'
import { registerOllamaIpc } from './ollama.ipc'
import { registerIndexingIpc } from './indexing.ipc'
import { registerCodeGraphIpc } from './code-graph.ipc'
import { registerCodeChangesIpc } from './code-changes.ipc'
import { registerSchedulingIpc } from './scheduling.ipc'
import { registerHooksIpc } from './hooks.ipc'
import { initTaskPipeline } from '../services/task-pipeline.service'

export function registerAllIpcHandlers(mainWindow: BrowserWindow): void {
  // Initialize TaskPipeline before registering handlers that depend on it
  initTaskPipeline(mainWindow)

  registerWorkspaceIpc()
  registerChatIpc(mainWindow)
  registerAgentIpc(mainWindow)
  registerAgentLifecycleIpc(mainWindow)
  registerSpecialistIpc()
  registerSpecialistConversationIpc()
  registerSpecialistConversationHistoryIpc()
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
  registerSubscriptionIpc()
  registerConversationSpecialistIpc()
  registerAppPreferenceIpc()
  registerOllamaIpc(mainWindow)
  registerIndexingIpc(mainWindow)
  registerCodeGraphIpc(mainWindow)
  registerCodeChangesIpc()
  registerSchedulingIpc()
  registerHooksIpc()
}
