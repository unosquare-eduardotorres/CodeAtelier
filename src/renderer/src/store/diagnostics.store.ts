import { create } from 'zustand'

export interface LspDiagnostic {
  file: string
  line: number
  severity: 'error' | 'warning' | 'info' | 'hint'
  message: string
  source?: string
}

interface DiagnosticsState {
  /** Per-conversation LSP diagnostics */
  diagnostics: Record<string, LspDiagnostic[]>
  /** Whether the diagnostics panel is expanded */
  expanded: boolean

  // Actions
  setDiagnostics: (conversationId: string, diagnostics: LspDiagnostic[]) => void
  clearDiagnostics: (conversationId: string) => void
  toggleExpanded: () => void
}

// Preserve Zustand state across HMR (dev only)
const previousState = import.meta.hot?.data?.diagnosticsStoreState as
  Partial<DiagnosticsState> | undefined

export const useDiagnosticsStore = create<DiagnosticsState>((set) => ({
  diagnostics: previousState?.diagnostics ?? {},
  expanded: previousState?.expanded ?? false,

  setDiagnostics: (conversationId: string, diagnostics: LspDiagnostic[]) => {
    set((state) => ({
      diagnostics: { ...state.diagnostics, [conversationId]: diagnostics }
    }))
  },

  clearDiagnostics: (conversationId: string) => {
    set((state) => {
      const { [conversationId]: _, ...rest } = state.diagnostics
      return { diagnostics: rest }
    })
  },

  toggleExpanded: () => {
    set((state) => ({ expanded: !state.expanded }))
  }
}))

// HMR state preservation
if (import.meta.hot) {
  import.meta.hot.dispose((data) => {
    data.diagnosticsStoreState = useDiagnosticsStore.getState()
  })
}
