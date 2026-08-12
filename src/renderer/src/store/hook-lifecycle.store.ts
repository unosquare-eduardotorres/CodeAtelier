import { create } from 'zustand'

export interface HookLifecycleEvent {
  hookName: string
  hookState: string
  requestId?: string
  timestamp: number
}

interface HookLifecycleState {
  /** Currently active hooks (not yet completed/failed) */
  activeHooks: Map<string, HookLifecycleEvent>
  /** Recent hook completions for brief display */
  recentCompletions: HookLifecycleEvent[]

  // Actions
  onHookEvent: (data: { hookName?: string; hookState?: string; requestId?: string }) => void
  clearAll: () => void
}

// Preserve Zustand state across HMR (dev only)
const previousState = import.meta.hot?.data?.hookLifecycleStoreState as
  Partial<HookLifecycleState> | undefined

export const useHookLifecycleStore = create<HookLifecycleState>((set) => ({
  activeHooks: previousState?.activeHooks ?? new Map(),
  recentCompletions: previousState?.recentCompletions ?? [],

  onHookEvent: (data) => {
    const hookName = data.hookName ?? 'unknown'
    const hookState = data.hookState ?? 'unknown'
    const key = data.requestId ?? hookName

    set((state) => {
      const event: HookLifecycleEvent = {
        hookName,
        hookState,
        requestId: data.requestId,
        timestamp: Date.now()
      }

      if (hookState === 'started' || hookState === 'running') {
        const newActive = new Map(state.activeHooks)
        newActive.set(key, event)
        return { activeHooks: newActive }
      }

      // completed / failed / cancelled — move from active to recent
      const newActive = new Map(state.activeHooks)
      newActive.delete(key)
      const newRecent = [event, ...state.recentCompletions].slice(0, 5) // Keep last 5
      return { activeHooks: newActive, recentCompletions: newRecent }
    })
  },

  clearAll: () => {
    set({ activeHooks: new Map(), recentCompletions: [] })
  }
}))

// HMR state preservation
if (import.meta.hot) {
  import.meta.hot.dispose((data) => {
    data.hookLifecycleStoreState = useHookLifecycleStore.getState()
  })
}
