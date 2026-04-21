import { create } from 'zustand'

type BottomPanelTab = 'agents' | 'office' | null

const STORAGE_KEY_HEIGHT = 'bottom-panel-height'
const DEFAULT_HEIGHT = 250
const MIN_HEIGHT = 120
const MAX_HEIGHT_RATIO = 0.5 // 50% of viewport

interface BottomPanelState {
  activeTab: BottomPanelTab // null = collapsed/hidden
  panelHeight: number
  isDragging: boolean

  openTab: (tab: 'agents' | 'office') => void
  closePanel: () => void
  toggleTab: (tab: 'agents' | 'office') => void
  setPanelHeight: (height: number) => void
  setDragging: (v: boolean) => void
}

function loadHeight(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_HEIGHT)
    if (stored) {
      const parsed = parseInt(stored, 10)
      if (!isNaN(parsed) && parsed >= MIN_HEIGHT) {
        return parsed
      }
    }
  } catch {
    // localStorage unavailable
  }
  return DEFAULT_HEIGHT
}

export const useBottomPanelStore = create<BottomPanelState>((set, get) => ({
  activeTab: null,
  panelHeight: loadHeight(),
  isDragging: false,

  openTab: (tab) => set({ activeTab: tab }),
  closePanel: () => set({ activeTab: null }),
  toggleTab: (tab) => {
    const current = get().activeTab
    set({ activeTab: current === tab ? null : tab })
  },
  setPanelHeight: (height) => {
    const clamped = Math.max(MIN_HEIGHT, Math.min(height, window.innerHeight * MAX_HEIGHT_RATIO))
    try {
      localStorage.setItem(STORAGE_KEY_HEIGHT, String(clamped))
    } catch {
      // localStorage unavailable
    }
    set({ panelHeight: clamped })
  },
  setDragging: (v) => set({ isDragging: v })
}))
