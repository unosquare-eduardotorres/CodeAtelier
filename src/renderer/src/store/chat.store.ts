import { create } from 'zustand'
import type {
  CompleteResult,
  Conversation,
  ConversationMode,
  ExecutionStrategy,
  GrillProposedTask,
  Message,
  TaskExecutionProgress,
  TaskPlan,
  ToolActivity
} from '../../../shared/types'

interface HandoffState {
  summary: string
  specialists: string[]
  mode: ConversationMode
}

interface GrillSessionState {
  active: boolean
  summary: string | null
  proposedTasks: GrillProposedTask[]
}

interface ChatState {
  conversations: Conversation[]
  activeConversation: Conversation | null
  messages: Message[]
  streamingContent: string
  streamingRole: 'generalist' | 'coordinator'
  isStreaming: boolean
  activeHandoff: HandoffState | null
  toolActivities: ToolActivity[]

  // Task plan state
  activeTaskPlan: TaskPlan | null
  taskProgress: Map<string, TaskExecutionProgress>
  isExecutingPlan: boolean

  // Compact suggestion state
  compactSuggestion: { level: string; inputTokens: number } | null

  // Grill session state
  grillSession: GrillSessionState | null

  loadConversations: (workspaceId: string) => Promise<void>
  createConversation: (workspaceId: string, mode?: ConversationMode) => Promise<void>
  selectConversation: (id: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  updateMode: (mode: ConversationMode) => Promise<void>
  renameConversation: (id: string, title: string) => Promise<void>
  stopGeneration: () => Promise<void>
  sendMessage: (text: string, attachments?: string[]) => Promise<void>
  appendStreamChunk: (chunk: string, role?: 'generalist' | 'coordinator') => void
  finalizeStream: (messageId: string) => void
  addToolActivity: (activity: ToolActivity) => void
  updateToolActivity: (activity: Partial<ToolActivity> & { toolName: string }) => void
  setHandoff: (handoff: HandoffState) => void
  clearHandoff: () => void

  // Slash command actions
  clearDisplay: () => void
  appendLocalMessage: (content: string) => void

  // Compact suggestion
  setCompactSuggestion: (data: { level: string; inputTokens: number } | null) => void

  // Task plan actions
  setTaskPlan: (plan: TaskPlan) => void
  updateTaskProgress: (progress: TaskExecutionProgress) => void
  executePlan: (strategy: ExecutionStrategy) => Promise<void>
  clearTaskPlan: () => void

  // Grill session actions
  startGrillSession: () => void
  endGrillSession: (summary: string, proposedTasks: GrillProposedTask[]) => void
  clearGrillSession: () => void
  createItemsFromGrill: (
    tasks: Array<{ title: string; context: string; description: string }>
  ) => Promise<void>

  // /complete and /close actions
  completeConversation: (commitMessage: string, description: string) => Promise<CompleteResult>
  closeConversation: (id: string) => Promise<void>

  reset: () => void
}

// Preserve Zustand state across HMR (dev only)
const previousChatState = import.meta.hot?.data?.chatStoreState as Partial<ChatState> | undefined

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: previousChatState?.conversations ?? [],
  activeConversation: previousChatState?.activeConversation ?? null,
  messages: previousChatState?.messages ?? [],
  streamingContent: previousChatState?.streamingContent ?? '',
  streamingRole: previousChatState?.streamingRole ?? ('generalist' as const),
  isStreaming: previousChatState?.isStreaming ?? false,
  activeHandoff: previousChatState?.activeHandoff ?? null,
  toolActivities: previousChatState?.toolActivities ?? [],
  activeTaskPlan: previousChatState?.activeTaskPlan ?? null,
  taskProgress: previousChatState?.taskProgress ?? new Map(),
  isExecutingPlan: previousChatState?.isExecutingPlan ?? false,
  compactSuggestion: previousChatState?.compactSuggestion ?? null,
  grillSession: previousChatState?.grillSession ?? null,

  loadConversations: async (workspaceId: string) => {
    try {
      const conversations = await window.api.getConversations({ workspaceId })
      set({ conversations })
    } catch (error) {
      console.error('Failed to load conversations:', error)
    }
  },

  createConversation: async (workspaceId: string, mode?: ConversationMode) => {
    const conversation = await window.api.createConversation({ workspaceId, mode })
    set((state) => ({
      conversations: [conversation, ...state.conversations],
      activeConversation: conversation,
      messages: [],
      streamingContent: '',
      isStreaming: false
    }))
  },

  deleteConversation: async (id: string) => {
    // Delete uses the same flow as /close
    await get().closeConversation(id)
  },

