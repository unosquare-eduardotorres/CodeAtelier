/**
 * PlanCardActions — config-driven action button renderer for PlanCard.
 *
 * Maps plan status to the appropriate action button set, reducing
 * PlanCard's cyclomatic complexity from 13 to ~5.
 */

import {
  MessageCircle,
  Target,
  Landmark,
  Clipboard,
  Archive,
  RotateCcw,
  Trash2,
  ExternalLink,
  Eye
} from 'lucide-react'
import type { PlanStatus } from '../../../../../shared/types'

// ── Types ──

type ButtonVariant = 'primary' | 'cyan' | 'indigo' | 'ghost'

type HandlerKey =
  | 'onOpenInChat'
  | 'onStartGoal'
  | 'onCouncilReview'
  | 'onCopyPlan'
  | 'onArchive'
  | 'onRestore'
  | 'onDelete'
  | 'onOpenConversation'

interface ActionConfig {
  icon: React.ComponentType<{ size?: number }>
  label: string
  variant: ButtonVariant
  handler: HandlerKey
  /** Render as a trailing icon-only button (e.g. Archive, Delete) */
  iconOnly?: boolean
  /** Extra classes for icon-only buttons */
  iconOnlyClasses?: string
}

export interface PlanCardActionHandlers {
  onOpenInChat: () => void
  onStartGoal: () => void
  onCouncilReview: () => void
  onCopyPlan: () => void
  onArchive: () => void
  onRestore: () => void
  onDelete: () => void
  onOpenConversation: () => void
}

interface PlanCardActionsProps {
  status: PlanStatus
  hasLinkedConversation: boolean
  handlers: PlanCardActionHandlers
}

// ── Status → Action mapping ──

const STATUS_ACTIONS: Record<PlanStatus, ActionConfig[]> = {
  saved: [
    { icon: MessageCircle, label: 'Open in Chat', variant: 'primary', handler: 'onOpenInChat' },
    { icon: Target, label: 'Start Goal', variant: 'cyan', handler: 'onStartGoal' },
    { icon: Landmark, label: 'Council', variant: 'indigo', handler: 'onCouncilReview' },
    { icon: Clipboard, label: 'Copy', variant: 'ghost', handler: 'onCopyPlan' },
    {
      icon: Archive,
      label: 'Archive',
      variant: 'ghost',
      handler: 'onArchive',
      iconOnly: true,
      iconOnlyClasses:
        'ml-auto p-1 text-text-muted hover:text-text-primary hover:bg-surface-overlay rounded-md transition-colors'
    }
  ],
  handed_off: [
    {
      icon: ExternalLink,
      label: 'Open Conversation',
      variant: 'primary',
      handler: 'onOpenConversation'
    },
    { icon: Clipboard, label: 'Copy', variant: 'ghost', handler: 'onCopyPlan' }
  ],
  in_progress: [
    {
      icon: ExternalLink,
      label: 'Open Conversation',
      variant: 'primary',
      handler: 'onOpenConversation'
    }
  ],
  completed: [
    { icon: Eye, label: 'View', variant: 'ghost', handler: 'onOpenInChat' },
    { icon: RotateCcw, label: 'Re-use', variant: 'primary', handler: 'onOpenInChat' },
    { icon: Clipboard, label: 'Copy', variant: 'ghost', handler: 'onCopyPlan' }
  ],
  archived: [
    { icon: RotateCcw, label: 'Restore', variant: 'primary', handler: 'onRestore' },
    {
      icon: Trash2,
      label: 'Delete permanently',
      variant: 'ghost',
      handler: 'onDelete',
      iconOnly: true,
      iconOnlyClasses:
        'ml-auto p-1 text-text-muted hover:text-danger hover:bg-danger-muted rounded-md transition-colors'
    }
  ]
}

// ── Variant classes ──

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'text-primary-text bg-primary-muted border border-primary/20 hover:bg-primary/20',
  cyan: 'text-cyan-400 bg-cyan-500/10 border border-cyan-500/20 hover:bg-cyan-500/20',
  indigo: 'text-indigo-400 bg-indigo-500/10 border border-indigo-500/20 hover:bg-indigo-500/20',
  ghost:
    'text-text-muted hover:text-text-primary hover:bg-surface-overlay border border-transparent'
}

// ── Component ──

export default function PlanCardActions({
  status,
  hasLinkedConversation,
  handlers
}: PlanCardActionsProps): React.JSX.Element {
  let actions = STATUS_ACTIONS[status] ?? []

  // handed_off and in_progress only show conversation buttons when linked
  if ((status === 'handed_off' || status === 'in_progress') && !hasLinkedConversation) {
    actions = actions.filter((a) => a.handler !== 'onOpenConversation')
  }

  return (
    <div className="flex items-center gap-2 ml-[26px] flex-wrap">
      {actions.map((action) => {
        const Icon = action.icon
        const onClick = handlers[action.handler]

        if (action.iconOnly) {
          return (
            <button
              key={action.label}
              onClick={onClick}
              className={action.iconOnlyClasses}
              title={action.label}
            >
              <Icon size={12} />
            </button>
          )
        }

        return (
          <button
            key={action.label}
            onClick={onClick}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg transition-colors ${VARIANT_CLASSES[action.variant]}`}
          >
            <Icon size={12} />
            {action.label}
          </button>
        )
      })}
    </div>
  )
}
