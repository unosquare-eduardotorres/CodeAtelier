import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'
import type { DiffComparisonMode, FileDiffResult } from '../../../shared/types'

export interface FileChangeDetail {
  filePath: string
  changeType: 'created' | 'modified' | 'deleted'
  staged: boolean
}

interface CodeChangesState {
  // File list
  files: FileChangeDetail[]
  selectedFile: string | null
  checkedFiles: Set<string>
  isLoadingFiles: boolean

  // Diff
  currentDiff: FileDiffResult | null
  isLoadingDiff: boolean

  // Comparison mode
  comparisonMode: DiffComparisonMode
  targetBranch: string
  availableBranches: { local: string[]; remote: string[] }

  // Commit
  commitMessage: string
  isCommitting: boolean
  isGeneratingMessage: boolean

  // Push status
  pushStatus: { branch: string; commitsAhead: number; hasRemote: boolean } | null
  isPushing: boolean

  // Fetch
  isFetching: boolean

  // Error
  error: string | null
}

interface CodeChangesActions {
  loadFiles: (conversationId: string) => Promise<void>
  selectFile: (conversationId: string, filePath: string | null) => Promise<void>
  toggleCheck: (filePath: string) => void
  selectAll: () => void
  deselectAll: () => void
  setCommitMessage: (message: string) => void
  generateCommitMessage: (conversationId: string) => Promise<void>
  commitSelected: (conversationId: string) => Promise<void>
  commitAll: (conversationId: string) => Promise<void>
  push: (conversationId: string) => Promise<void>
  refreshPushStatus: (conversationId: string) => Promise<void>
  setComparisonMode: (mode: DiffComparisonMode, conversationId: string) => void
  setTargetBranch: (branch: string, conversationId: string) => void
  loadBranches: (workspaceId: string) => Promise<void>
  fetchAndRefresh: (conversationId: string, workspaceId: string) => Promise<void>
  resetComparison: () => void
  reset: () => void
}

const initialState: CodeChangesState = {
  files: [],
  selectedFile: null,
  checkedFiles: new Set(),
  isLoadingFiles: false,
  currentDiff: null,
  isLoadingDiff: false,
  comparisonMode: 'uncommitted',
  targetBranch: 'main',
  availableBranches: { local: [], remote: [] },
  commitMessage: '',
  isCommitting: false,
  isGeneratingMessage: false,
  pushStatus: null,
  isPushing: false,
  isFetching: false,
  error: null
}

