import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'
import type { DocFile } from '../../../shared/types'

interface DocsState {
  docs: DocFile[]
  selectedDoc: DocFile | null
  docContent: string | null
  isLoading: boolean
  error: string | null

  loadDocs: (workspacePath: string) => Promise<void>
  selectDoc: (doc: DocFile | null) => void
  loadDocContent: (doc: DocFile) => Promise<void>
  reset: () => void
}

export const useDocsStore = create<DocsState>((set) => ({
  docs: [],
  selectedDoc: null,
  docContent: null,
  isLoading: false,
  error: null,

  loadDocs: async (workspacePath) => {
    set({ isLoading: true, error: null })
    try {
      const docs = await window.api.listDocs({ workspacePath })
      set({ docs, isLoading: false })
    } catch (error) {
      rendererLog.error('Failed to load docs:', error)
      set({ isLoading: false, error: (error as Error).message })
    }
  },

  selectDoc: (doc) => set({ selectedDoc: doc, docContent: null }),

  loadDocContent: async (doc) => {
    set({ isLoading: true })
    try {
      const content = await window.api.readDocFile({ filePath: doc.path })
      set({ docContent: content, isLoading: false })
    } catch (error) {
      set({ isLoading: false, error: (error as Error).message })
    }
  },

  reset: () => set({ docs: [], selectedDoc: null, docContent: null, isLoading: false, error: null })
}))
