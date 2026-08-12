import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'
import { useWorkspaceStore } from './workspace.store'
import { bootstrapSnapshotPatch } from './memory-store-utils'
import type {
  MemoryFact,
  MemoryContradiction,
  MemoryFeedProgress,
  MemoryFactCategory,
  MemoryCaptureSettings,
  MemoryEmbeddingStatus,
  MemorySourceType,
  IngestionProgress,
  BootstrapProgress,
  BootstrapMode,
  BootstrapScope,
  BootstrapItemStatus,
  BootstrapItemView,
  BootstrapRunSummary,
  ContradictionStatus
} from '../../../shared/types'

type FeedSource = MemorySourceType | 'claude-md' | 'codebase' | 'document'
type FeedStatus = 'idle' | 'running' | 'completed' | 'error'

interface BackfillProgress {
  running: boolean
  processed: number
  total: number
}

interface MemoryState {
  // Fact state
  facts: MemoryFact[]
  /**
   * True while a facts fetch is in flight. Starts `true` so the list never
   * renders "no memories match" during the first round-trip — serialising a
   * few thousand facts over IPC is not instant, and the empty state read as
   * "your brain was wiped".
   */
  factsLoading: boolean
  contradictions: MemoryContradiction[]
  contradictionsPage: number
  contradictionsTotal: number
  contradictionsPendingCount: number
  searchQuery: string
  embeddingStatus: MemoryEmbeddingStatus | null
  captureSettings: MemoryCaptureSettings | null
  backfillProgress: BackfillProgress | null
  backfillError: string | null

  // CLAUDE.md state
  claudeMdContent: string | null
  claudeMdPath: string | null
  claudeMdLoading: boolean

  // Feed state
  feedStatus: FeedStatus
  feedSource: FeedSource | null
  feedMessage: string | null
  feedError: string | null

  // Fact actions
  loadFacts: (workspaceId: string) => Promise<void>
  searchFacts: (workspaceId: string, query: string, category?: MemoryFactCategory) => Promise<void>
  archiveFact: (id: string, workspaceId: string) => Promise<void>
  confirmFact: (id: string, workspaceId: string) => Promise<void>
  deleteFact: (id: string) => Promise<void>
  updateFact: (
    id: string,
    params: {
      title?: string
      content?: string
      tags?: string[]
      scopePaths?: string[]
      category?: MemoryFactCategory
    }
  ) => Promise<void>

  // Scope toggle
  toggleScope: (id: string, global: boolean, workspaceId?: string) => Promise<void>

  // Contradiction actions
  loadContradictions: (status?: ContradictionStatus, page?: number) => Promise<void>
  resolveContradiction: (
    id: string,
    resolution: string,
    keepFactId: string,
    archiveFactId?: string
  ) => Promise<void>
  autoResolveDuplicates: (
    workspaceId: string,
    minCosine?: number
  ) => Promise<{ resolvedCount: number }>

  // CLAUDE.md actions
  loadClaudeMd: (workspacePath: string) => Promise<void>

  // Capture settings
  loadCaptureSettings: (workspaceId: string) => Promise<void>
  updateCaptureSettings: (
    workspaceId: string,
    settings: Partial<MemoryCaptureSettings>
  ) => Promise<void>

  // Embedding actions
  loadEmbeddingStatus: (workspaceId: string) => Promise<void>
  triggerBackfill: (workspaceId: string) => Promise<void>
  clearBackfillError: () => void

  // Dedup & Consolidation
  scanForDuplicates: (workspaceId: string) => Promise<{ clustersFound: number; autoMerged: number }>
  runConsolidation: (
    workspaceId: string
  ) => Promise<{ clustersFound: number; autoMerged: number; staleArchived: number }>

  // Search
  setSearchQuery: (query: string) => void

  // Feed actions (retained)
  onFeedProgress: (progress: MemoryFeedProgress) => void
  startFeed: (source: FeedSource) => void
  cancelFeed: () => void
  dismissFeed: () => void

  // Ingestion state
  ingestion: IngestionProgress | null
  ingestionCleanup: (() => void) | null
  startIngestion: (workspaceId: string, workspacePath: string, files: string[]) => Promise<void>
  cancelIngestion: () => void
  dismissIngestion: () => void
  onIngestionProgress: (progress: IngestionProgress) => void

