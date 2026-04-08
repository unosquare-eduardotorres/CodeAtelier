import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { rendererLog } from '@renderer/utils/logger'
import type {
  CompleteResult,
  ContextUsage,
  Conversation,
  ConversationMode,
  ExecutionStrategy,
  GrillAnswerPayload,
  GrillProposedTask,
  GrillQuestion,
  InvestigationReport,
  Message,
  DecomposedTask,
  TaskExecutionProgress,
  ToolActivity
} from '../../../shared/types'

/** Safety timer — force-resets isStreaming if stuck for 2 minutes (e.g., process dies without emitting complete) */
let streamingSafetyTimer: ReturnType<typeof setTimeout> | null = null

/** Lazy-bound references — set once inside the Zustand create() closure */
let _storeGet: (() => ChatState) | null = null
let _storeSet: ((partial: Partial<ChatState>) => void) | null = null

/**
 * Resets the streaming safety timer — call on any sign of backend activity
 * (text chunks, tool starts, tool completions). This prevents the timer from
 * killing active-but-slow streams (e.g., agent running multiple Bash tools).
 */
function resetStreamingSafetyTimer(): void {
  if (streamingSafetyTimer) clearTimeout(streamingSafetyTimer)
  streamingSafetyTimer = setTimeout(
    () => {
      if (_storeGet?.().isStreaming) {
        rendererLog.warn('Safety timeout: isStreaming stuck for 2 minutes — force-resetting')
        _storeSet?.({ isStreaming: false, streamingContent: '', toolActivities: [] })
      }
      streamingSafetyTimer = null
    },
    2 * 60 * 1000
  )
}

interface HandoffState {
  summary: string
  specialists: string[]
  mode: ConversationMode
}

interface GrillSessionState {
  active: boolean
  summary: string | null
  proposedTasks: GrillProposedTask[]
  pendingQuestions: GrillQuestion[]
  answers: Record<string, GrillAnswerPayload>
}

interface ChatState {
  conversations: Conversation[]
  activeConversation: Conversation | null
  messages: Message[]
  streamingContent: string
  streamingRole: 'generalist' | 'coordinator' | 'specialist'
  streamingSpecialist: string | null
  streamingTaskId: string | null
  isStreaming: boolean
  activeHandoff: HandoffState | null
  toolActivities: ToolActivity[]

  // Task plan state
  taskProgress: Map<string, TaskExecutionProgress>
  isExecutingPlan: boolean
  decomposedTasks: DecomposedTask[]

  // Compact suggestion state
  compactSuggestion: { level: string; inputTokens: number } | null

  // Grill session state
  grillSession: GrillSessionState | null

  // General chat pending questions (ask_user tool)
  pendingQuestions: GrillQuestion[] | null

  // Investigation report state
  investigationReport: {
    specialist: string
    taskId: string
    report: InvestigationReport
  } | null