  updateMode: async (mode: ConversationMode) => {
    const { activeConversation } = get()
    if (!activeConversation) return

    // Optimistic update — immediately reflect in UI
    const optimistic = { ...activeConversation, mode }
    set((state) => ({
      activeConversation: optimistic,
      conversations: state.conversations.map((c) =>
        c.id === activeConversation.id ? optimistic : c
      )
    }))

    try {
      const updated = await window.api.updateConversationMode({
        conversationId: activeConversation.id,
        mode
      })

      // Reconcile with DB response
      set((state) => ({
        activeConversation:
          state.activeConversation?.id === updated.id ? updated : state.activeConversation,
        conversations: state.conversations.map((c) => (c.id === updated.id ? updated : c))
      }))
    } catch (error) {
      console.error('Failed to update mode:', error)
      // Rollback optimistic update
      set((state) => ({
        activeConversation:
          state.activeConversation?.id === activeConversation.id
            ? activeConversation
            : state.activeConversation,
        conversations: state.conversations.map((c) =>
          c.id === activeConversation.id ? activeConversation : c
        )
      }))
    }
  },

  selectConversation: async (id: string) => {
    const conversation = get().conversations.find((c) => c.id === id)
    if (!conversation) return

    const messages = await window.api.getMessages({ conversationId: id })
    set({ activeConversation: conversation, messages, streamingContent: '', isStreaming: false })

    // Sync generalist CLI mode with the conversation's persisted mode
    try {
      await window.api.updateConversationMode({
        conversationId: conversation.id,
        mode: conversation.mode
      })
    } catch (error) {
      console.error('Failed to sync mode on conversation select:', error)
    }
  },

  renameConversation: async (id: string, title: string) => {
    const updated = await window.api.renameConversation({
      conversationId: id,
      title
    })
    set((state) => ({
      conversations: state.conversations.map((c) => (c.id === id ? updated : c)),
      activeConversation: state.activeConversation?.id === id ? updated : state.activeConversation
    }))
  },

  stopGeneration: async () => {
    try {
      await window.api.stopGeneration()
    } catch (error) {
      console.error('Failed to stop generation:', error)
    }
    set({ isStreaming: false, streamingContent: '', toolActivities: [] })
  },

  sendMessage: async (text: string, attachments?: string[]) => {
    const { activeConversation } = get()
    if (!activeConversation) return

    // Add optimistic user message
    const optimisticMessage: Message = {
      id: `temp-${Date.now()}`,
      conversationId: activeConversation.id,
      role: 'user',
      contentMd: text,
      attachmentsJson: attachments ? JSON.stringify(attachments) : '[]',
      createdAt: new Date().toISOString()
    }

    set((state) => ({
      messages: [...state.messages, optimisticMessage],
      isStreaming: true,
      streamingContent: ''
    }))

    try {
      await window.api.sendMessage({
        conversationId: activeConversation.id,
        text,
        attachments
      })
    } catch (error) {
      console.error('Failed to send message:', error)
      set({ isStreaming: false })
    }
  },

  appendStreamChunk: (chunk: string, role?: 'generalist' | 'coordinator') => {
    if (!chunk) return // Skip empty chunks (tool-only messages)
    set((state) => ({
      streamingContent: state.streamingContent + chunk,
      streamingRole: role ?? state.streamingRole
    }))
  },

  addToolActivity: (activity: ToolActivity) => {
    set((state) => ({
      toolActivities: [...state.toolActivities, activity]
    }))
  },

  updateToolActivity: (activity: Partial<ToolActivity> & { toolName: string }) => {
    set((state) => {
      // Find the last running activity with the matching tool name and mark it completed
      const activities = [...state.toolActivities]
      for (let i = activities.length - 1; i >= 0; i--) {
        if (activities[i].toolName === activity.toolName && activities[i].status === 'running') {
          activities[i] = { ...activities[i], ...activity, status: activity.status ?? 'completed' }
          break
        }
      }
      return { toolActivities: activities }
    })
  },

  finalizeStream: (messageId: string) => {
    const { streamingContent, streamingRole, activeConversation } = get()

    if (streamingContent && activeConversation) {
      const finalMessage: Message = {
        id: messageId,
        conversationId: activeConversation.id,
        role: streamingRole,
        contentMd: streamingContent,
        attachmentsJson: '[]',
        createdAt: new Date().toISOString()
      }

      set((state) => ({
        messages: [...state.messages, finalMessage],
        streamingContent: '',
        isStreaming: false,
        toolActivities: []
      }))
    } else if (activeConversation) {
      // No streaming content received — reload messages from DB
      // The backend saved a message (possibly an error or "No response received")
      window.api
        .getMessages({ conversationId: activeConversation.id })
        .then((messages) => {
          set({
            messages,
            streamingContent: '',
            isStreaming: false,
            toolActivities: []
          })
        })
        .catch((error) => {
          console.error('Failed to reload messages after stream finalize:', error)
          set({ streamingContent: '', isStreaming: false, toolActivities: [] })
        })
    } else {
      set({ streamingContent: '', isStreaming: false, toolActivities: [] })
    }
  },

  setHandoff: (handoff: HandoffState) => {
    set({ activeHandoff: handoff })
  },

  clearHandoff: () => {
    set({ activeHandoff: null })
  },

