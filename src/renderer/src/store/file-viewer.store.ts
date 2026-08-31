import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'
import { useWorkspaceStore } from './workspace.store'

/** Context identifying which tree a file was opened against. */
export interface FileViewerCtx {
  conversationId?: string
  blueprintId?: string
  workspacePath?: string
}

export interface RecentFile {
  path: string
  /** Context the file was opened under — needed to re-read on click. */
  ctx: FileViewerCtx
}

interface FileViewerState {
  /** Currently open file path (workspace-relative or absolute — as passed). */
  activeFile: string | null
  /** Context the active file was opened under. */
  ctx: FileViewerCtx | null
  content: string
  loading: boolean
  /** Error message when the read failed (not found / binary / too large / denied). */
  error: string | null
  /** Most recent files, newest first — capped. */
  recentFiles: RecentFile[]
  /** Whether the viewer panel should be visible (drawer/tab open). */
  isOpen: boolean
}

interface FileViewerActions {
  openFile: (path: string, ctx: FileViewerCtx) => Promise<void>
  close: () => void
  clear: () => void
}

const MAX_RECENT = 10

// Monotonic request id — clicking file A then B fast must not render A's
// content under B's header when A's response lands last.
let requestId = 0

export const useFileViewerStore = create<FileViewerState & FileViewerActions>()((set, get) => ({
  activeFile: null,
  ctx: null,
  content: '',
  loading: false,
  error: null,
  recentFiles: [],
  isOpen: false,

  openFile: async (path, ctx): Promise<void> => {
    const id = ++requestId
    set({ activeFile: path, ctx, content: '', error: null, loading: true, isOpen: true })

    // Update recents immediately — even a failed read is a file the user tried
    // to open, and dedup keeps the list stable.
    const recentFiles = [{ path, ctx }, ...get().recentFiles.filter((f) => f.path !== path)].slice(
      0,
      MAX_RECENT
    )
    set({ recentFiles })

    try {
      const result = await window.api.filesViewerRead({ ...ctx, filePath: path })
      if (id !== requestId) return
      set({ content: result.content, loading: false })
    } catch (e) {
      if (id !== requestId) return
      const msg = e instanceof Error ? e.message : 'Failed to read file'
      rendererLog.error('fileViewer openFile failed:', msg)
      set({ loading: false, error: msg })
    }
  },

  close: (): void => set({ isOpen: false }),

  clear: (): void => set({ activeFile: null, ctx: null, content: '', error: null, loading: false })
}))

// Recents are scoped to the active workspace: files opened in one workspace's
// tracks (worktrees) are unreadable from another, so a stale list is a row of
// dead buttons. Clear on switch — the list only ever holds the current
// workspace's files, which is the keying the Files tab needs.
let lastWorkspaceId: string | null = null
useWorkspaceStore.subscribe((state) => {
  const id = state.activeWorkspace?.id ?? null
  if (id !== lastWorkspaceId) {
    lastWorkspaceId = id
    useFileViewerStore.setState({ recentFiles: [] })
  }
})
