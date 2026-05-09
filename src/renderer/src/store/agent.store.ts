import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'
import type { AgentStatus } from '../../../shared/types'

interface AgentState {
  statuses: AgentStatus[]
  isStopping: boolean
  sessionTokens: number
  sessionInputTokens: number
  sessionOutputTokens: number
  /** Current context window size (point-in-time, from SDK getContextUsage) */
  contextWindowTokens: number
  lastKnownTokens: Record<string, number>
  lastKnownInputTokens: Record<string, number>
  lastKnownOutputTokens: Record<string, number>
  agentOutputs: Record<string, string>
  abandonments: Record<string, { pattern: string }>

  updateStatus: (status: AgentStatus) => void
  clearStatuses: () => void
  stopAllAgents: () => Promise<void>
  appendOutput: (agentId: string, text: string) => void
  clearOutputs: () => void
  markAbandonment: (agentId: string, pattern: string) => void
  clearGateData: () => void
}

// Preserve Zustand state across HMR (dev only)
const previousAgentState = import.meta.hot?.data?.agentStoreState as Partial<AgentState> | undefined

export const useAgentStore = create<AgentState>((set) => ({
  statuses: previousAgentState?.statuses ?? [],
  isStopping: previousAgentState?.isStopping ?? false,
  sessionTokens: previousAgentState?.sessionTokens ?? 0,
  sessionInputTokens: previousAgentState?.sessionInputTokens ?? 0,
  sessionOutputTokens: previousAgentState?.sessionOutputTokens ?? 0,
  contextWindowTokens: previousAgentState?.contextWindowTokens ?? 0,
  lastKnownTokens: previousAgentState?.lastKnownTokens ?? {},
  lastKnownInputTokens: previousAgentState?.lastKnownInputTokens ?? {},
  lastKnownOutputTokens: previousAgentState?.lastKnownOutputTokens ?? {},
  agentOutputs: previousAgentState?.agentOutputs ?? {},
  abandonments: previousAgentState?.abandonments ?? {},

  updateStatus: (status: AgentStatus) => {
    set((state) => {
      // ── Session token accumulation (total) ──
      const prevTokens = state.lastKnownTokens[status.agentId] ?? 0
      const currentTokens = status.tokenUsage
      // If current < prev, agent was restarted → treat current as a fresh delta
      const delta = currentTokens >= prevTokens ? currentTokens - prevTokens : currentTokens
      const newSessionTokens = state.sessionTokens + delta
      const newLastKnown = {
        ...state.lastKnownTokens,
        [status.agentId]: currentTokens
      }

      // ── Session input/output token accumulation ──
      const prevIn = state.lastKnownInputTokens[status.agentId] ?? 0
      const curIn = status.inputTokens ?? 0
      const deltaIn = curIn >= prevIn ? curIn - prevIn : curIn

      const prevOut = state.lastKnownOutputTokens[status.agentId] ?? 0
      const curOut = status.outputTokens ?? 0
      const deltaOut = curOut >= prevOut ? curOut - prevOut : curOut

      const newLastKnownInput = {
        ...state.lastKnownInputTokens,
        [status.agentId]: curIn
      }
      const newLastKnownOutput = {
        ...state.lastKnownOutputTokens,
        [status.agentId]: curOut
      }

      // Extract context window size from the da-vinci agent status (point-in-time value)
      const contextWindowTokens =
        status.agentType === 'da-vinci' && status.contextTokens
          ? status.contextTokens
          : state.contextWindowTokens

      const sessionUpdate = {
        sessionTokens: newSessionTokens,
        sessionInputTokens: state.sessionInputTokens + deltaIn,
        sessionOutputTokens: state.sessionOutputTokens + deltaOut,
        contextWindowTokens,
        lastKnownTokens: newLastKnown,
        lastKnownInputTokens: newLastKnownInput,
        lastKnownOutputTokens: newLastKnownOutput
      }

      // ── Existing status array update ──
      const existing = state.statuses.findIndex((s) => s.agentId === status.agentId)
      if (existing >= 0) {
        const updated = [...state.statuses]
        updated[existing] = status
        return { statuses: updated, ...sessionUpdate }
      }
      return { statuses: [...state.statuses, status], ...sessionUpdate }
    })
  },

  clearStatuses: () => {
    set({ statuses: [] })
    // Note: sessionTokens and lastKnownTokens are NOT cleared
  },

  stopAllAgents: async () => {
    set({ isStopping: true })
    try {
      await window.api.stopAllAgents()
    } catch (error) {
      rendererLog.error('Failed to stop agents:', error)
    } finally {
      set({ isStopping: false })
    }
  },

  appendOutput: (agentId: string, text: string) => {
    set((state) => {
      const current = state.agentOutputs[agentId] ?? ''
      // Cap output at 100KB per agent to prevent memory issues
      const newOutput = (current + text).slice(-102400)
      return {
        agentOutputs: {
          ...state.agentOutputs,
          [agentId]: newOutput
        }
      }
    })
  },

  clearOutputs: () => {
    set({ agentOutputs: {} })
  },

  markAbandonment: (agentId: string, pattern: string) => {
    set((state) => ({
      abandonments: {
        ...state.abandonments,
        [agentId]: { pattern }
      }
    }))
  },

  clearGateData: () => {
    set({ abandonments: {} })
  }
}))

// Preserve state on HMR dispose
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    import.meta.hot!.data.agentStoreState = useAgentStore.getState()
  })
}