  // Bootstrap state
  bootstrap: BootstrapProgress | null
  /** Live progress for every workspace, so the status bar sees background runs. */
  bootstrapByWorkspace: Record<string, BootstrapProgress>
  bootstrapLatestRun: BootstrapRunSummary | null
  bootstrapResumableRunId: string | null
  bootstrapItems: BootstrapItemView[]
  bootstrapItemsTotal: number
  bootstrapItemFilter: BootstrapItemStatus | 'all'
  startBootstrap: (
    workspaceId: string,
    workspacePath: string,
    mode?: BootstrapMode,
    force?: boolean,
    scope?: BootstrapScope
  ) => Promise<void>
  pauseBootstrap: (workspaceId: string) => Promise<void>
  resumeBootstrap: (runId: string, workspacePath: string) => Promise<void>
  cancelBootstrap: () => void
  dismissBootstrap: (workspaceId?: string) => void
  onBootstrapProgress: (progress: BootstrapProgress) => void
  seedBootstrapProgress: (progress: BootstrapProgress) => void
  loadBootstrapSnapshot: (workspaceId: string) => Promise<void>
  loadBootstrapItems: (
    runId: string,
    options?: { status?: BootstrapItemStatus | 'all'; offset?: number; limit?: number }
  ) => Promise<void>
  setBootstrapItemFilter: (filter: BootstrapItemStatus | 'all') => void
}

