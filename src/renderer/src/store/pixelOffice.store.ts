import { create } from 'zustand'

const STORAGE_KEY_HEIGHT = 'pixel-office-panel-height'
const STORAGE_KEY_SEATS = 'pixel-office-seat-assignments'
const DEFAULT_HEIGHT = 300
const MIN_HEIGHT = 150
const MAX_HEIGHT = 600

interface PixelOfficeState {
  isVisible: boolean
  panelHeight: number
  seatAssignments: Record<string, number>
  /** When true, office takes center stage with chat+agents on the right */
  isOfficeCentered: boolean

  togglePanel: () => void
  showPanel: () => void
  hidePanel: () => void
  setPanelHeight: (height: number) => void
  assignSeat: (agentId: string, seatIndex: number) => void
  clearSeatAssignment: (agentId: string) => void
  setOfficeCentered: (v: boolean) => void
}

function loadHeight(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_HEIGHT)
    if (stored) {
      const parsed = parseInt(stored, 10)
      if (!isNaN(parsed) && parsed >= MIN_HEIGHT && parsed <= MAX_HEIGHT) {
        return parsed
      }
    }
  } catch {
    // localStorage unavailable
  }
  return DEFAULT_HEIGHT
}

function loadSeatAssignments(): Record<string, number> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_SEATS)
    if (stored) {
      return JSON.parse(stored)
    }
  } catch {
    // localStorage unavailable or invalid JSON
  }
  return {}
}

export const usePixelOfficeStore = create<PixelOfficeState>((set, get) => ({
  isVisible: false,
  panelHeight: loadHeight(),
  seatAssignments: loadSeatAssignments(),
  isOfficeCentered: false,

  togglePanel: () => set((state) => ({ isVisible: !state.isVisible })),
  showPanel: () => set({ isVisible: true }),
  hidePanel: () => set({ isVisible: false }),

  setPanelHeight: (height: number) => {
    const clamped = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, height))
    set({ panelHeight: clamped })
    try {
      localStorage.setItem(STORAGE_KEY_HEIGHT, String(clamped))
    } catch {
      // localStorage unavailable
    }
  },

  assignSeat: (agentId: string, seatIndex: number) => {
    const updated = { ...get().seatAssignments, [agentId]: seatIndex }
    set({ seatAssignments: updated })
    try {
      localStorage.setItem(STORAGE_KEY_SEATS, JSON.stringify(updated))
    } catch {
      // localStorage unavailable
    }
  },

  clearSeatAssignment: (agentId: string) => {
    const { [agentId]: _, ...rest } = get().seatAssignments
    set({ seatAssignments: rest })
    try {
      localStorage.setItem(STORAGE_KEY_SEATS, JSON.stringify(rest))
    } catch {
      // localStorage unavailable
    }
  },

  setOfficeCentered: (v: boolean) => set({ isOfficeCentered: v })
}))
