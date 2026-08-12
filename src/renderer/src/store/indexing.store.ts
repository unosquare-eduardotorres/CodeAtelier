/**
 * Indexing Store — global state for semantic search indexing progress.
 *
 * Subscribed to INDEXING_PROGRESS IPC events from the main process.
 * Consumed by AppLayout (bottom bar indicator), CodeIntelligencePage,
 * and StartIndexingModal for real-time progress display.
 */
import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'
import type { IndexingState } from '../../../shared/types'

interface IndexingStoreState {
  /** Current indexing state for the active workspace */
  indexingState: IndexingState | null

  /** Whether the indexing progress listener is active */
  isListening: boolean

  /** Cleanup function for the IPC listener */
  cleanup: (() => void) | null

  // ── Actions ──

  /** Start listening for indexing progress events */
  startListening: () => void

  /** Stop listening and clean up */
  stopListening: () => void

  /** Manually refresh indexing status for a workspace */
  refreshStatus: (workspaceId: string) => Promise<void>

  /** Start indexing for a workspace */
  startIndexing: (workspaceId: string) => Promise<void>

  /** Pause indexing */
  pauseIndexing: (workspaceId: string) => Promise<void>

  /** Resume indexing */
  resumeIndexing: (workspaceId: string) => Promise<void>

  /** Cancel indexing */
  cancelIndexing: (workspaceId: string) => Promise<void>

  /** Clear the indexing state (e.g. on workspace switch) */
  clear: () => void
}

// Preserve state across HMR
const previousState = import.meta.hot?.data?.indexingStoreState as
  Partial<IndexingStoreState> | undefined

export const useIndexingStore = create<IndexingStoreState>((set, get) => ({
  indexingState: previousState?.indexingState ?? null,
  isListening: false,
  cleanup: null,

  startListening: () => {
    const { isListening, cleanup: existingCleanup } = get()
    if (isListening) return

    // Clean up any existing listener
    existingCleanup?.()

    const cleanup = window.api.onIndexingProgress((state: IndexingState) => {
      set({ indexingState: state })
    })

    set({ isListening: true, cleanup })
  },

  stopListening: () => {
    const { cleanup } = get()
    cleanup?.()
    set({ isListening: false, cleanup: null })
  },

  refreshStatus: async (workspaceId: string) => {
    try {
      const state = await window.api.indexingGetStatus({ workspaceId })
      set({ indexingState: state })
    } catch (error) {
      rendererLog.error('[IndexingStore] Failed to refresh status:', error)
    }
  },

  startIndexing: async (workspaceId: string) => {
    try {
      await window.api.indexingStart({ workspaceId })
    } catch (error) {
      rendererLog.error('[IndexingStore] Failed to start indexing:', error)
      throw error
    }
  },

  pauseIndexing: async (workspaceId: string) => {
    try {
      await window.api.indexingPause({ workspaceId })
    } catch (error) {
      rendererLog.error('[IndexingStore] Failed to pause indexing:', error)
    }
  },

  resumeIndexing: async (workspaceId: string) => {
    try {
      await window.api.indexingResume({ workspaceId })
    } catch (error) {
      rendererLog.error('[IndexingStore] Failed to resume indexing:', error)
    }
  },

  cancelIndexing: async (workspaceId: string) => {
    try {
      await window.api.indexingCancel({ workspaceId })
    } catch (error) {
      rendererLog.error('[IndexingStore] Failed to cancel indexing:', error)
    }
  },

  clear: () => {
    const { cleanup } = get()
    cleanup?.()
    set({ indexingState: null, isListening: false, cleanup: null })
  }
}))

// HMR state preservation
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    const state = useIndexingStore.getState()
    import.meta.hot!.data.indexingStoreState = {
      indexingState: state.indexingState
    }
    // Clean up listener on HMR
    state.cleanup?.()
  })
}
