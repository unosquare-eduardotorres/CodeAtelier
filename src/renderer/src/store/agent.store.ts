import { create } from 'zustand';
import type { AgentStatus } from '../../../shared/types';

interface AgentState {
  statuses: AgentStatus[];
  isStopping: boolean;
  sessionTokens: number;
  lastKnownTokens: Record<string, number>;

  updateStatus: (status: AgentStatus) => void;
  clearStatuses: () => void;
  stopAllAgents: () => Promise<void>;
}

export const useAgentStore = create<AgentState>((set) => ({
  statuses: [],
  isStopping: false,
  sessionTokens: 0,
  lastKnownTokens: {},

  updateStatus: (status: AgentStatus) => {
    set((state) => {
      // ── Session token accumulation ──
      const prevTokens = state.lastKnownTokens[status.agentId] ?? 0;
      const currentTokens = status.tokenUsage;
      // If current < prev, agent was restarted → treat current as a fresh delta
      const delta =
        currentTokens >= prevTokens ? currentTokens - prevTokens : currentTokens;
      const newSessionTokens = state.sessionTokens + delta;
      const newLastKnown = {
        ...state.lastKnownTokens,
        [status.agentId]: currentTokens
      };

      // ── Existing status array update ──
      const existing = state.statuses.findIndex((s) => s.agentId === status.agentId);
      if (existing >= 0) {
        const updated = [...state.statuses];
        updated[existing] = status;
        return {
          statuses: updated,
          sessionTokens: newSessionTokens,
          lastKnownTokens: newLastKnown
        };
      }
      return {
        statuses: [...state.statuses, status],
        sessionTokens: newSessionTokens,
        lastKnownTokens: newLastKnown
      };
    });
  },

  clearStatuses: () => {
    set({ statuses: [] });
    // Note: sessionTokens and lastKnownTokens are NOT cleared
  },

  stopAllAgents: async () => {
    set({ isStopping: true });
    try {
      await window.api.stopAllAgents();
    } catch (error) {
      console.error('Failed to stop agents:', error);
    } finally {
      set({ isStopping: false });
    }
  }
}));