  loadConversations: (workspaceId: string) => Promise<void>
  createConversation: (
    workspaceId: string,
    mode?: ConversationMode,
    title?: string,
    personaSpecialistId?: string
  ) => Promise<void>
  switchPersona: (personaSpecialistId: string | null) => Promise<void>
  selectConversation: (id: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  updateMode: (mode: ConversationMode) => Promise<void>
  renameConversation: (id: string, title: string) => Promise<void>
  stopGeneration: () => Promise<void>
  sendMessage: (text: string, attachments?: string[]) => Promise<void>
  appendStreamChunk: (
    chunk: string,
    role?: 'generalist' | 'coordinator' | 'specialist',
    taskId?: string,
    specialist?: string
  ) => void
  updateStreamingIdentity: (
    role: 'generalist' | 'coordinator' | 'specialist',
    taskId?: string,
    specialist?: string
  ) => void
  finalizeStream: (messageId: string, taskId?: string) => void
  finalizeTurnBubble: (turnId: string) => void
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
  setDecomposedTasks: (tasks: DecomposedTask[]) => void
  updateTaskProgress: (progress: TaskExecutionProgress) => void

  // Grill session actions
  startGrillSession: () => void
  endGrillSession: (summary: string, proposedTasks: GrillProposedTask[]) => void
  clearGrillSession: () => void
  setGrillQuestions: (questions: GrillQuestion[]) => void
  submitGrillAnswers: (answers: GrillAnswerPayload[]) => void
  skipAllGrillQuestions: () => void
  createItemsFromGrill: (
    tasks: Array<{ title: string; context: string; description: string }>
  ) => Promise<void>

  // General chat question actions
  setPendingQuestions: (questions: GrillQuestion[]) => void
  submitQuestionAnswers: (answers: GrillAnswerPayload[]) => void
  skipAllQuestions: () => void

  setInvestigationReport: (data: {
    specialist: string
    taskId: string
    report: InvestigationReport
  }) => void
  executeInvestigationFix: (strategy: ExecutionStrategy) => Promise<void>
  clearInvestigationReport: () => void

  // /complete and /close actions
  completeConversation: (
    branchName: string,
    commitMessage: string,
    description: string
  ) => Promise<CompleteResult>
  closeConversation: (id: string) => Promise<void>

  // Draft text per conversation (persists across tab switches)
  draftTexts: Record<string, string>
  setDraftText: (conversationId: string, text: string) => void
  getDraftText: (conversationId: string) => string
  clearDraftText: (conversationId: string) => void

  // Context usage per conversation
  contextUsages: Record<string, ContextUsage>
  loadContextUsage: (conversationId: string) => Promise<void>

  // Conversation reordering
  reorderConversations: (orderedIds: string[]) => Promise<void>

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
  streamingSpecialist: previousChatState?.streamingSpecialist ?? null,
  streamingTaskId: previousChatState?.streamingTaskId ?? null,
  isStreaming: previousChatState?.isStreaming ?? false,
  activeHandoff: previousChatState?.activeHandoff ?? null,
  toolActivities: previousChatState?.toolActivities ?? [],
  taskProgress: previousChatState?.taskProgress ?? new Map(),
  isExecutingPlan: previousChatState?.isExecutingPlan ?? false,
  decomposedTasks: previousChatState?.decomposedTasks ?? [],
  compactSuggestion: previousChatState?.compactSuggestion ?? null,
  grillSession: previousChatState?.grillSession ?? null,
  pendingQuestions: previousChatState?.pendingQuestions ?? null,
  investigationReport: null,
  draftTexts: previousChatState?.draftTexts ?? {},
  contextUsages: previousChatState?.contextUsages ?? {},

  // Bind lazy refs for the safety timer helper (runs once on store creation)
  ...(() => {
    _storeGet = get
    _storeSet = set
    return {}
  })(),

  loadConversations: async (workspaceId: string) => {
    try {
      const conversations = await window.api.getConversations({ workspaceId })
      set({ conversations })
    } catch (error) {
      rendererLog.error('Failed to load conversations:', error)
    }
  },

  createConversation: async (
    workspaceId: string,
    mode?: ConversationMode,
    title?: string,
    personaSpecialistId?: string
  ) => {
    const conversation = await window.api.createConversation({
      workspaceId,
      mode,
      title,
      personaSpecialistId
    })
    set((state) => ({
      conversations: [conversation, ...state.conversations],
      activeConversation: conversation,
      messages: [],
      streamingContent: '',
      isStreaming: false
    }))
  },

  switchPersona: async (personaSpecialistId: string | null) => {
    const { activeConversation } = get()
    if (!activeConversation) return
    const updated = await window.api.updatePersona({
      conversationId: activeConversation.id,
      personaSpecialistId
    })
    set((state) => ({
      activeConversation: updated,
      conversations: state.conversations.map((c) => (c.id === updated.id ? updated : c))
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
      rendererLog.error('Failed to update mode:', error)
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
    set({
      activeConversation: conversation,
      messages,
      streamingContent: '',
      isStreaming: false,
      // Clear ephemeral UI state from previous conversation
      taskProgress: new Map(),
      isExecutingPlan: false,
      decomposedTasks: [],
      investigationReport: null,
      activeHandoff: null,
      toolActivities: [],
      grillSession: null,
      compactSuggestion: null,
      pendingQuestions: null
    })

    // CLI mode sync is deferred — will happen automatically on next message send
    // No need to restart the CLI process just because the user switched conversations
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
    const { streamingContent, streamingRole, streamingSpecialist, activeConversation } = get()

    try {
      await window.api.stopGeneration()
    } catch (error) {
      rendererLog.error('Failed to stop generation:', error)
    }

    // Clear build execution state so progress card dismisses
    set({ isExecutingPlan: false })

    // Preserve partial streaming content as a message with a "stopped" suffix
    if (streamingContent && activeConversation) {
      const stoppedMessage: Message = {
        id: `stopped-${Date.now()}`,
        conversationId: activeConversation.id,
        role: streamingRole,
        ...(streamingRole === 'specialist' && streamingSpecialist
          ? { agentId: streamingSpecialist }
          : {}),
        contentMd: streamingContent + '\n\n---\n\n⏹ *Generation stopped by user.*',
        attachmentsJson: '[]',
        createdAt: new Date().toISOString()
      }
      set((state) => ({
        messages: [...state.messages, stoppedMessage],
        streamingContent: '',
        isStreaming: false,
        toolActivities: []
      }))
    } else if (activeConversation) {
      // No partial content — still show a local indicator
      const stoppedMessage: Message = {
        id: `stopped-${Date.now()}`,
        conversationId: activeConversation.id,
        role: 'generalist',
        contentMd: '⏹ *Generation stopped by user.*',
        attachmentsJson: '[]',
        createdAt: new Date().toISOString()
      }
      set((state) => ({
        messages: [...state.messages, stoppedMessage],
        streamingContent: '',
        isStreaming: false,
        toolActivities: []
      }))
    } else {
      set({ isStreaming: false, streamingContent: '', toolActivities: [] })
    }
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
      streamingContent: '',
      toolActivities: []
    }))

    // Safety: force-reset if streaming state gets stuck (e.g., process dies without emitting complete)
    resetStreamingSafetyTimer()

    try {
      await window.api.sendMessage({
        conversationId: activeConversation.id,
        text,
        attachments
      })
    } catch (error) {
      rendererLog.error('Failed to send message:', error)
      if (streamingSafetyTimer) {
        clearTimeout(streamingSafetyTimer)
        streamingSafetyTimer = null
      }
      set({ isStreaming: false })
    }
  },

  appendStreamChunk: (
    chunk: string,
    role?: 'generalist' | 'coordinator' | 'specialist',
    taskId?: string,
    specialist?: string
  ) => {
    // Reset safety timer — backend is still alive
    resetStreamingSafetyTimer()
    if (!chunk) return // Skip empty chunks (tool-only messages)
    set((state) => {
      // If taskId changed, a new specialist is streaming — start fresh content
      const isNewTask = taskId != null && taskId !== state.streamingTaskId
      return {
        isStreaming: true, // Ensure streaming bubble renders for specialist chunks
        streamingContent: isNewTask ? chunk : state.streamingContent + chunk,
        streamingRole: role ?? state.streamingRole,
        streamingSpecialist: specialist ?? state.streamingSpecialist,
        streamingTaskId: taskId ?? state.streamingTaskId
      }
    })
  },

  updateStreamingIdentity: (role, taskId?, specialist?) => {
    set((state) => ({
      streamingRole: role,
      streamingSpecialist: specialist ?? state.streamingSpecialist,
      streamingTaskId: taskId ?? state.streamingTaskId
    }))
  },

  addToolActivity: (activity: ToolActivity) => {
    // Reset safety timer — tool started, backend is active
    resetStreamingSafetyTimer()
    set((state) => ({
      toolActivities: [...state.toolActivities, activity]
    }))
  },

  updateToolActivity: (activity: Partial<ToolActivity> & { toolName: string; id?: string }) => {
    // Reset safety timer — tool completed, backend is active
    resetStreamingSafetyTimer()
    set((state) => {
      // Find matching activity — by ID first (reliable), then by toolName (legacy fallback)
      const activities = [...state.toolActivities]
      for (let i = activities.length - 1; i >= 0; i--) {
        const isMatch = activity.id
          ? activities[i].id === activity.id
          : activities[i].toolName === activity.toolName && activities[i].status === 'running'
        if (isMatch) {
          activities[i] = {
            ...activities[i],
            ...activity,
            // Preserve existing input if update doesn't provide one
            input: activity.input ?? activities[i].input,
            // If elapsedSeconds is provided but no explicit status change, keep current status
            status:
              activity.status ??
              (activity.elapsedSeconds !== undefined ? activities[i].status : 'completed'),
            // Preserve elapsedSeconds for progress display
            elapsedSeconds: activity.elapsedSeconds ?? activities[i].elapsedSeconds
          }
          break
        }
      }
      return { toolActivities: activities }
    })
  },

  finalizeStream: (messageId: string, taskId?: string) => {
    // Clear safety timer on normal stream completion (only on final complete, not per-task)
    if (!taskId && streamingSafetyTimer) {
      clearTimeout(streamingSafetyTimer)
      streamingSafetyTimer = null
    }

    const { streamingContent, streamingRole, streamingSpecialist, activeConversation } = get()

    if (streamingContent && activeConversation) {
      // Safety net: force-complete any tools still marked as "running" — ensures
      // no tool dots stay yellow/running after the stream ends, even if a tool_result was lost.
      const currentToolActivities = get().toolActivities.map((a) =>
        a.status === 'running' ? { ...a, status: 'completed' as const, completedAt: Date.now() } : a
      )
      const finalMessage: Message = {
        id: messageId,
        conversationId: activeConversation.id,
        role: streamingRole,
        // Attach specialist agentId so MessageBubble can resolve the correct identity
        ...(streamingRole === 'specialist' && streamingSpecialist
          ? { agentId: streamingSpecialist }
          : {}),
        contentMd: streamingContent,
        attachmentsJson: '[]',
        createdAt: new Date().toISOString(),
        toolActivities: currentToolActivities.length > 0 ? [...currentToolActivities] : undefined
      }

      set((state) => ({
        messages: [...state.messages, finalMessage],
        streamingContent: '',
        // Only stop streaming if this is the final complete (no taskId = final summary)
        isStreaming: !!taskId,
        toolActivities: taskId ? state.toolActivities : [],
        streamingTaskId: null,
        streamingSpecialist: taskId ? state.streamingSpecialist : null,
        // Clear handoff indicator on final complete (B8 fix)
        activeHandoff: taskId ? state.activeHandoff : null
      }))
    } else if (taskId) {
      // Per-task complete with no accumulated content — just reset task tracking
      set({ streamingContent: '', streamingTaskId: null })
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
            toolActivities: [],
            streamingTaskId: null,
            activeHandoff: null
          })
        })
        .catch((error) => {
          rendererLog.error('Failed to reload messages after stream finalize:', error)
          set({
            streamingContent: '',
            isStreaming: false,
            toolActivities: [],
            streamingTaskId: null,
            activeHandoff: null
          })
        })
    } else {
      set({
        streamingContent: '',
        isStreaming: false,
        toolActivities: [],
        streamingTaskId: null,
        activeHandoff: null
      })
    }
  },

  finalizeTurnBubble: (turnId: string) => {
    const {
      streamingContent,
      streamingRole,
      streamingSpecialist,
      activeConversation,
      toolActivities
    } = get()

    // Nothing to finalize — agent went straight to tools without text
    if (!streamingContent && toolActivities.length === 0) return

    if (activeConversation) {
      const turnMessage: Message = {
        id: turnId,
        conversationId: activeConversation.id,
        role: streamingRole,
        ...(streamingRole === 'specialist' && streamingSpecialist
          ? { agentId: streamingSpecialist }
          : {}),
        contentMd: streamingContent,
        attachmentsJson: '[]',
        createdAt: new Date().toISOString(),
        // Snapshot current tool activities into this bubble
        toolActivities:
          toolActivities.length > 0
            ? toolActivities.map((a) => ({
                ...a,
                status: a.status === 'running' ? ('completed' as const) : a.status
              }))
            : undefined
      }

      set((state) => ({
        messages: [...state.messages, turnMessage],
        streamingContent: '', // Reset for next turn
        toolActivities: [], // Reset tools for next turn
        isStreaming: true // Stay in streaming mode
      }))
    }
  },

  setHandoff: (handoff: HandoffState) => {
    set({ activeHandoff: handoff })
  },

  clearHandoff: () => {
    set({ activeHandoff: null })
  },

  setDecomposedTasks: (tasks: DecomposedTask[]) => {
    set({ decomposedTasks: tasks, isExecutingPlan: tasks.length > 0 })
  },

  updateTaskProgress: (progress: TaskExecutionProgress) => {
    set((state) => {
      const updated = new Map(state.taskProgress)
      updated.set(progress.taskId, progress)

      // Check if all tracked tasks are done
      const allDone = Array.from(updated.values()).every(
        (p) => p.status === 'completed' || p.status === 'failed'
      )

      return {
        taskProgress: updated,
        isExecutingPlan: !allDone
      }
    })
  },

  setInvestigationReport: (data) => set({ investigationReport: data }),

  clearInvestigationReport: () => set({ investigationReport: null }),

  executeInvestigationFix: async (strategy) => {
    const { investigationReport, activeConversation } = get()
    if (!investigationReport || !activeConversation) return

    // Set executing state — buttons will be hidden, loading indicator shown
    set({ isExecutingPlan: true })

    try {
      await window.api.executeInvestigationFix({
        conversationId: activeConversation.id,
        strategy,
        report: investigationReport.report
      })
      // Don't clear investigationReport here — isExecutingPlan will be cleared
      // when task progress events arrive marking all tasks as done
    } catch (error) {
      rendererLog.error('Failed to execute investigation fix:', error)
      set({ isExecutingPlan: false })
    }
  },

  completeConversation: async (branchName: string, commitMessage: string, description: string) => {
    const { activeConversation, conversations } = get()
    if (!activeConversation) throw new Error('No active conversation')

    const result = await window.api.completeConversation({
      conversationId: activeConversation.id,
      branchName,
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
      taskProgress: new Map(),
      isExecutingPlan: false,
      decomposedTasks: []
    })

    return result
  },

  closeConversation: async (id: string) => {
    try {
      await window.api.closeConversation({ conversationId: id })
    } catch (error) {
      rendererLog.error('Failed to close conversation on backend:', error)
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
    set({
      grillSession: {
        active: true,
        summary: null,
        proposedTasks: [],
        pendingQuestions: [],
        answers: {}
      }
    })
  },

  endGrillSession: (summary: string, proposedTasks: GrillProposedTask[]) => {
    set((state) => ({
      grillSession: {
        active: false,
        summary,
        proposedTasks,
        pendingQuestions: [],
        answers: state.grillSession?.answers ?? {}
      }
    }))
  },

  clearGrillSession: () => {
    set({ grillSession: null })
  },

  setGrillQuestions: (questions: GrillQuestion[]) => {
    set((state) => ({
      grillSession: {
        active: state.grillSession?.active ?? true,
        summary: state.grillSession?.summary ?? null,
        proposedTasks: state.grillSession?.proposedTasks ?? [],
        pendingQuestions: questions,
        answers: {}
      }
    }))
  },

  submitGrillAnswers: (answers: GrillAnswerPayload[]) => {
    // Format answers into a readable message for the AI
    const lines: string[] = ['Here are my answers:\n']
    for (const answer of answers) {
      const question = get().grillSession?.pendingQuestions.find((q) => q.id === answer.questionId)
      const header = question?.header || question?.question || answer.questionId

      if (answer.skipped) {
        lines.push(`**${header}**: [SKIPPED]`)
      } else {
        const selections = answer.selectedOptions.map((opt) => {
          const option = question?.options.find((o) => o.label === opt)
          return option?.recommended ? `${opt} (recommended)` : opt
        })
        let line = `**${header}**: ${selections.join(', ')}`
        if (answer.otherText) {
          line += ` + "${answer.otherText}"`
        }
        lines.push(line)
      }
    }

    const formattedMessage = lines.join('\n')

    // Clear pending questions
    set((state) => ({
      grillSession: state.grillSession
        ? {
            ...state.grillSession,
            pendingQuestions: [],
            answers: {}
          }
        : null
    }))

    // Send the formatted message
    get().sendMessage(formattedMessage)
  },

  skipAllGrillQuestions: () => {
    // Clear pending questions and notify the AI
    set((state) => ({
      grillSession: state.grillSession
        ? {
            ...state.grillSession,
            pendingQuestions: [],
            answers: {}
          }
        : null
    }))

    get().sendMessage('All questions skipped — proceeding with defaults.')
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
        rendererLog.error(`Failed to create item conversation for "${task.title}":`, error)
      }
    }

    // Clear the grill session after creating items
    set({ grillSession: null })
  },

  // General chat question actions (ask_user tool)
  setPendingQuestions: (questions) => {
    set({ pendingQuestions: questions })
  },

  submitQuestionAnswers: (answers) => {
    const lines: string[] = ['Here are my answers:\n']
    for (const answer of answers) {
      const question = get().pendingQuestions?.find((q) => q.id === answer.questionId)
      const header = question?.header || question?.question || answer.questionId
      if (answer.skipped) {
        lines.push(`**${header}**: [SKIPPED]`)
      } else {
        const selected = answer.selectedOptions.join(', ')
        const other = answer.otherText ? ` (Other: ${answer.otherText})` : ''
        lines.push(`**${header}**: ${selected}${other}`)
      }
    }
    set({ pendingQuestions: null })
    get().sendMessage(lines.join('\n'))
  },

  skipAllQuestions: () => {
    set({ pendingQuestions: null })
    get().sendMessage("I'll skip these questions for now — let's continue.")
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

  // ── Draft text per conversation ──
  setDraftText: (conversationId: string, text: string) =>
    set((state) => ({
      draftTexts: { ...state.draftTexts, [conversationId]: text }
    })),

  getDraftText: (conversationId: string) => get().draftTexts[conversationId] ?? '',

  clearDraftText: (conversationId: string) =>
    set((state) => {
      const { [conversationId]: _, ...rest } = state.draftTexts
      return { draftTexts: rest }
    }),

  // ── Context usage per conversation ──
  loadContextUsage: async (conversationId: string) => {
    try {
      const usage = await window.api.getContextUsage({ conversationId })
      set((state) => ({
        contextUsages: { ...state.contextUsages, [conversationId]: usage }
      }))
    } catch (error) {
      rendererLog.error('Failed to load context usage:', error)
    }
  },

  // ─��� Conversation reordering ──
  reorderConversations: async (orderedIds: string[]) => {
    // Optimistically reorder local state
    set((state) => {
      const map = new Map(state.conversations.map((c) => [c.id, c]))
      const reordered = orderedIds
        .map((id, i) => {
          const c = map.get(id)
          return c ? { ...c, sortOrder: i } : null
        })
        .filter(Boolean) as Conversation[]
      const remaining = state.conversations.filter((c) => !orderedIds.includes(c.id))
      return { conversations: [...reordered, ...remaining] }
    })
    try {
      await window.api.reorderConversations({ orderedIds })
    } catch (error) {
      rendererLog.error('Failed to reorder conversations:', error)
    }
  },

  reset: () => {
    set({
      conversations: [],
      activeConversation: null,
      messages: [],
      streamingContent: '',
      streamingRole: 'generalist' as const,
      streamingSpecialist: null,
      isStreaming: false,
      activeHandoff: null,
      toolActivities: [],
      taskProgress: new Map(),
      isExecutingPlan: false,
      decomposedTasks: [],
      compactSuggestion: null,
      grillSession: null,
      investigationReport: null,
      draftTexts: {},
      contextUsages: {}
    })
  }
}))

