import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'
import { describeLoadFilesError } from './code-changes-errors'
import type { DiffComparisonMode, FileDiffResult } from '../../../shared/types'

export interface FileChangeDetail {
  filePath: string
  changeType: 'created' | 'modified' | 'deleted'
  staged: boolean
  /** Rename source — the old side lives at this path, not at filePath. */
  oldPath?: string
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
  /** Fully-qualified comparison ref — `origin/<b>` for remotes, `<b>` for local branches. */
  targetBranch: string
  availableBranches: { local: string[]; remote: string[] }
  /** Workspace whose branches are loaded — the key the chosen target is remembered under. */
  workspaceId: string | null

  // Commit
  commitMessage: string
  isCommitting: boolean
  isGeneratingMessage: boolean

  // Push status
  pushStatus: { branch: string; commitsAhead: number; hasRemote: boolean } | null
  isPushing: boolean

  // Fetch
  isFetching: boolean

  // Error — commit / push / fetch / generate / diff. Deliberately NOT the file
  // listing: a failed push must not make the left pane claim it can't list what
  // will ship.
  error: string | null
  /** Listing failure only — the one error an empty file list may be explained by. */
  filesError: string | null
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
  targetBranch: 'origin/main',
  availableBranches: { local: [], remote: [] },
  workspaceId: null,
  commitMessage: '',
  isCommitting: false,
  isGeneratingMessage: false,
  pushStatus: null,
  isPushing: false,
  isFetching: false,
  error: null,
  filesError: null
}

const TARGET_BRANCH_KEY_PREFIX = 'codeChanges.targetBranch.'

/** Remembered comparison target for a workspace — localStorage may be unavailable. */
function readStoredTarget(workspaceId: string): string | null {
  try {
    return localStorage.getItem(`${TARGET_BRANCH_KEY_PREFIX}${workspaceId}`)
  } catch {
    return null
  }
}

function writeStoredTarget(workspaceId: string, branch: string): void {
  try {
    localStorage.setItem(`${TARGET_BRANCH_KEY_PREFIX}${workspaceId}`, branch)
  } catch {
    // localStorage may be unavailable
  }
}

// Monotonic request ids — clicking file A then B fast enough lands A's response
// last, rendering A's content under B's filename. Stale responses are dropped.
let filesRequestId = 0
let diffRequestId = 0

export const useCodeChangesStore = create<CodeChangesState & CodeChangesActions>()((set, get) => ({
  ...initialState,

  loadFiles: async (conversationId: string): Promise<void> => {
    const requestId = ++filesRequestId
    set({ isLoadingFiles: true, filesError: null })
    try {
      const { comparisonMode, targetBranch } = get()
      let files: FileChangeDetail[]

      if (comparisonMode === 'uncommitted') {
        files = await window.api.getFileDetails({ conversationId })
      } else {
        // targetBranch is already fully qualified — local branches carry no prefix.
        const fromRef = targetBranch
        const toRef = comparisonMode === 'branch-vs-target' ? 'HEAD' : 'WORKING_TREE'
        files = await window.api.getRefFileDetails({ conversationId, fromRef, toRef })
      }

      if (requestId !== filesRequestId) return
      set({ files, isLoadingFiles: false })

      // Auto-deselect files that no longer exist
      const currentPaths = new Set(files.map((f) => f.filePath))
      const { checkedFiles, selectedFile } = get()
      const newChecked = new Set([...checkedFiles].filter((fp) => currentPaths.has(fp)))
      const newSelected = selectedFile && currentPaths.has(selectedFile) ? selectedFile : null
      set({ checkedFiles: newChecked, selectedFile: newSelected })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load file details'
      if (requestId !== filesRequestId) return
      rendererLog.error('loadFiles failed:', msg)
      const { error, clearFiles } = describeLoadFilesError(msg)
      set({ isLoadingFiles: false, filesError: error, ...(clearFiles ? { files: [] } : {}) })
    }
  },

  selectFile: async (conversationId: string, filePath: string | null): Promise<void> => {
    const requestId = ++diffRequestId
    set({ selectedFile: filePath, currentDiff: null })
    if (!filePath) return

    // Clear like every other operation does on start — loadFiles no longer owns
    // this bucket, so a stale diff error would otherwise never go away.
    set({ isLoadingDiff: true, error: null })
    try {
      const { comparisonMode, targetBranch, files } = get()
      let diff: FileDiffResult

      // Renamed files need their source path, or the old side is looked up at the
      // new path, comes back empty, and the file renders as a 100% addition.
      const oldPath = files.find((f) => f.filePath === filePath)?.oldPath

      if (comparisonMode === 'uncommitted') {
        diff = await window.api.getFileDiff({ conversationId, filePath, oldPath })
      } else {
        const fromRef = targetBranch
        const toRef = comparisonMode === 'branch-vs-target' ? 'HEAD' : 'WORKING_TREE'
        diff = await window.api.getRefFileDiff({
          conversationId,
          filePath,
          fromRef,
          toRef,
          oldPath
        })
      }

      if (requestId !== diffRequestId) return
      set({ currentDiff: diff, isLoadingDiff: false })
    } catch (e) {
      if (requestId !== diffRequestId) return
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
    const { comparisonMode, workspaceId } = get()
    if (workspaceId) writeStoredTarget(workspaceId, branch)
    set({ targetBranch: branch, selectedFile: null, currentDiff: null })
    if (comparisonMode !== 'uncommitted') {
      set({ files: [], isLoadingFiles: true })
      void get().loadFiles(conversationId)
    }
  },

  loadBranches: async (workspaceId: string): Promise<void> => {
    try {
      const result = await window.api.listBranches({ workspaceId })
      set({ availableBranches: { local: result.local, remote: result.remote }, workspaceId })

      // targetBranch is stored fully qualified so a local branch can be a target too.
      const qualifiedRemotes = result.remote.map((b) => `origin/${b}`)
      const known = new Set([...qualifiedRemotes, ...result.local])
      const { targetBranch } = get()

      // A target chosen for this workspace survives remount — otherwise `develop`
      // silently reverts to `origin/main` and the answer changes underneath you.
      const remembered = readStoredTarget(workspaceId)
      if (remembered && known.has(remembered)) {
        if (remembered !== targetBranch) set({ targetBranch: remembered })
        return
      }

      // Only auto-pick when the current target isn't a real ref — re-running this
      // (mount, post-fetch) must not clobber a target the user chose.
      if (!known.has(targetBranch) && known.size > 0) {
        const preferred = known.has('origin/main')
          ? 'origin/main'
          : known.has('origin/master')
            ? 'origin/master'
            : (qualifiedRemotes[0] ?? result.local[0])
        set({ targetBranch: preferred })
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
      targetBranch: 'origin/main',
      availableBranches: { local: [], remote: [] },
      workspaceId: null,
      selectedFile: null,
      currentDiff: null,
      checkedFiles: new Set(),
      files: [],
      error: null,
      filesError: null,
      pushStatus: null,
      commitMessage: '',
      isGeneratingMessage: false
    })
  },

  reset: (): void => {
    set(initialState)
  }
}))
