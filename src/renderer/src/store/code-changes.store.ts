import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'

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
  currentDiff: { oldContent: string; newContent: string; language: string } | null
  isLoadingDiff: boolean

  // Commit
  commitMessage: string
  isCommitting: boolean
  isGeneratingMessage: boolean

  // Push status
  pushStatus: { branch: string; commitsAhead: number; hasRemote: boolean } | null
  isPushing: boolean

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
  reset: () => void
}

const initialState: CodeChangesState = {
  files: [],
  selectedFile: null,
  checkedFiles: new Set(),
  isLoadingFiles: false,
  currentDiff: null,
  isLoadingDiff: false,
  commitMessage: '',
  isCommitting: false,
  isGeneratingMessage: false,
  pushStatus: null,
  isPushing: false,
  error: null
}

export const useCodeChangesStore = create<CodeChangesState & CodeChangesActions>()((set, get) => ({
  ...initialState,

  loadFiles: async (conversationId: string): Promise<void> => {
    set({ isLoadingFiles: true, error: null })
    try {
      const files = await window.api.getFileDetails({ conversationId })
      set({ files, isLoadingFiles: false })

      // Auto-deselect files that no longer exist
      const currentPaths = new Set(files.map((f) => f.filePath))
      const { checkedFiles, selectedFile } = get()
      const newChecked = new Set([...checkedFiles].filter((fp) => currentPaths.has(fp)))
      const newSelected = selectedFile && currentPaths.has(selectedFile) ? selectedFile : null
      set({ checkedFiles: newChecked, selectedFile: newSelected })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load file details'
      rendererLog.error('loadFiles failed:', msg)
      set({ isLoadingFiles: false, error: msg })
    }
  },

  selectFile: async (conversationId: string, filePath: string | null): Promise<void> => {
    set({ selectedFile: filePath, currentDiff: null })
    if (!filePath) return

    set({ isLoadingDiff: true })
    try {
      const diff = await window.api.getFileDiff({ conversationId, filePath })
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
    const filePaths = checkedFiles.size > 0
      ? [...checkedFiles]
      : files.map((f) => f.filePath)
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

  reset: (): void => {
    set(initialState)
  }
}))

// ── Selector hooks ──
export const useCodeChangesFiles = (): FileChangeDetail[] =>
  useCodeChangesStore((s) => s.files)

export const useCodeChangesSelectedFile = (): string | null =>
  useCodeChangesStore((s) => s.selectedFile)

export const useCodeChangesPushStatus = (): CodeChangesState['pushStatus'] =>
  useCodeChangesStore((s) => s.pushStatus)