// ── Stable action selectors (never trigger re-renders) ──
// Zustand actions are referentially stable — extracting them into a dedicated hook
// prevents components from re-rendering on every streaming chunk (~50+/sec) when
// they only need actions (functions) and not state values.
export const useChatActions = (): Pick<
  ChatState,
  | 'sendMessage'
  | 'stopGeneration'
  | 'clearDisplay'
  | 'appendLocalMessage'
  | 'completeConversation'
  | 'closeConversation'
  | 'createConversation'
  | 'switchPersona'
  | 'selectConversation'
  | 'deleteConversation'
  | 'updateMode'
  | 'renameConversation'
  | 'loadConversations'
  | 'startGrillSession'
  | 'clearGrillSession'
  | 'submitGrillAnswers'
  | 'skipAllGrillQuestions'
  | 'createItemsFromGrill'
  | 'setCompactSuggestion'
  | 'setDecomposedTasks'
  | 'updateTaskProgress'
  | 'setGrillQuestions'
  | 'endGrillSession'
  | 'appendStreamChunk'
  | 'updateStreamingIdentity'
  | 'finalizeStream'
  | 'finalizeTurnBubble'
  | 'addToolActivity'
  | 'updateToolActivity'
  | 'setHandoff'
  | 'clearHandoff'
  | 'setPendingQuestions'
  | 'submitQuestionAnswers'
  | 'skipAllQuestions'
  | 'setInvestigationReport'
  | 'executeInvestigationFix'
  | 'clearInvestigationReport'
  | 'setDraftText'
  | 'clearDraftText'
  | 'loadContextUsage'
  | 'reorderConversations'
