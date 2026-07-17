import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'
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
  BootstrapMode
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
  contradictions: MemoryContradiction[]
  contradictionsPage: number
  contradictionsTotal: number
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
    params: { title?: string; content?: string; tags?: string[]; scopePaths?: string[]; category?: MemoryFactCategory }
  ) => Promise<void>

  // Scope toggle
  toggleScope: (id: string, global: boolean, workspaceId?: string) => Promise<void>

  // Contradiction actions
  loadContradictions: (status?: string, page?: number) => Promise<void>
  resolveContradiction: (id: string, resolution: string, keepFactId: string, archiveFactId?: string) => Promise<void>
  autoResolveDuplicates: (workspaceId: string, minCosine?: number) => Promise<{ resolvedCount: number }>

  // CLAUDE.md actions
  loadClaudeMd: (workspacePath: string) => Promise<void>

  // Capture settings
  loadCaptureSettings: (workspaceId: string) => Promise<void>
  updateCaptureSettings: (workspaceId: string, settings: Partial<MemoryCaptureSettings>) => Promise<void>

  // Embedding actions
  loadEmbeddingStatus: (workspaceId: string) => Promise<void>
  triggerBackfill: (workspaceId: string) => Promise<void>
  clearBackfillError: () => void

  // Dedup & Consolidation
  scanForDuplicates: (workspaceId: string) => Promise<{ clustersFound: number; autoMerged: number }>
  runConsolidation: (workspaceId: string) => Promise<{ clustersFound: number; autoMerged: number; staleArchived: number }>

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
  bootstrapCleanup: (() => void) | null
  startBootstrap: (workspaceId: string, workspacePath: string, mode?: BootstrapMode) => Promise<void>
  cancelBootstrap: () => void
  dismissBootstrap: () => void
  onBootstrapProgress: (progress: BootstrapProgress) => void
}

export const useMemoryStore = create<MemoryState>((set) => ({
  facts: [],
  contradictions: [],
  contradictionsPage: 0,
  contradictionsTotal: 0,
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
  bootstrapCleanup: null,

  // ── Fact actions ──

  loadFacts: async (workspaceId) => {
    try {
      const facts = await window.api.memoryFactsList({ workspaceId })
      set({ facts })
    } catch (error) {
      rendererLog.error('Failed to load facts:', error)
    }
  },

  searchFacts: async (workspaceId, query, category) => {
    try {
      const facts = await window.api.memoryFactsSearch({ workspaceId, query, category })
      set({ facts, searchQuery: query })
    } catch (error) {
      rendererLog.error('Failed to search facts:', error)
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
        status: status as any,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE
      })
      set({ contradictions: result.items, contradictionsPage: page, contradictionsTotal: result.total })
    } catch (error) {
      rendererLog.error('Failed to load contradictions:', error)
    }
  },

  resolveContradiction: async (id, resolution, keepFactId, archiveFactId) => {
    try {
      await window.api.memoryContradictionsResolve({ id, resolution, keepFactId, archiveFactId })
      set((state) => ({
        contradictions: state.contradictions.filter((c) => c.id !== id),
        contradictionsTotal: Math.max(0, state.contradictionsTotal - 1)
      }))
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
        captureSettings: state.captureSettings
          ? { ...state.captureSettings, ...settings }
          : null
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
      set({ feedStatus: 'completed', feedMessage: progress.message, feedSource: progress.source as FeedSource })
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
    if (progress.jobStatus === 'done' || progress.jobStatus === 'cancelled' || progress.jobStatus === 'error') {
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

  startBootstrap: async (workspaceId, workspacePath, mode = 'full') => {
    // Subscribe to progress events
    const cleanup = window.api.onMemoryBootstrapProgress((progress: BootstrapProgress) => {
      useMemoryStore.getState().onBootstrapProgress(progress)
    })
    set({ bootstrapCleanup: cleanup })

    try {
      await window.api.memoryBootstrapStart({ workspaceId, workspacePath, mode })
    } catch (error) {
      rendererLog.error('Bootstrap failed:', error)
    }

    // Refresh facts after bootstrap
    await useMemoryStore.getState().loadFacts(workspaceId)
  },

  onBootstrapProgress: (progress) => {
    set({ bootstrap: progress })
    if (progress.jobStatus === 'done' || progress.jobStatus === 'cancelled' || progress.jobStatus === 'error') {
      const { bootstrapCleanup } = useMemoryStore.getState()
      bootstrapCleanup?.()
      set({ bootstrapCleanup: null })
    }
  },

  cancelBootstrap: () => {
    const { bootstrap, bootstrapCleanup } = useMemoryStore.getState()
    if (bootstrap?.jobId) {
      window.api.memoryBootstrapCancel({ jobId: bootstrap.jobId }).catch(() => {})
    }
    bootstrapCleanup?.()
    set({ bootstrap: null, bootstrapCleanup: null })
  },

  dismissBootstrap: () => {
    const { bootstrapCleanup } = useMemoryStore.getState()
    bootstrapCleanup?.()
    set({ bootstrap: null, bootstrapCleanup: null })
  }
}))
