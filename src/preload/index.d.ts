import type {
  Workspace,
  Conversation,
  ConversationMode,
  Message,
  AgentStatus,
  Specialist,
  Skill,
  CreateSpecialistInput,
  UpdateSpecialistInput,
  WorkspaceClaudeStatus,
  ActivationResult,
  ActivationProgressEvent,
  DiscoveredSkill,
  DiscoveredAgent,
  SyncDiff,
  SyncResult
} from '../shared/types'

interface Api {
  // Workspace
  listWorkspaces: () => Promise<Workspace[]>
  createWorkspace: (args: { name: string; repoPath: string }) => Promise<Workspace>
  openWorkspace: (args: { id: string }) => Promise<Workspace>
  deleteWorkspace: (args: { id: string }) => Promise<void>
  selectDirectory: () => Promise<string | null>
  saveClipboardImage: (args: { dataUrl: string }) => Promise<string>

  // Chat
  sendMessage: (args: {
    conversationId: string
    text: string
    attachments?: string[]
  }) => Promise<void>
  getConversations: (args: { workspaceId: string }) => Promise<Conversation[]>
  createConversation: (args: { workspaceId: string; title?: string; mode?: ConversationMode }) => Promise<Conversation>
  getMessages: (args: { conversationId: string }) => Promise<Message[]>
  deleteConversation: (args: { conversationId: string }) => Promise<void>
  updateConversationMode: (args: { conversationId: string; mode: ConversationMode }) => Promise<Conversation>
  renameConversation: (args: { conversationId: string; title: string }) => Promise<Conversation>
  stopGeneration: () => Promise<void>

  // Agents
  getAgentStatuses: () => Promise<AgentStatus[]>
  stopAllAgents: () => Promise<string[]>

  // Orchestrator
  startOrchestrator: (workspacePath: string) => Promise<void>

  // Specialists
  listSpecialists: () => Promise<Specialist[]>
  getSpecialist: (args: { id: string }) => Promise<Specialist>
  createSpecialist: (args: CreateSpecialistInput) => Promise<Specialist>
  updateSpecialist: (args: { id: string } & UpdateSpecialistInput) => Promise<Specialist>
  deleteSpecialist: (args: { id: string }) => Promise<void>
  assignSkillToSpecialist: (args: { specialistId: string; skillId: string }) => Promise<void>
  removeSkillFromSpecialist: (args: { specialistId: string; skillId: string }) => Promise<void>

  // Skills
  listSkills: () => Promise<Skill[]>
  importSkill: (args: { filePath: string }) => Promise<Skill>
  updateSkill: (args: { id: string; name?: string; description?: string }) => Promise<Skill>
  deleteSkill: (args: { id: string }) => Promise<void>
  activateSkill: (args: { id: string }) => Promise<Skill>
  deactivateSkill: (args: { id: string }) => Promise<Skill>
  selectSkillFile: () => Promise<string | null>

  // Workspace Deploy
  scanWorkspaceClaude: (args: { workspacePath: string }) => Promise<WorkspaceClaudeStatus>
  activateAgents: (args: { workspacePath: string }) => Promise<ActivationResult>
  readWorkspaceFile: (args: { filePath: string }) => Promise<string>
  writeWorkspaceFile: (args: { filePath: string; content: string }) => Promise<void>
  scanWorkspaceSkills: (args: { workspacePath: string }) => Promise<DiscoveredSkill[]>
  scanWorkspaceAgents: (args: { workspacePath: string }) => Promise<DiscoveredAgent[]>
  confirmClaudeMd: (args: { workspacePath: string; content: string }) => Promise<void>
  cancelActivation: () => Promise<void>

  // Agent Sync
  computeSyncDiff: (args: { workspacePath: string }) => Promise<SyncDiff>
  applySync: (args: { workspacePath: string; skipRemoved?: boolean }) => Promise<SyncResult>

  // Events (main → renderer) with cleanup
  onActivationProgress: (
    callback: (data: ActivationProgressEvent) => void
  ) => () => void
  onMessageChunk: (
    callback: (data: {
      conversationId: string
      chunk: string
      role: string
      toolActivity?: {
        id: string
        toolName: string
        status: 'running' | 'completed' | 'error'
        startedAt?: number
        completedAt?: number
      }
    }) => void
  ) => () => void
  onMessageComplete: (
    callback: (data: { conversationId: string; messageId: string }) => void
  ) => () => void
  onHandoff: (
    callback: (data: {
      conversationId: string
      summary: string
      specialists: string[]
      mode: string
    }) => void
  ) => () => void
  onOrchestratorReady: (callback: () => void) => () => void
  onAgentStatusUpdate: (
    callback: (data: {
      agentId: string
      agentType: string
      status: string
      elapsedMs: number
      tokenUsage: number
    }) => void
  ) => () => void
}

declare global {
  interface Window {
    api: Api
  }
}
