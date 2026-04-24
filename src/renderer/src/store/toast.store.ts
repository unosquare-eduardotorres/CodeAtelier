import { create } from 'zustand'

export interface Toast {
  id: string
  message: string
  type: 'bug' | 'info' | 'success' | 'error'
  onClickNavigate?: string
  createdAt: number
}

interface ToastState {
  toasts: Toast[]
  addToast: (toast: Omit<Toast, 'id' | 'createdAt'>) => void
  removeToast: (id: string) => void
}

let nextId = 0

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  addToast: (toast) => {
    const id = `toast-${++nextId}-${Date.now()}`
    set((state) => ({
      toasts: [...state.toasts, { ...toast, id, createdAt: Date.now() }]
    }))

    // Auto-dismiss after 5 seconds
    setTimeout(() => {
      set((state) => ({
        toasts: state.toasts.filter((t) => t.id !== id)
      }))
    }, 5000)
  },

  removeToast: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id)
    }))
  }
}))