export const useMemoryStore = create<MemoryState>((set) => ({
  facts: [],
  factsLoading: true,
  contradictions: [],
  contradictionsPage: 0,
  contradictionsTotal: 0,
  contradictionsPendingCount: 0,
  searchQuery: '',
  embeddingStatus: null,
  captureSettings: null,
  backfillProgress: null,
  backfillError: null,
  claudeMdContent: null,
  claudeMdPath: null,
  claudeMdLoading: false,
  feedStatus: 'idle',
  feedSource: null,
  feedMessage: null,
  feedError: null,
  ingestion: null,
  ingestionCleanup: null,
  bootstrap: null,
  bootstrapByWorkspace: {},
  bootstrapLatestRun: null,
  bootstrapResumableRunId: null,
  bootstrapItems: [],
  bootstrapItemsTotal: 0,
  bootstrapItemFilter: 'all',

  // ── Fact actions ──

  loadFacts: async (workspaceId) => {
    set({ factsLoading: true })
    try {
      const facts = await window.api.memoryFactsList({ workspaceId })
      set({ facts })
    } catch (error) {
      rendererLog.error('Failed to load facts:', error)
    } finally {
      set({ factsLoading: false })
    }
  },

  searchFacts: async (workspaceId, query, category) => {
    set({ factsLoading: true })
    try {
      const facts = await window.api.memoryFactsSearch({ workspaceId, query, category })
      set({ facts, searchQuery: query })
    } catch (error) {
      rendererLog.error('Failed to search facts:', error)
    } finally {
      set({ factsLoading: false })
    }
  },

  archiveFact: async (id, _workspaceId) => {
    try {
      await window.api.memoryFactsArchive({ id })
      set((state) => ({
        facts: state.facts.filter((f) => f.id !== id)
      }))
    } catch (error) {
      rendererLog.error('Failed to archive fact:', error)
    }
  },

  confirmFact: async (id, _workspaceId) => {
    try {
      const confirmed = await window.api.memoryFactsConfirm({ id })
      set((state) => ({
        facts: state.facts.map((f) => (f.id === id ? confirmed : f))
      }))
    } catch (error) {
      rendererLog.error('Failed to confirm fact:', error)
    }
  },

  deleteFact: async (id) => {
    try {
      await window.api.memoryFactsDelete({ id })
      set((state) => ({
        facts: state.facts.filter((f) => f.id !== id)
      }))
    } catch (error) {
      rendererLog.error('Failed to delete fact:', error)
    }
  },

  updateFact: async (id, params) => {
    try {
      const updated = await window.api.memoryFactsUpdate({ id, ...params })
      set((state) => ({
        facts: state.facts.map((f) => (f.id === id ? updated : f))
      }))
    } catch (error) {
      rendererLog.error('Failed to update fact:', error)
    }
  },

  // ── Scope toggle ──

  toggleScope: async (id, global, workspaceId) => {
    try {
      const updated = await window.api.memoryFactsScopeToggle({ id, global, workspaceId })
      set((state) => ({
        facts: state.facts.map((f) => (f.id === id ? updated : f))
      }))
    } catch (error) {
      rendererLog.error('Failed to toggle scope:', error)
    }
  },

  // ── Contradictions ──

  loadContradictions: async (status, page = 0) => {
    try {
      const PAGE_SIZE = 25
      const result = await window.api.memoryContradictionsList({
        status,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE
      })
      set({
        contradictions: result.items,
        contradictionsPage: page,
        contradictionsTotal: result.total,
        contradictionsPendingCount: result.pendingCount
      })
    } catch (error) {
      rendererLog.error('Failed to load contradictions:', error)
    }
  },

  resolveContradiction: async (id, resolution, keepFactId, archiveFactId) => {
    try {
      await window.api.memoryContradictionsResolve({ id, resolution, keepFactId, archiveFactId })
      set((state) => {
        // `pendingCount` is only ever written by loadContradictions, so without
        // this the "N pending" readout stayed at N after triaging all N.
        const wasPending = state.contradictions.find((c) => c.id === id)?.status === 'pending'
        return {
          contradictions: state.contradictions.filter((c) => c.id !== id),
          contradictionsTotal: Math.max(0, state.contradictionsTotal - 1),
          contradictionsPendingCount: wasPending
            ? Math.max(0, state.contradictionsPendingCount - 1)
            : state.contradictionsPendingCount
        }
      })
    } catch (error) {
      rendererLog.error('Failed to resolve contradiction:', error)
    }
  },

  autoResolveDuplicates: async (workspaceId, minCosine = 0.95) => {
    try {
      const result = await window.api.memoryDedupAutoresolve({ workspaceId, minCosine })
      await useMemoryStore.getState().loadContradictions()
      return result
    } catch (error) {
      rendererLog.error('Failed to auto-resolve duplicates:', error)
      return { resolvedCount: 0 }
    }
  },

  loadClaudeMd: async (workspacePath) => {
    try {
      set({ claudeMdLoading: true })
      const result = await window.api.memoryReadClaudeMd({ workspacePath })
      set({ claudeMdContent: result.content, claudeMdPath: result.path, claudeMdLoading: false })
    } catch (error) {
      rendererLog.error('Failed to load CLAUDE.md:', error)
      set({ claudeMdLoading: false })
    }
  },

  // ── Capture settings ──

  loadCaptureSettings: async (workspaceId) => {
    try {
      const captureSettings = await window.api.memoryCaptureSettingsGet({ workspaceId })
      set({ captureSettings })
    } catch (error) {
      rendererLog.error('Failed to load capture settings:', error)
    }
  },

  updateCaptureSettings: async (workspaceId, settings) => {
    try {
      await window.api.memoryCaptureSettingsSet({ workspaceId, settings })
      set((state) => ({
        captureSettings: state.captureSettings ? { ...state.captureSettings, ...settings } : null
      }))
    } catch (error) {
      rendererLog.error('Failed to update capture settings:', error)
    }
  },

  // ── Embedding status ──

  loadEmbeddingStatus: async (workspaceId) => {
    try {
      const embeddingStatus = await window.api.memoryEmbeddingStatus({ workspaceId })
      set({ embeddingStatus })
    } catch (error) {
      rendererLog.error('Failed to load embedding status:', error)
    }
  },

  triggerBackfill: async (workspaceId) => {
    let unsubscribe: (() => void) | null = null
    try {
      set({ backfillProgress: { running: true, processed: 0, total: 0 }, backfillError: null })

      // Subscribe to progress events
      unsubscribe = window.api.onMemoryEmbeddingProgress((data) => {
        if (data.done) {
          if (data.error) {
            // Provider init or backfill failed — surface the real message
            set({ backfillProgress: null, backfillError: data.error })
          } else {
            // Success — refresh status, then clear progress after 2s
            useMemoryStore.getState().loadEmbeddingStatus(workspaceId)
            setTimeout(() => set({ backfillProgress: null }), 2000)
          }
          unsubscribe?.()
          unsubscribe = null
        } else {
          set({ backfillProgress: { running: true, processed: data.processed, total: data.total } })
        }
      })

      const result = await window.api.memoryEmbeddingBackfill()
      // Belt-and-braces: if the invoke returned an error but no progress event fired
      if (result.error && !useMemoryStore.getState().backfillError) {
        set({ backfillProgress: null, backfillError: result.error })
      }
    } catch (error) {
      rendererLog.error('Failed to trigger backfill:', error)
      set({ backfillProgress: null, backfillError: 'Embedding backfill failed unexpectedly' })
    } finally {
      // Ensure listener is always cleaned up
      unsubscribe?.()
    }
  },

  clearBackfillError: () => set({ backfillError: null }),

  // ── Dedup ──

  scanForDuplicates: async (workspaceId) => {
    try {
      const result = await window.api.memoryDedupScan({ workspaceId })
      // Refresh contradictions to show newly found duplicates
      await useMemoryStore.getState().loadContradictions()
      return result
    } catch (error) {
      rendererLog.error('Failed to scan for duplicates:', error)
      return { clustersFound: 0, autoMerged: 0 }
    }
  },

  runConsolidation: async (workspaceId) => {
    try {
      const result = await window.api.memoryConsolidate({ workspaceId })
      // Refresh facts + contradictions after consolidation
      await useMemoryStore.getState().loadFacts(workspaceId)
      await useMemoryStore.getState().loadContradictions()
      return result
    } catch (error) {
      rendererLog.error('Failed to run consolidation:', error)
      return { clustersFound: 0, autoMerged: 0, staleArchived: 0 }
    }
  },

  // ── Search ──

  setSearchQuery: (query) => set({ searchQuery: query }),

  // ── Feed (retained) ──

  startFeed: (source) => {
    set({ feedStatus: 'running', feedSource: source, feedMessage: 'Starting...', feedError: null })
  },

  onFeedProgress: (progress) => {
    if (progress.status === 'error') {
      set({ feedStatus: 'error', feedError: progress.message })
    } else if (progress.status === 'done') {
      set({
        feedStatus: 'completed',
        feedMessage: progress.message,
        feedSource: progress.source as FeedSource
      })
    } else {
      set({ feedMessage: progress.message })
    }
  },

  cancelFeed: () => {
    window.api.memoryFeedCancel().catch(() => {})
    set({ feedStatus: 'idle', feedSource: null, feedMessage: null, feedError: null })
  },

  dismissFeed: () => {
    set({ feedStatus: 'idle', feedSource: null, feedMessage: null, feedError: null })
  },

  // ── Document Ingestion ──

  startIngestion: async (workspaceId, workspacePath, files) => {
    // Subscribe to progress events
    const cleanup = window.api.onMemoryIngestProgress((progress: IngestionProgress) => {
      useMemoryStore.getState().onIngestionProgress(progress)
    })
    set({ ingestionCleanup: cleanup })

    try {
      await window.api.memoryIngestDocuments({ files, workspaceId, workspacePath })
    } catch (error) {
      rendererLog.error('Ingestion failed:', error)
    }

    // Refresh facts after ingestion
    await useMemoryStore.getState().loadFacts(workspaceId)
  },

  onIngestionProgress: (progress) => {
    set({ ingestion: progress })
    if (
      progress.jobStatus === 'done' ||
      progress.jobStatus === 'cancelled' ||
      progress.jobStatus === 'error'
    ) {
      // Clean up listener after job completes
      const { ingestionCleanup } = useMemoryStore.getState()
      ingestionCleanup?.()
      set({ ingestionCleanup: null })
    }
  },

  cancelIngestion: () => {
    const { ingestion, ingestionCleanup } = useMemoryStore.getState()
    if (ingestion?.jobId) {
      window.api.memoryIngestCancel({ jobId: ingestion.jobId }).catch(() => {})
    }
    ingestionCleanup?.()
    set({ ingestion: null, ingestionCleanup: null })
  },

  dismissIngestion: () => {
    const { ingestionCleanup } = useMemoryStore.getState()
    ingestionCleanup?.()
    set({ ingestion: null, ingestionCleanup: null })
  },

  // ── Project Knowledge Bootstrap ──

  startBootstrap: async (workspaceId, workspacePath, mode = 'full', force = false, scope) => {
    try {
      const { runId } = await window.api.memoryBootstrapStart({
        workspaceId,
        workspacePath,
        mode,
        force,
        scope
      })
      await useMemoryStore.getState().loadBootstrapItems(runId)
    } catch (error) {
      rendererLog.error('Bootstrap failed:', error)
    }

    // Refresh facts after bootstrap
    await useMemoryStore.getState().loadFacts(workspaceId)
  },

  pauseBootstrap: async (workspaceId) => {
    try {
      await window.api.memoryBootstrapPause({ workspaceId })
    } catch (error) {
      rendererLog.error('Pause bootstrap failed:', error)
    }
  },

  resumeBootstrap: async (runId, workspacePath) => {
    try {
      await window.api.memoryBootstrapResume({ runId, workspacePath })
    } catch (error) {
      rendererLog.error('Resume bootstrap failed:', error)
    }
    const viewedWsId = useWorkspaceStore.getState().activeWorkspace?.id
    if (viewedWsId) await useMemoryStore.getState().loadFacts(viewedWsId)
  },

  onBootstrapProgress: (progress) => {
    const { bootstrapByWorkspace } = useMemoryStore.getState()

    set({
      bootstrapByWorkspace: { ...bootstrapByWorkspace, [progress.workspaceId]: progress }
    })

    // Only drive the page-level view with the workspace the user is looking at;
    // background workspaces still update bootstrapByWorkspace for the status bar.
    // Scoped off the active workspace rather than "wherever Start was last
    // clicked" — the latter is null until the user starts a run in this session
    // (letting any workspace's events drive the page) and goes stale the moment
    // they switch workspaces.
    const viewedWsId = useWorkspaceStore.getState().activeWorkspace?.id ?? null
    if (progress.workspaceId === viewedWsId) {
      set({ bootstrap: progress })
    }

    const terminal =
      progress.jobStatus === 'done' ||
      progress.jobStatus === 'cancelled' ||
      progress.jobStatus === 'error' ||
      progress.jobStatus === 'paused'

    if (terminal) {
      useMemoryStore.getState().loadBootstrapSnapshot(progress.workspaceId)
      useMemoryStore.getState().loadBootstrapItems(progress.runId)

      if (progress.jobStatus === 'done') {
        useMemoryStore.getState().loadFacts(progress.workspaceId)
        useMemoryStore.getState().loadContradictions()
      }
    }
  },

  loadBootstrapSnapshot: async (workspaceId) => {
    try {
      const snap = await window.api.memoryBootstrapSnapshot({ workspaceId })

      if (snap.progress) {
        const { bootstrapByWorkspace } = useMemoryStore.getState()
        set({
          bootstrapByWorkspace: { ...bootstrapByWorkspace, [workspaceId]: snap.progress }
        })
      }

      // The page-level fields only ever describe the workspace on screen, and
      // `bootstrap` is cleared when that workspace has no live run — see
      // bootstrapSnapshotPatch.
      const viewedWsId = useWorkspaceStore.getState().activeWorkspace?.id ?? null
      const patch = bootstrapSnapshotPatch(snap, workspaceId, viewedWsId)
      if (patch) set(patch)
    } catch (error) {
      rendererLog.error('Load bootstrap snapshot failed:', error)
    }
  },

  loadBootstrapItems: async (runId, options = {}) => {
    try {
      const filter = options.status ?? useMemoryStore.getState().bootstrapItemFilter
      const { items, total } = await window.api.memoryBootstrapListItems({
        runId,
        status: filter === 'all' ? undefined : filter,
        limit: options.limit ?? 200,
        offset: options.offset ?? 0
      })
      set({ bootstrapItems: items, bootstrapItemsTotal: total })
    } catch (error) {
      rendererLog.error('Load bootstrap items failed:', error)
    }
  },

  setBootstrapItemFilter: (filter) => {
    set({ bootstrapItemFilter: filter })
    const { bootstrap, bootstrapLatestRun } = useMemoryStore.getState()
    const runId = bootstrap?.runId ?? bootstrapLatestRun?.id
    if (runId) useMemoryStore.getState().loadBootstrapItems(runId, { status: filter })
  },

  cancelBootstrap: () => {
    const { bootstrap } = useMemoryStore.getState()
    if (bootstrap?.jobId) {
      window.api.memoryBootstrapCancel({ jobId: bootstrap.jobId }).catch(() => {})
    }
  },

  /**
   * Seed a workspace's live state from a snapshot, for runs that were already
   * in flight before anything subscribed. Live events always win, so this never
   * overwrites an entry that the progress channel is already driving.
   */
  seedBootstrapProgress: (progress) => {
    const { bootstrapByWorkspace } = useMemoryStore.getState()
    if (bootstrapByWorkspace[progress.workspaceId]) return
    set({
      bootstrapByWorkspace: { ...bootstrapByWorkspace, [progress.workspaceId]: progress }
    })
  },

  dismissBootstrap: (workspaceId) => {
    const { bootstrap, bootstrapByWorkspace } = useMemoryStore.getState()
    const id = workspaceId ?? bootstrap?.workspaceId
    if (!id) {
      set({ bootstrap: null })
      return
    }
    // Clearing only `bootstrap` left the entry in the per-workspace map, so a
    // failed run kept the status-bar Brain indicator red until the next app
    // restart. Dismiss has to drop both.
    const next = { ...bootstrapByWorkspace }
    delete next[id]
    set({ bootstrap: null, bootstrapByWorkspace: next })
  }
}))

/**
 * Module-level progress subscription.
 *
 * Deliberately NOT created inside `startBootstrap`. Subscribing there meant a
 * run was only observable while the user sat on the page that started it —
 * navigating away made an in-flight ingestion invisible, and a run started in
 * another workspace was never seen at all. One subscription for the app's
 * lifetime is what lets the status bar report background runs.
 */
if (typeof window !== 'undefined' && window.api?.onMemoryBootstrapProgress) {
  window.api.onMemoryBootstrapProgress((progress: BootstrapProgress) => {
    useMemoryStore.getState().onBootstrapProgress(progress)
  })
}
