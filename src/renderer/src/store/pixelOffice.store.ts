import { create } from 'zustand'

const STORAGE_KEY_SEATS = 'pixel-office-seat-assignments'

interface PixelOfficeState {
  seatAssignments: Record<string, number>

  assignSeat: (agentId: string, seatIndex: number) => void
  clearSeatAssignment: (agentId: string) => void
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
  seatAssignments: loadSeatAssignments(),

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
  }
}))
