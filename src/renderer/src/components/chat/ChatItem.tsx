import { useState, useRef, useEffect } from 'react'
import { Trash2, Pencil, GripVertical, Compass, Hammer, ShieldAlert, ShieldCheck } from 'lucide-react'
import type { Conversation, ConversationMode, ContextUsage } from '../../../../shared/types'
import { parseDbTimestamp } from '../../../../shared/db-time'
import ContextBadge from './ContextBadge'

interface ChatItemProps {
  conversation: Conversation
  isActive: boolean
  isStreaming?: boolean
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
  contextUsage?: ContextUsage
  draggable?: boolean
  onDragStart?: (e: React.DragEvent, id: string) => void
  onDragOver?: (e: React.DragEvent) => void
  onDragLeave?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent, id: string) => void
  isDragOver?: boolean
}

// ── Data-driven mode styles ──

const MODE_STYLES: Record<ConversationMode, {
  iconBgActive: string
  iconBgDefault: string
  pillClass: string
  pillLabel: string
  Icon: typeof Compass
}> = {
  plan: {
    iconBgActive: 'bg-mode-plan/20 text-mode-plan-text',
    iconBgDefault: 'bg-mode-plan-muted text-mode-plan-text',
    pillClass: 'bg-mode-plan-muted text-mode-plan-text',
    pillLabel: 'Plan',
    Icon: Compass
  },
  build: {
    iconBgActive: 'bg-mode-build/20 text-mode-build-text',
    iconBgDefault: 'bg-mode-build-muted text-mode-build-text',
    pillClass: 'bg-mode-build-muted text-mode-build-text',
    pillLabel: 'Build',
    Icon: Hammer
  },
  danger: {
    iconBgActive: 'bg-red-500/20 text-red-400',
    iconBgDefault: 'bg-red-500/10 text-red-400',
    pillClass: 'bg-red-500/10 text-red-400',
    pillLabel: 'Danger',
    Icon: ShieldAlert
  }
}

function formatRelativeTime(dateStr: string): string {
  const date = parseDbTimestamp(dateStr)
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

// ── Stream completion flash hook ──

function useStreamCompletionFlash(isStreaming: boolean): {
  showComplete: boolean
  animationClass: string
} {
  const [showComplete, setShowComplete] = useState(false)
  const wasStreamingRef = useRef(false)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    if (wasStreamingRef.current && !isStreaming) {
      setShowComplete(true)
      timer = setTimeout(() => setShowComplete(false), 800)
    }
    wasStreamingRef.current = isStreaming
    return (): void => {
      if (timer) clearTimeout(timer)
    }
  }, [isStreaming])

  const animationClass = isStreaming
    ? 'chat-icon-processing'
    : showComplete
      ? 'chat-icon-complete'
      : ''

  return { showComplete, animationClass }
}

// ── Action buttons sub-component ──

function ChatItemActions({
  onEdit,
  onDelete,
  title
}: {
  onEdit: (e?: React.MouseEvent) => void
  onDelete: () => void
  title: string
}): React.JSX.Element {
  return (
    <div className="hidden group-hover:flex items-center gap-0.5 flex-shrink-0">
      <button
        className="flex items-center justify-center w-6 h-6 rounded-md hover:bg-surface-float text-text-muted hover:text-text-primary transition-colors"
        onClick={onEdit}
        aria-label={`Rename conversation: ${title}`}
        title="Rename conversation"
      >
        <Pencil size={12} />
      </button>
      <button
        className="flex items-center justify-center w-6 h-6 rounded-md hover:bg-danger-muted text-text-muted hover:text-danger transition-colors"
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
        aria-label={`Delete conversation: ${title}`}
        title="Delete conversation"
      >
        <Trash2 size={12} />
      </button>
    </div>
  )
}

export default function ChatItem({
  conversation,
  isActive,
  isStreaming = false,
  onSelect,
  onDelete,
  onRename,
  contextUsage,
  draggable = false,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  isDragOver = false
}: ChatItemProps): React.JSX.Element {
  const [isEditing, setIsEditing] = useState(false)
  const [editTitle, setEditTitle] = useState(conversation.title)
  const inputRef = useRef<HTMLInputElement>(null)
  const { animationClass } = useStreamCompletionFlash(isStreaming)

  const modeStyle = MODE_STYLES[conversation.mode] ?? MODE_STYLES.plan

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
      data-testid="chat-item"
      className={`group flex items-center gap-3 px-3 py-3 cursor-pointer rounded-lg transition-colors press-scale ${
        isActive
          ? 'bg-primary-muted border-l-2 border-l-primary border border-primary/20'
          : 'hover:bg-surface-overlay border-l-2 border-l-transparent border border-transparent'
      }${isDragOver ? ' ring-2 ring-primary/50 bg-primary-muted/30' : ''}`}
      onClick={() => !isEditing && onSelect(conversation.id)}
      role="button"
      tabIndex={0}
      aria-label={`Open conversation: ${conversation.title}`}
      draggable={draggable && !isEditing}
      onDragStart={(e) => onDragStart?.(e, conversation.id)}
      onDragOver={(e) => onDragOver?.(e)}
      onDragLeave={(e) => onDragLeave?.(e)}
      onDrop={(e) => onDrop?.(e, conversation.id)}
      onKeyDown={(e) => {
        if (!isEditing && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onSelect(conversation.id)
        }
      }}
    >
      {draggable && (
        <div className="hidden group-hover:flex items-center text-text-muted cursor-grab active:cursor-grabbing flex-shrink-0">
          <GripVertical size={12} />
        </div>
      )}

      <div
        className={`flex items-center justify-center w-8 h-8 rounded-lg transition-shadow ${
          isActive ? modeStyle.iconBgActive : modeStyle.iconBgDefault
        } ${animationClass}`}
      >
        <modeStyle.Icon size={14} />
      </div>

      <div className="flex-1 min-w-0">
        {isEditing ? (
          <input
            ref={inputRef}
            data-testid="chat-item-rename-input"
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
        <div className="flex items-center gap-1.5 text-xs text-text-muted truncate">
          <span>{formatRelativeTime(conversation.createdAt)}</span>
          {/* Mode pill */}
          <span
            className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium ${modeStyle.pillClass}`}
            title={modeStyle.pillLabel}
          >
            {modeStyle.pillLabel}
          </span>
          {contextUsage && contextUsage.percentage > 0 && (
            <ContextBadge percentage={contextUsage.percentage} level={contextUsage.level} compact />
          )}
          {conversation.sourceAuditRunId && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] font-medium rounded bg-success/10 text-success">
              <ShieldCheck size={9} />
              Audit
            </span>
          )}
        </div>
      </div>

      {!isEditing && (
        <ChatItemActions
          onEdit={handleStartEdit}
          onDelete={() => onDelete(conversation.id)}
          title={conversation.title}
        />
      )}
    </div>
  )
}
