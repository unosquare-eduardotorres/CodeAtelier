/**
 * UltraPlan store — tracks cloud-based planning lifecycle via Claude Code web.
 *
 * UltraPlan drafts a plan on claude.ai/code, lets the user review/revise in
 * the browser, then optionally teleports the approved plan back to the app.
 */

import { create } from 'zustand'

export type UltraplanStatus =
  | 'idle'
  | 'drafting'
  | 'needs_input'
  | 'ready'
  | 'approved'
  | 'cancelled'

interface UltraplanState {
  status: UltraplanStatus
  sessionUrl: string | null
  conversationId: string | null
  planContent: string | null

  // Actions
  setStatus: (status: UltraplanStatus, sessionUrl?: string) => void
  setApproved: (planContent?: string) => void
  setConversationId: (conversationId: string) => void
  reset: () => void
}

// Preserve Zustand state across HMR (dev only)
const previousState = import.meta.hot?.data?.ultraplanStoreState as
  | Partial<UltraplanState>
  | undefined

export const useUltraplanStore = create<UltraplanState>((set) => ({
  status: previousState?.status ?? 'idle',
  sessionUrl: previousState?.sessionUrl ?? null,
  conversationId: previousState?.conversationId ?? null,
  planContent: previousState?.planContent ?? null,

  setStatus: (status: UltraplanStatus, sessionUrl?: string) => {
    set({ status, ...(sessionUrl !== undefined ? { sessionUrl } : {}) })
  },

  setApproved: (planContent?: string) => {
    set({ status: 'approved', planContent: planContent ?? null })
  },

  setConversationId: (conversationId: string) => {
    set({ conversationId })
  },

  reset: () => {
    set({ status: 'idle', sessionUrl: null, conversationId: null, planContent: null })
  }
}))

// Preserve state on HMR dispose
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    import.meta.hot!.data.ultraplanStoreState = useUltraplanStore.getState()
  })
}
