import { useState, useRef, useEffect } from 'react'
import { Trash2, Pencil, MessageCircle } from 'lucide-react'
import type { Conversation } from '../../../../shared/types'

interface ChatItemProps {
  conversation: Conversation
  isActive: boolean
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

export default function ChatItem({
  conversation,
  isActive,
  onSelect,
  onDelete,
  onRename
}: ChatItemProps): React.JSX.Element {
  const [isEditing, setIsEditing] = useState(false)
  const [editTitle, setEditTitle] = useState(conversation.title)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const handleStartEdit = (e?: React.MouseEvent): void => {
    e?.stopPropagation()
    setEditTitle(conversation.title)
    setIsEditing(true)
  }

  const handleSave = (): void => {
    const trimmed = editTitle.trim()
    if (trimmed && trimmed !== conversation.title) {
      onRename(conversation.id, trimmed)
    }
    setIsEditing(false)
  }

  const handleCancel = (): void => {
    setEditTitle(conversation.title)
    setIsEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSave()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      handleCancel()
    }
  }

  return (
    <div
      className={`group flex items-center gap-3 px-3 py-3 cursor-pointer rounded-lg transition-colors press-scale ${
        isActive
          ? 'bg-primary-muted border-l-2 border-l-primary border border-primary/20'
          : 'hover:bg-surface-overlay border-l-2 border-l-transparent border border-transparent'
      }`}
      onClick={() => !isEditing && onSelect(conversation.id)}
      role="button"
      tabIndex={0}
      aria-label={`Open conversation: ${conversation.title}`}
      onKeyDown={(e) => {
        if (!isEditing && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onSelect(conversation.id)
        }
      }}
    >
      <div
        className={`flex items-center justify-center w-8 h-8 rounded-lg ${
          isActive ? 'bg-primary/20 text-primary-text' : 'bg-surface-overlay text-text-muted'
        }`}
      >
        <MessageCircle size={14} />
      </div>

      <div className="flex-1 min-w-0">
        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
            onClick={(e) => e.stopPropagation()}
            className="w-full text-sm font-medium text-text-primary bg-surface-overlay border border-primary/50 rounded px-1.5 py-0.5 outline-none focus:border-primary-text"
            maxLength={500}
            aria-label="Rename conversation"
          />
        ) : (
          <div
            className="text-sm font-medium text-text-primary truncate"
            onDoubleClick={handleStartEdit}
            title="Double-click to rename"
          >
            {conversation.title}
          </div>
        )}
        <div className="text-xs text-text-muted truncate">
          {formatRelativeTime(conversation.createdAt)}
        </div>
      </div>

      {!isEditing && (
        <div className="hidden group-hover:flex items-center gap-0.5 flex-shrink-0">
          <button
            className="flex items-center justify-center w-6 h-6 rounded-md hover:bg-surface-float text-text-muted hover:text-text-primary transition-colors"
            onClick={handleStartEdit}
            aria-label={`Rename conversation: ${conversation.title}`}
            title="Rename conversation"
          >
            <Pencil size={12} />
          </button>
          <button
            className="flex items-center justify-center w-6 h-6 rounded-md hover:bg-danger-muted text-text-muted hover:text-red-400 transition-colors"
            onClick={(e) => {
              e.stopPropagation()
              onDelete(conversation.id)
            }}
            aria-label={`Delete conversation: ${conversation.title}`}
            title="Delete conversation"
          >
            <Trash2 size={12} />
          </button>
        </div>
      )}
    </div>
  )
}
