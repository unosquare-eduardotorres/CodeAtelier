import { create } from 'zustand'
import type { Conversation, ConversationMode, Message, ToolActivity } from '../../../shared/types'

interface HandoffState {
  summary: string
  specialists: string[]
  mode: ConversationMode
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
  reset: () => void
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeConversation: null,
  messages: [],
  streamingContent: '',
  streamingRole: 'generalist' as const,
  isStreaming: false,
  activeHandoff: null,
  toolActivities: [],

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
    await window.api.deleteConversation({ conversationId: id });
    const { activeConversation, conversations } = get();
    const newConversations = conversations.filter((c) => c.id !== id);

    set({
      conversations: newConversations,
      activeConversation: activeConversation?.id === id ? null : activeConversation,
      messages: activeConversation?.id === id ? [] : get().messages
    });
  },

  updateMode: async (mode: ConversationMode) => {
    const { activeConversation } = get()
    if (!activeConversation) return

    const updated = await window.api.updateConversationMode({
      conversationId: activeConversation.id,
      mode
    }) as Conversation

    set((state) => ({
      activeConversation: updated,
      conversations: state.conversations.map((c) =>
        c.id === updated.id ? updated : c
      )
    }))
  },

  selectConversation: async (id: string) => {
    const conversation = get().conversations.find((c) => c.id === id)
    if (!conversation) return

    const messages = await window.api.getMessages({ conversationId: id })
    set({ activeConversation: conversation, messages, streamingContent: '', isStreaming: false })
  },

  renameConversation: async (id: string, title: string) => {
    const updated = (await window.api.renameConversation({
      conversationId: id,
      title
    })) as Conversation
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
      window.api.getMessages({ conversationId: activeConversation.id }).then((messages) => {
        set({ messages: messages as Message[], streamingContent: '', isStreaming: false, toolActivities: [] })
      }).catch(() => {
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

  reset: () => {
    set({
      conversations: [],
      activeConversation: null,
      messages: [],
      streamingContent: '',
      streamingRole: 'generalist' as const,
      isStreaming: false,
      activeHandoff: null,
      toolActivities: []
    })
  }
}))