> =>
  useChatStore(
    useShallow((s) => ({
      sendMessage: s.sendMessage,
      stopGeneration: s.stopGeneration,
      clearDisplay: s.clearDisplay,
      appendLocalMessage: s.appendLocalMessage,
      completeConversation: s.completeConversation,
      closeConversation: s.closeConversation,
      createConversation: s.createConversation,
      switchPersona: s.switchPersona,
      selectConversation: s.selectConversation,
      deleteConversation: s.deleteConversation,
      updateMode: s.updateMode,
      renameConversation: s.renameConversation,
      loadConversations: s.loadConversations,
      startGrillSession: s.startGrillSession,
      clearGrillSession: s.clearGrillSession,
      submitGrillAnswers: s.submitGrillAnswers,
      skipAllGrillQuestions: s.skipAllGrillQuestions,
      createItemsFromGrill: s.createItemsFromGrill,
      setCompactSuggestion: s.setCompactSuggestion,
      setDecomposedTasks: s.setDecomposedTasks,
      updateTaskProgress: s.updateTaskProgress,
      setGrillQuestions: s.setGrillQuestions,
      endGrillSession: s.endGrillSession,
      appendStreamChunk: s.appendStreamChunk,
      updateStreamingIdentity: s.updateStreamingIdentity,
      finalizeStream: s.finalizeStream,
      finalizeTurnBubble: s.finalizeTurnBubble,
      addToolActivity: s.addToolActivity,
      updateToolActivity: s.updateToolActivity,
      setHandoff: s.setHandoff,
      clearHandoff: s.clearHandoff,
      setPendingQuestions: s.setPendingQuestions,
      submitQuestionAnswers: s.submitQuestionAnswers,
      skipAllQuestions: s.skipAllQuestions,
      setInvestigationReport: s.setInvestigationReport,
      executeInvestigationFix: s.executeInvestigationFix,
      clearInvestigationReport: s.clearInvestigationReport,
      setDraftText: s.setDraftText,
      clearDraftText: s.clearDraftText,
      loadContextUsage: s.loadContextUsage,
      reorderConversations: s.reorderConversations
    }))
  )

// Preserve state on HMR dispose
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    import.meta.hot!.data.chatStoreState = useChatStore.getState()
  })
}
