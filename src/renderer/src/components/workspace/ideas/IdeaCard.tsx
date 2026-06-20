import { useState } from 'react'
import {
  Lightbulb,
  Flame,
  Play,
  Trash2,
  CheckCircle,
  ExternalLink,
  Pencil,
  Check,
  X,
  MessageCircle,
  FileText
} from 'lucide-react'
import type { Idea } from '../../../../../shared/types'

/** Live grill status from main process */
export interface GrillStatus {
  status: string
  ideaId: string
  trackId: string | null
  score: number | null
}

// ── Inline helper components ──

function StatusBadge({ status }: { status: Idea['status'] }): React.JSX.Element {
  const config = {
    draft: {
      icon: Lightbulb,
      label: 'Draft',
      className: 'text-warning bg-warning-muted border-warning/20'
    },
    grilling: {
      icon: Flame,
      label: 'Grilling',
      className: 'text-accent bg-accent-muted border-accent/20'
    },
    completed: {
      icon: CheckCircle,
      label: 'Completed',
      className: 'text-success bg-success-muted border-success/20'
    }
  }

  const { icon: Icon, label, className } = config[status]

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full border ${className}`}
    >
      <Icon size={10} />
      {label}
    </span>
  )
}

function GrillStatusIcon({
  idea,
  grillStatus
}: {
  idea: Idea
  grillStatus: GrillStatus | null
}): React.JSX.Element {
  if (idea.status === 'completed')
    return <CheckCircle size={14} className="text-success flex-shrink-0" />

  if (grillStatus?.ideaId === idea.id) {
    if (grillStatus.status === 'evaluating') {
      return <Flame size={14} className="text-accent animate-pulse flex-shrink-0" />
    }
    if (grillStatus.status === 'awaiting_answers') {
      return <MessageCircle size={14} className="text-info flex-shrink-0" />
    }
  }

  if (idea.status === 'grilling') {
    return <Flame size={14} className="text-text-muted flex-shrink-0" />
  }

  return <Lightbulb size={14} className="text-warning flex-shrink-0" />
}

function GrillSummaryPreview({ summary }: { summary: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="mt-2 ml-[22px] p-2 bg-surface-raised rounded-md border border-border-default">
      <div className="flex items-center justify-between">
        <span className="text-xs text-text-secondary font-medium">Grill Summary:</span>
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-primary-text hover:text-primary-hover transition-colors"
        >
          {expanded ? 'Collapse' : 'Show all'}
        </button>
      </div>
      <div
        className={`text-xs text-text-body mt-0.5 whitespace-pre-wrap ${expanded ? '' : 'line-clamp-3'}`}
      >
        {summary}
      </div>
    </div>
  )
}

// ── Main card ──

interface IdeaCardProps {
  idea: Idea
  grillStatus: GrillStatus | null
  /** Whether this idea has a persisted grill plan (enables Review Plan) */
  hasPlan?: boolean
  onStartGrill: (idea: Idea) => void
  onContinueGrill: (idea: Idea) => void
  onConvertDirect: (idea: Idea) => void
  onGoToConversation: (conversationId: string) => void
  onCreatePlan: (idea: Idea) => void
  onReviewPlan: (idea: Idea) => void
  onDelete: (ideaId: string) => void
  onEdit: (idea: Idea, title: string, description: string) => Promise<void>
}

export default function IdeaCard({
  idea,
  grillStatus,
  hasPlan,
  onStartGrill,
  onContinueGrill,
  onConvertDirect,
  onGoToConversation,
  onCreatePlan,
  onReviewPlan,
  onDelete,
  onEdit
}: IdeaCardProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState(idea.title)
  const [editDescription, setEditDescription] = useState(idea.description || '')

  const startEditing = (): void => {
    setEditTitle(idea.title)
    setEditDescription(idea.description || '')
    setEditing(true)
  }

  const cancelEditing = (): void => {
    setEditing(false)
  }

  const saveEditing = async (): Promise<void> => {
    if (!editTitle.trim()) return
    await onEdit(idea, editTitle.trim(), editDescription.trim())
    setEditing(false)
  }

  return (
    <div
      data-testid="idea-card"
      className="group bg-surface-overlay border border-border-subtle rounded-lg p-4 hover:border-border-default transition-colors shadow-sm"
    >
      {editing ? (
        /* Inline editing mode */
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <GrillStatusIcon idea={idea} grillStatus={grillStatus} />
            <input
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveEditing()
                if (e.key === 'Escape') cancelEditing()
              }}
              className="flex-1 bg-surface-base border border-border-default rounded-md px-2 py-1 text-sm font-medium text-text-primary outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
              autoFocus
            />
          </div>
          <textarea
            value={editDescription}
            onChange={(e) => setEditDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') cancelEditing()
            }}
            placeholder="Add a description..."
            rows={5}
            className="w-full bg-surface-base border border-border-default rounded-md px-2 py-1.5 text-xs text-text-secondary outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30 resize-none ml-[22px]"
            style={{ width: 'calc(100% - 22px)' }}
          />
          <div className="flex items-center gap-1.5 ml-[22px]">
            <button
              onClick={saveEditing}
              disabled={!editTitle.trim()}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-success bg-success-muted border border-success/20 rounded-lg hover:bg-success/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Check size={12} />
              Save
            </button>
            <button
              onClick={cancelEditing}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-text-muted hover:text-text-primary hover:bg-surface-overlay rounded-lg transition-colors"
            >
              <X size={12} />
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Title row */}
          <div className="flex items-start justify-between gap-3 mb-1">
            <div className="flex items-center gap-2 min-w-0">
              <GrillStatusIcon idea={idea} grillStatus={grillStatus} />
              <span className="text-base font-normal text-text-primary truncate">{idea.title}</span>
              {idea.status !== 'completed' && (
                <button
                  onClick={startEditing}
                  className="p-0.5 text-text-muted hover:text-text-primary rounded transition-colors opacity-0 group-hover:opacity-100"
                  aria-label="Edit idea"
                  title="Edit idea"
                >
                  <Pencil size={11} />
                </button>
              )}
            </div>
            <StatusBadge status={idea.status} />
          </div>

          {/* Description */}
          {idea.description && (
            <p className="text-xs text-text-secondary mb-3 ml-[22px] line-clamp-2">
              {idea.description}
            </p>
          )}
        </>
      )}

      {/* Actions — hidden while editing */}
      {!editing && (
        <div className="flex items-center gap-2 ml-[22px]">
          {idea.status === 'draft' && (
            <>
              <button
                onClick={() => onStartGrill(idea)}
                title="Launch a structured Q&A session where an AI analyst evaluates your idea across 8 specialist tracks, scoring gaps and asking clarifying questions."
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-accent bg-accent-muted border border-accent/20 rounded-lg hover:bg-accent/20 transition-colors"
              >
                <Flame size={12} />
                Grill Me
              </button>
              <button
                onClick={() => onConvertDirect(idea)}
                title="Skip the grill and send this idea straight to a new chat conversation to start working on it immediately."
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-primary-text bg-primary-muted border border-primary/20 rounded-lg hover:bg-primary/20 transition-colors"
              >
                <Play size={12} />
                Start Building
              </button>
            </>
          )}

          {idea.status === 'grilling' && (
            <>
              {!hasPlan && (
                <button
                  onClick={() => onContinueGrill(idea)}
                  title="Resume the grill Q&A session where you left off."
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-accent bg-accent-muted border border-accent/20 rounded-lg hover:bg-accent/20 transition-colors"
                >
                  <Flame size={12} />
                  Continue Grill
                </button>
              )}
              <button
                onClick={() => onConvertDirect(idea)}
                title="End the grill and send this idea to a new chat conversation to start building."
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-primary-text bg-primary-muted border border-primary/20 rounded-lg hover:bg-primary/20 transition-colors"
              >
                <Play size={12} />
                Start Building
              </button>
            </>
          )}

          {idea.status === 'completed' && idea.convertedConversationId && (
            <button
              onClick={() => onGoToConversation(idea.convertedConversationId!)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-success bg-success-muted border border-success/20 rounded-lg hover:bg-success/20 transition-colors"
            >
              <ExternalLink size={12} />
              Go to Conversation
            </button>
          )}

          {idea.status === 'completed' &&
            idea.grillConversationId &&
            !idea.convertedConversationId && (
              <button
                onClick={() => onGoToConversation(idea.grillConversationId!)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-success bg-success-muted border border-success/20 rounded-lg hover:bg-success/20 transition-colors"
              >
                <ExternalLink size={12} />
                Go to Grill Conversation
              </button>
            )}

          {idea.status === 'completed' && (
            <button
              onClick={() => onCreatePlan(idea)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-primary-text bg-primary-muted border border-primary/20 rounded-lg hover:bg-primary/20 transition-colors"
            >
              <Play size={12} />
              Create New Plan
            </button>
          )}

          {/* Review Plan — read-only re-open of the generated plan (any status) */}
          {hasPlan && (
            <button
              onClick={() => onReviewPlan(idea)}
              title="Re-open this idea's completed grill to review the full generated plan — requirement document, decisions and items — and re-trigger a handoff."
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-accent bg-accent-muted border border-accent/20 rounded-lg hover:bg-accent/20 transition-colors"
            >
              <FileText size={12} />
              Review Plan
            </button>
          )}

          {/* Delete button — always available */}
          <button
            onClick={() => onDelete(idea.id)}
            data-testid="idea-delete-btn"
            className="inline-flex items-center p-1 text-text-muted hover:text-danger hover:bg-danger-muted rounded-md transition-colors ml-auto"
            aria-label="Delete idea"
            title="Delete idea"
          >
            <Trash2 size={12} />
          </button>
        </div>
      )}

      {/* Inline hint for draft ideas */}
      {!editing && idea.status === 'draft' && (
        <p className="text-[10px] text-text-muted ml-[22px] mt-1.5">
          <span className="text-accent font-medium">Grill Me</span> = AI-led deep-dive interview
          {' · '}
          <span className="text-primary-text font-medium">Start Building</span> = jump to chat now
        </p>
      )}

      {/* Grill summary — expandable */}
      {idea.grillSummary && idea.status === 'completed' && (
        <GrillSummaryPreview summary={idea.grillSummary} />
      )}
    </div>
  )
}
