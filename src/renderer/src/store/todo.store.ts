import { create } from 'zustand'

export interface TodoItem {
  text: string
  completed: boolean
  index?: number
  /** Timestamp when the todo was added/updated — for animation triggers */
  updatedAt: number
}

interface TodoState {
  /** Per-conversation todo lists */
  todos: Record<string, TodoItem[]>
  /** Whether the task bar is expanded */
  expanded: boolean

  // Actions
  addTodo: (conversationId: string, text: string, index?: number) => void
  completeTodo: (conversationId: string, text: string, index?: number) => void
  removeTodo: (conversationId: string, text: string, index?: number) => void
  updateTodo: (conversationId: string, text: string, index?: number) => void
  clearTodos: (conversationId: string) => void
  toggleExpanded: () => void
}

// Preserve Zustand state across HMR (dev only)
const previousTodoState = import.meta.hot?.data?.todoStoreState as Partial<TodoState> | undefined

export const useTodoStore = create<TodoState>((set) => ({
  todos: previousTodoState?.todos ?? {},
  expanded: previousTodoState?.expanded ?? false,

  addTodo: (conversationId: string, text: string, index?: number) => {
    set((state) => {
      const existing = state.todos[conversationId] ?? []
      // Avoid duplicates (same text)
      if (existing.some((t) => t.text === text)) return state
      const newItem: TodoItem = { text, completed: false, index, updatedAt: Date.now() }
      return {
        todos: { ...state.todos, [conversationId]: [...existing, newItem] }
      }
    })
  },

  completeTodo: (conversationId: string, text: string, index?: number) => {
    set((state) => {
      const existing = state.todos[conversationId]
      if (!existing) return state
      const updated = existing.map((t) => {
        // Match by index first (more precise), then by text
        const matches = index !== undefined ? t.index === index : t.text === text
        if (matches && !t.completed) {
          return { ...t, completed: true, updatedAt: Date.now() }
        }
        return t
      })
      return { todos: { ...state.todos, [conversationId]: updated } }
    })
  },

  removeTodo: (conversationId: string, text: string, index?: number) => {
    set((state) => {
      const existing = state.todos[conversationId]
      if (!existing) return state
      const filtered = existing.filter((t) => {
        const matches = index !== undefined ? t.index === index : t.text === text
        return !matches
      })
      return { todos: { ...state.todos, [conversationId]: filtered } }
    })
  },

  updateTodo: (conversationId: string, text: string, index?: number) => {
    set((state) => {
      const existing = state.todos[conversationId]
      if (!existing || index === undefined) return state
      const updated = existing.map((t) =>
        t.index === index ? { ...t, text, updatedAt: Date.now() } : t
      )
      return { todos: { ...state.todos, [conversationId]: updated } }
    })
  },

  clearTodos: (conversationId: string) => {
    set((state) => {
      const { [conversationId]: _, ...rest } = state.todos
      return { todos: rest }
    })
  },

  toggleExpanded: () => {
    set((state) => ({ expanded: !state.expanded }))
  }
}))

// Preserve state on HMR dispose
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    import.meta.hot!.data.todoStoreState = useTodoStore.getState()
  })
}
