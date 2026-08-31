import { create } from 'zustand'

export type ChatTab = 'chat' | 'code-changes' | 'files'

interface ChatUiState {
  /** Active chat panel tab — shared so tool rows anywhere can switch to Files. */
  activeTab: ChatTab
  setActiveTab: (tab: ChatTab) => void
}

export const useChatUiStore = create<ChatUiState>()((set) => ({
  activeTab: 'chat',
  setActiveTab: (tab) => set({ activeTab: tab })
}))
