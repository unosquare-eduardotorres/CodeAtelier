import {
  Hammer,
  Landmark,
  Lightbulb,
  RefreshCw,
  ClipboardCheck,
  Loader2,
  CheckCircle2,
  AlertTriangle
} from 'lucide-react'
import type { PlanBarState } from './build-bar-visibility'

interface BuildActionBarProps {
  /** Derived plan state — decides what this bar renders. Never hidden. */
  state: PlanBarState
  onBuildNow?: () => void
  onSaveAsIdea?: () => void
  onRefine?: () => void
  onCouncilReview?: () => void
  /** When true, shows a "Saved to Plans" indicator */
  savedToPlans?: boolean
  /** Phase counts for the `building` progress chip. */
  progress?: { completed: number; total: number }
  /** When the action was taken — shown alongside "Build again". */
  actionedAt?: number
}

const BAR_CLASS =
  'sticky bottom-0 flex items-center gap-2 px-5 py-3 border-t border-border-subtle bg-surface-overlay/95 backdrop-blur-sm flex-wrap'

const ACTION_LABEL: Record<string, string> = {
  build: 'Build started',
  refine: 'Sent for refinement',
  save_as_idea: 'Saved as idea',
  council: 'Sent to council'
}

function formatTime(ts: number | undefined): string {
  if (!ts) return ''
  return ` · ${new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

/**
 * Status line + a way forward. Used for every non-actionable state so the bar
 * always occupies the same slot — the panel never goes blank.
 */
function StatusBar({
  icon,
  text,
  onRetry,
  retryLabel = 'Build again',
  testid
}: {
  icon: React.JSX.Element
  text: string
  onRetry?: () => void
  retryLabel?: string
  testid: string
}): React.JSX.Element {
  return (
    <div data-testid="task-plan-build-bar" data-barstate={testid} className={BAR_CLASS}>
      <span className="flex items-center gap-1.5 text-xs text-text-secondary">
        {icon}
        {text}
      </span>
      {onRetry && (
        <button
          onClick={onRetry}
          data-testid="task-plan-build-again"
          className="ml-auto flex items-center gap-1.5 px-3 py-1 rounded bg-mode-build hover:brightness-110 text-white text-xs font-medium transition-colors press-scale"
        >
          <Hammer size={12} />
          {retryLabel}
        </button>
      )}
    </div>
  )
}

export default function BuildActionBar({
  state,
  onBuildNow,
  onSaveAsIdea,
  onRefine,
  onCouncilReview,
  savedToPlans,
  progress,
  actionedAt
}: BuildActionBarProps): React.JSX.Element {
  if (state.kind === 'building') {
    const label =
      progress && progress.total > 0
        ? `Building · phase ${Math.min(progress.completed + 1, progress.total)} of ${progress.total}`
        : 'Building…'
    return (
      <StatusBar
        testid="building"
        icon={<Loader2 size={13} className="animate-spin text-info" />}
        text={label}
      />
    )
  }

  if (state.kind === 'stalled') {
    return (
      <StatusBar
        testid="stalled"
        icon={<AlertTriangle size={13} className="text-amber-400" />}
        text="Build stopped responding"
        onRetry={onBuildNow}
      />
    )
  }

  if (state.kind === 'done') {
    return (
      <StatusBar
        testid="done"
        icon={<CheckCircle2 size={13} className="text-success" />}
        text="Build complete — see the Tasks tab for the summary"
      />
    )
  }

  if (state.kind === 'actioned') {
    const label = `${ACTION_LABEL[state.action] ?? 'Plan actioned'}${formatTime(actionedAt)}`
    return (
      <StatusBar
        testid="actioned"
        icon={<ClipboardCheck size={13} className="text-text-muted" />}
        text={label}
        onRetry={onBuildNow}
        retryLabel={state.action === 'build' ? 'Build again' : 'Build now'}
      />
    )
  }

  // actionable | working | awaiting_input — same four buttons, disabled with a
  // reason while the agent owns the turn.
  const disabled = state.kind !== 'actionable'
  const reason =
    state.kind === 'working'
      ? 'Agent is working'
      : state.kind === 'awaiting_input'
        ? 'Waiting for your answer'
        : null
  const btn = (extra: string): string =>
    `flex items-center justify-center gap-1.5 min-w-[110px] px-4 py-1.5 rounded text-sm font-medium transition-colors press-scale ${extra}${
      disabled ? ' opacity-40 cursor-not-allowed' : ''
    }`

  return (
    <div data-testid="task-plan-build-bar" data-barstate={state.kind} className={BAR_CLASS}>
      {onBuildNow && (
        <button
          onClick={onBuildNow}
          disabled={disabled}
          data-testid="task-plan-build-now"
          className={btn(
            'bg-mode-build hover:brightness-110 text-white focus-visible:ring-2 focus-visible:ring-mode-build/50'
          )}
        >
          <Hammer size={14} />
          Build Now
        </button>
      )}
      {onCouncilReview && (
        <button
          onClick={onCouncilReview}
          disabled={disabled}
          className={btn('bg-purple-600/80 hover:bg-purple-600 text-white')}
        >
          <Landmark size={14} />
          Council
        </button>
      )}
      {onSaveAsIdea && (
        <button
          onClick={onSaveAsIdea}
          disabled={disabled}
          className={btn('bg-surface-overlay hover:bg-surface-float text-text-body')}
        >
          <Lightbulb size={14} />
          Save as Idea
        </button>
      )}
      {onRefine && (
        <button
          onClick={onRefine}
          disabled={disabled}
          className={btn('bg-surface-overlay hover:bg-surface-float text-text-body')}
        >
          <RefreshCw size={14} />
          Refine Plan
        </button>
      )}
      {reason ? (
        <span className="ml-auto flex items-center gap-1.5 text-xs text-text-muted select-none">
          <Loader2 size={12} className="animate-spin" />
          {reason}
        </span>
      ) : (
        savedToPlans && (
          <span className="ml-auto flex items-center gap-1.5 text-xs text-success/80 select-none">
            <ClipboardCheck size={13} />
            Saved to Plans
          </span>
        )
      )}
    </div>
  )
}