  setTaskPlan: (plan: TaskPlan) => {
    set({ activeTaskPlan: plan, taskProgress: new Map(), isExecutingPlan: false })
  },

  updateTaskProgress: (progress: TaskExecutionProgress) => {
    set((state) => {
      const updated = new Map(state.taskProgress)
      updated.set(progress.taskId, progress)

      // Check if all tasks are done
      const allDone = state.activeTaskPlan?.tasks.every((t) => {
        const p = updated.get(t.id)
        return p?.status === 'completed' || p?.status === 'failed'
      })

      return {
        taskProgress: updated,
        isExecutingPlan: !allDone
      }
    })
  },

  executePlan: async (strategy: ExecutionStrategy) => {
    const { activeTaskPlan } = get()
    if (!activeTaskPlan) return

    set({ isExecutingPlan: true, isStreaming: true, streamingContent: '' })

    try {
      await window.api.executePlan({
        conversationId: activeTaskPlan.conversationId,
        strategy,
        tasks: activeTaskPlan.tasks
      })
    } catch (error) {
      console.error('Failed to execute plan:', error)
      set({ isExecutingPlan: false })
    }
  },

  clearTaskPlan: () => {
    set({ activeTaskPlan: null, taskProgress: new Map(), isExecutingPlan: false })
  },

  completeConversation: async (commitMessage: string, description: string) => {
    const { activeConversation, conversations } = get()
    if (!activeConversation) throw new Error('No active conversation')

    const result = await window.api.completeConversation({
      conversationId: activeConversation.id,
      commitMessage,
      description
    })

    // Remove conversation from state (it's been deleted in DB)
    const newConversations = conversations.filter((c) => c.id !== activeConversation.id)
    set({
      conversations: newConversations,
      activeConversation: null,
      messages: [],
      streamingContent: '',
      isStreaming: false,
      toolActivities: [],
      activeTaskPlan: null,
      taskProgress: new Map(),
      isExecutingPlan: false
    })

    return result
  },

  closeConversation: async (id: string) => {
    try {
      await window.api.closeConversation({ conversationId: id })
    } catch (error) {
      console.error('Failed to close conversation on backend:', error)
      // Still remove from UI state even if backend cleanup fails
    }
    const { activeConversation, conversations } = get()
    const newConversations = conversations.filter((c) => c.id !== id)
    set({
      conversations: newConversations,
      activeConversation: activeConversation?.id === id ? null : activeConversation,
      messages: activeConversation?.id === id ? [] : get().messages
    })
  },

  startGrillSession: () => {
    set({ grillSession: { active: true, summary: null, proposedTasks: [] } })
  },

  endGrillSession: (summary: string, proposedTasks: GrillProposedTask[]) => {
    set({ grillSession: { active: false, summary, proposedTasks } })
  },

  clearGrillSession: () => {
    set({ grillSession: null })
  },

  createItemsFromGrill: async (
    tasks: Array<{ title: string; context: string; description: string }>
  ) => {
    const { activeConversation } = get()
    if (!activeConversation) return

    const workspaceId = activeConversation.workspaceId
    for (const task of tasks) {
      try {
        const conversation = (await window.api.createConversation({
          workspaceId,
          title: task.title,
          mode: 'build'
        })) as Conversation

        // Inject context + task as the first message
        const initialMessage = `## Context\n\n${task.context}\n\n## Task\n\n${task.description}`
        await window.api.sendMessage({
          conversationId: conversation.id,
          text: initialMessage
        })

        // Add to conversations list
        set((state) => ({
          conversations: [conversation, ...state.conversations]
        }))
      } catch (error) {
        console.error(`Failed to create item conversation for "${task.title}":`, error)
      }
    }

    // Clear the grill session after creating items
    set({ grillSession: null })
  },

  setCompactSuggestion: (data) => set({ compactSuggestion: data }),

  clearDisplay: () => {
    set({ messages: [], streamingContent: '', toolActivities: [] })
  },

  appendLocalMessage: (content: string) => {
    const { activeConversation } = get()
    if (!activeConversation) return

    const localMessage: Message = {
      id: `local-${Date.now()}`,
      conversationId: activeConversation.id,
      role: 'generalist',
      contentMd: content,
      attachmentsJson: '[]',
      createdAt: new Date().toISOString()
    }

    set((state) => ({
      messages: [...state.messages, localMessage]
    }))
  },

  reset: () => {
    set({
      conversations: [],
      activeConversation: null,
      messages: [],
      streamingContent: '',
      streamingRole: 'generalist' as const,
      isStreaming: false,
      activeHandoff: null,
      toolActivities: [],
      activeTaskPlan: null,
      taskProgress: new Map(),
      isExecutingPlan: false,
      compactSuggestion: null,
      grillSession: null
    })
  }
}))

// Preserve state on HMR dispose
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    import.meta.hot!.data.chatStoreState = useChatStore.getState()
  })
}
