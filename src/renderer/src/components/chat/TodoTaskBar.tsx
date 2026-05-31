import { ChevronDown, ClipboardCheck, CheckCircle2, Circle } from 'lucide-react'
import { type TodoItem, useTodoStore } from '@renderer/store/todo.store'

const EMPTY_TODOS: TodoItem[] = []

interface TodoTaskBarProps {
  conversationId: string
}

export default function TodoTaskBar({
  conversationId
}: TodoTaskBarProps): React.JSX.Element | null {
  const todos = useTodoStore((s) => s.todos[conversationId] ?? EMPTY_TODOS)
  const expanded = useTodoStore((s) => s.expanded)
  const toggleExpanded = useTodoStore((s) => s.toggleExpanded)

  if (todos.length === 0) return null

  const completed = todos.filter((t) => t.completed).length
  const total = todos.length
  const allDone = completed === total

  return (
    <div className="mx-6 mb-2 rounded-lg border border-border-subtle bg-surface-overlay/60 backdrop-blur-sm overflow-hidden">
      {/* Collapsed header — always visible */}
      <button
        onClick={toggleExpanded}
        className="w-full flex items-center justify-between px-4 py-2 text-sm transition-colors hover:bg-surface-overlay/80"
      >
        <span className="flex items-center gap-2">
          <ClipboardCheck size={14} className={allDone ? 'text-success' : 'text-text-secondary'} />
          <span className="font-medium text-text-body">Tasks:</span>
          <span className="tabular-nums text-text-secondary">
            {completed}/{total} completed
          </span>
          {allDone && <span className="text-success text-xs font-medium">✓ All done</span>}
        </span>
        <ChevronDown
          size={14}
          className={`text-text-muted transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Expanded task list */}
      {expanded && (
        <div className="border-t border-border-subtle px-2 py-1 max-h-48 overflow-y-auto">
          {todos.map((todo, i) => (
            <div key={`${todo.text}-${i}`} className="flex items-center gap-2 px-2 py-1.5 text-sm">
              {todo.completed ? (
                <CheckCircle2 size={14} className="text-success flex-shrink-0" />
              ) : (
                <Circle size={14} className="text-text-muted flex-shrink-0" />
              )}
              <span className={todo.completed ? 'text-text-muted line-through' : 'text-text-body'}>
                {todo.text}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