export const useCodeChangesStore = create<CodeChangesState & CodeChangesActions>()((set, get) => ({
  ...initialState,

  loadFiles: async (conversationId: string): Promise<void> => {
    set({ isLoadingFiles: true, error: null })
    try {
      const { comparisonMode, targetBranch } = get()
      let files: FileChangeDetail[]

      if (comparisonMode === 'uncommitted') {
        files = await window.api.getFileDetails({ conversationId })
      } else {
        const fromRef = `origin/${targetBranch}`
        const toRef = comparisonMode === 'branch-vs-target' ? 'HEAD' : 'WORKING_TREE'
        files = await window.api.getRefFileDetails({ conversationId, fromRef, toRef })
      }

      set({ files, isLoadingFiles: false })

      // Auto-deselect files that no longer exist
      const currentPaths = new Set(files.map((f) => f.filePath))
      const { checkedFiles, selectedFile } = get()
      const newChecked = new Set([...checkedFiles].filter((fp) => currentPaths.has(fp)))
      const newSelected = selectedFile && currentPaths.has(selectedFile) ? selectedFile : null
      set({ checkedFiles: newChecked, selectedFile: newSelected })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load file details'
      if (msg.startsWith('REF_NOT_FOUND:')) {
        set({ isLoadingFiles: false, error: `Remote branch not found — has it been pushed? (${msg.replace('REF_NOT_FOUND: ', '')})` })
      } else {
        rendererLog.error('loadFiles failed:', msg)
        set({ isLoadingFiles: false, error: msg })
      }
    }
  },

  selectFile: async (conversationId: string, filePath: string | null): Promise<void> => {
    set({ selectedFile: filePath, currentDiff: null })
    if (!filePath) return

    set({ isLoadingDiff: true })
    try {
      const { comparisonMode, targetBranch } = get()
      let diff: FileDiffResult

      if (comparisonMode === 'uncommitted') {
        diff = await window.api.getFileDiff({ conversationId, filePath })
      } else {
        const fromRef = `origin/${targetBranch}`
        const toRef = comparisonMode === 'branch-vs-target' ? 'HEAD' : 'WORKING_TREE'
        diff = await window.api.getRefFileDiff({ conversationId, filePath, fromRef, toRef })
      }

      set({ currentDiff: diff, isLoadingDiff: false })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load diff'
      rendererLog.error('selectFile diff failed:', msg)
      set({ isLoadingDiff: false, error: msg })
    }
  },

  toggleCheck: (filePath: string): void => {
    const { checkedFiles } = get()
    const next = new Set(checkedFiles)
    if (next.has(filePath)) {
      next.delete(filePath)
    } else {
      next.add(filePath)
    }
    set({ checkedFiles: next })
  },

  selectAll: (): void => {
    const { files } = get()
    set({ checkedFiles: new Set(files.map((f) => f.filePath)) })
  },

  deselectAll: (): void => {
    set({ checkedFiles: new Set() })
  },

  setCommitMessage: (message: string): void => {
    set({ commitMessage: message })
  },

  generateCommitMessage: async (conversationId: string): Promise<void> => {
    const { checkedFiles, files } = get()
    const filePaths = checkedFiles.size > 0 ? [...checkedFiles] : files.map((f) => f.filePath)
    if (filePaths.length === 0) return

    set({ isGeneratingMessage: true, error: null })
    try {
      const { message } = await window.api.generateCommitMessage({ conversationId, filePaths })
      set({ commitMessage: message, isGeneratingMessage: false })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to generate commit message'
      rendererLog.error('generateCommitMessage failed:', msg)
      set({ isGeneratingMessage: false, error: msg })
    }
  },

  commitSelected: async (conversationId: string): Promise<void> => {
    const { checkedFiles, commitMessage } = get()
    if (checkedFiles.size === 0 || !commitMessage.trim()) return

    set({ isCommitting: true, error: null })
    try {
      await window.api.commitFiles({
        conversationId,
        filePaths: [...checkedFiles],
        message: commitMessage
      })
      set({ commitMessage: '', checkedFiles: new Set() })
      // Reload files to reflect committed state
      await get().loadFiles(conversationId)
      // Refresh push status
      await get().refreshPushStatus(conversationId)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Commit failed'
      rendererLog.error('commitSelected failed:', msg)
      set({ error: msg })
    } finally {
      set({ isCommitting: false })
    }
  },

  commitAll: async (conversationId: string): Promise<void> => {
    const { files, commitMessage } = get()
    if (files.length === 0 || !commitMessage.trim()) return

    set({ isCommitting: true, error: null })
    try {
      await window.api.commitFiles({
        conversationId,
        filePaths: files.map((f) => f.filePath),
        message: commitMessage
      })
      set({ commitMessage: '', checkedFiles: new Set() })
      await get().loadFiles(conversationId)
      await get().refreshPushStatus(conversationId)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Commit failed'
      rendererLog.error('commitAll failed:', msg)
      set({ error: msg })
    } finally {
      set({ isCommitting: false })
    }
  },

  push: async (conversationId: string): Promise<void> => {
    set({ isPushing: true, error: null })
    try {
      await window.api.repoPush({ conversationId })
      await get().refreshPushStatus(conversationId)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Push failed'
      rendererLog.error('push failed:', msg)
      set({ error: msg })
    } finally {
      set({ isPushing: false })
    }
  },

  refreshPushStatus: async (conversationId: string): Promise<void> => {
    try {
      const pushStatus = await window.api.getPushStatus({ conversationId })
      set({ pushStatus })
    } catch (e) {
      rendererLog.error('refreshPushStatus failed:', e)
    }
  },

  setComparisonMode: (mode: DiffComparisonMode, conversationId: string): void => {
    set({ comparisonMode: mode, selectedFile: null, currentDiff: null, checkedFiles: new Set(), files: [], isLoadingFiles: true })
    void get().loadFiles(conversationId)
  },

  setTargetBranch: (branch: string, conversationId: string): void => {
    const { comparisonMode } = get()
    set({ targetBranch: branch, selectedFile: null, currentDiff: null })
    if (comparisonMode !== 'uncommitted') {
      set({ files: [], isLoadingFiles: true })
      void get().loadFiles(conversationId)
    }
  },

  loadBranches: async (workspaceId: string): Promise<void> => {
    try {
      const result = await window.api.listBranches({ workspaceId })
      set({ availableBranches: { local: result.local, remote: result.remote } })

      // Auto-detect target branch: if remote has 'main' or 'master', use that
      const { targetBranch } = get()
      if (result.remote.length > 0) {
        if (result.remote.includes('main') && targetBranch !== 'main') {
          set({ targetBranch: 'main' })
        } else if (!result.remote.includes('main') && result.remote.includes('master')) {
          set({ targetBranch: 'master' })
        } else if (!result.remote.includes(targetBranch) && result.remote.length > 0) {
          // Current target doesn't exist on remote, pick first available
          set({ targetBranch: result.remote[0] })
        }
      }
    } catch (e) {
      rendererLog.error('loadBranches failed:', e)
    }
  },

  fetchAndRefresh: async (conversationId: string, workspaceId: string): Promise<void> => {
    set({ isFetching: true, error: null })
    try {
      const result = await window.api.fetchOrigin({ conversationId })
      // Refresh branches and file list regardless (fetch may have partially succeeded)
      await get().loadBranches(workspaceId)
      const { comparisonMode } = get()
      if (comparisonMode !== 'uncommitted') {
        await get().loadFiles(conversationId)
      }
      // Refresh push status — commits-ahead count may have changed after fetch
      await get().refreshPushStatus(conversationId)
      // Set fetch error AFTER sub-operations so loadFiles doesn't swallow it
      if (!result.fetched) {
        set({ error: result.error ?? 'Failed to fetch from origin' })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Fetch failed'
      set({ error: msg })
    } finally {
      set({ isFetching: false })
    }
  },

  resetComparison: (): void => {
    set({
      comparisonMode: 'uncommitted',
      targetBranch: 'main',
      availableBranches: { local: [], remote: [] },
      selectedFile: null,
      currentDiff: null,
      checkedFiles: new Set(),
      files: [],
      error: null,
      pushStatus: null,
      commitMessage: '',
      isGeneratingMessage: false
    })
  },

  reset: (): void => {
    set(initialState)
  }
}))
