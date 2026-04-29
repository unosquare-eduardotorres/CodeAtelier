import type { BrowserWindow } from 'electron'
import { registerWorkspaceIpc } from './workspace.ipc'
import { registerChatIpc } from './chat.ipc'
import { registerAgentIpc } from './agent.ipc'
import { registerAgentLifecycleIpc } from './agent-lifecycle.ipc'
import { registerSpecialistIpc } from './specialist.ipc'
import { registerSkillIpc } from './skill.ipc'
import { registerWorkspaceDeployIpc } from './workspace-deploy.ipc'
import { registerSyncIpc } from './sync.ipc'
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

import { registerShellIpc } from './shell.ipc'
import { registerCheckpointIpc } from './checkpoint.ipc'
import { registerCostIpc } from './cost.ipc'
import { registerEventsIpc } from './events.ipc'
import { registerSubscriptionIpc } from './subscription.ipc'
import { registerConversationSpecialistIpc } from './conversation-specialist.ipc'
import { registerAppPreferenceIpc } from './app-preference.ipc'
import { registerOllamaIpc } from './ollama.ipc'
import { registerIndexingIpc } from './indexing.ipc'
import { registerCodeGraphIpc } from './code-graph.ipc'
import { registerCodeChangesIpc } from './code-changes.ipc'
import { registerHooksIpc } from './hooks.ipc'
import { registerSdkControlIpc } from './sdk-control.ipc'
import { registerSessionIpc } from './session.ipc'
import { registerBugIpc } from './bug.ipc'
import { registerProjectSpecialistIpc } from './project-specialist.ipc'

export function registerAllIpcHandlers(mainWindow: BrowserWindow): void {
  registerWorkspaceIpc()
  registerChatIpc(mainWindow)
  registerAgentIpc(mainWindow)
  registerAgentLifecycleIpc(mainWindow)
  registerSpecialistIpc()
  registerSkillIpc()
  registerWorkspaceDeployIpc()
  registerSyncIpc()
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

  registerShellIpc()
  registerCheckpointIpc()
  registerCostIpc()
  registerEventsIpc()
  registerSubscriptionIpc()
  registerConversationSpecialistIpc()
  registerAppPreferenceIpc()
  registerOllamaIpc(mainWindow)
  registerIndexingIpc(mainWindow)
  registerCodeGraphIpc(mainWindow)
  registerCodeChangesIpc()
  registerHooksIpc()
  registerSdkControlIpc()
  registerSessionIpc()
  registerBugIpc(mainWindow)
  registerProjectSpecialistIpc()
}
