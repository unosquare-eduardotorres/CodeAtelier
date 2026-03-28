import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'
import type { AgentStatus } from '../../../shared/types'

interface GateResult {
  type: string
  passed: boolean
  summary: string
}

interface AgentState {
  statuses: AgentStatus[]
  isStopping: boolean
  sessionTokens: number
  lastKnownTokens: Record<string, number>
  agentOutputs: Record<string, string>
  gateResults: Record<string, GateResult[]>
  abandonments: Record<string, { pattern: string }>

  updateStatus: (status: AgentStatus) => void
  clearStatuses: () => void
  stopAllAgents: () => Promise<void>
  appendOutput: (agentId: string, text: string) => void
  clearOutputs: () => void
  addGateResult: (agentId: string, gate: GateResult) => void
  markAbandonment: (agentId: string, pattern: string) => void
  clearGateData: () => void
}

// Preserve Zustand state across HMR (dev only)
const previousAgentState = import.meta.hot?.data?.agentStoreState as Partial<AgentState> | undefined

export const useAgentStore = create<AgentState>((set) => ({
  statuses: previousAgentState?.statuses ?? [],
  isStopping: previousAgentState?.isStopping ?? false,
  sessionTokens: previousAgentState?.sessionTokens ?? 0,
  lastKnownTokens: previousAgentState?.lastKnownTokens ?? {},
  agentOutputs: previousAgentState?.agentOutputs ?? {},
  gateResults: previousAgentState?.gateResults ?? {},
  abandonments: previousAgentState?.abandonments ?? {},

  updateStatus: (status: AgentStatus) => {
    set((state) => {
      // ── Session token accumulation ──
      const prevTokens = state.lastKnownTokens[status.agentId] ?? 0
      const currentTokens = status.tokenUsage
      // If current < prev, agent was restarted → treat current as a fresh delta
      const delta = currentTokens >= prevTokens ? currentTokens - prevTokens : currentTokens
      const newSessionTokens = state.sessionTokens + delta
      const newLastKnown = {
        ...state.lastKnownTokens,
        [status.agentId]: currentTokens
      }

      // ── Existing status array update ──
      const existing = state.statuses.findIndex((s) => s.agentId === status.agentId)
      if (existing >= 0) {
        const updated = [...state.statuses]
        updated[existing] = status
        return {
          statuses: updated,
          sessionTokens: newSessionTokens,
          lastKnownTokens: newLastKnown
        }
      }
      return {
        statuses: [...state.statuses, status],
        sessionTokens: newSessionTokens,
        lastKnownTokens: newLastKnown
      }
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

  addGateResult: (agentId: string, gate: GateResult) => {
    set((state) => {
      const existing = state.gateResults[agentId] ?? []
      return {
        gateResults: {
          ...state.gateResults,
          [agentId]: [...existing, gate]
        }
      }
    })
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
    set({ gateResults: {}, abandonments: {} })
  }
}))

// Preserve state on HMR dispose
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    import.meta.hot!.data.agentStoreState = useAgentStore.getState()
  })
}
