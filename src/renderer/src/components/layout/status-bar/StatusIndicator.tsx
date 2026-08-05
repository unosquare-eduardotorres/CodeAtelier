/**
 * StatusIndicator — shared 3-state indicator component for StatusBar segments.
 * The compute* helpers that derive props live in ./status-indicator-helpers.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type IndicatorState = 'active' | 'attention' | 'idle' | 'error' | 'hidden'

export interface StatusIndicatorProps {
  icon: React.ElementType
  label?: string
  state: IndicatorState
  activeColor?: 'danger' | 'cyan' | 'purple' | 'teal'
  title: string
  onClick: () => void
  badge?: string | number | null
  onBadgeClick?: () => void
  badgeClickable?: boolean
}

// ── Color tables ─────────────────────────────────────────────────────────────

const ACTIVE_COLORS: Record<'danger' | 'cyan' | 'purple' | 'teal', string> = {
  danger: 'text-danger bg-danger/10 hover:bg-danger/20',
  cyan: 'text-cyan-400 bg-cyan-400/10 hover:bg-cyan-400/20',
  purple: 'text-purple-400 bg-purple-400/10 hover:bg-purple-400/20',
  teal: 'text-teal bg-teal/10 hover:bg-teal/20'
}

const STATE_COLORS: Record<'attention' | 'idle' | 'error', string> = {
  attention: 'text-purple-400 bg-purple-400/10 hover:bg-purple-400/20',
  idle: 'text-text-muted hover:text-text-secondary',
  error: 'text-danger bg-danger/10 hover:bg-danger/20'
}

// ── Component ────────────────────────────────────────────────────────────────

export function StatusIndicator({
  icon: Icon,
  label,
  state,
  activeColor = 'danger',
  title,
  onClick,
  badge,
  onBadgeClick,
  badgeClickable
}: StatusIndicatorProps): React.JSX.Element | null {
  if (state === 'hidden') return null

  const colorClass = state === 'active' ? ACTIVE_COLORS[activeColor] : STATE_COLORS[state]

  return (
    <div className="flex items-center gap-1.5 border-l border-border-subtle pl-3 ml-1">
      <button
        type="button"
        onClick={onClick}
        className={`flex items-center gap-1 text-[11px] ${colorClass} rounded px-1.5 py-0.5 transition-colors`}
        title={title}
      >
        <Icon size={11} className={state === 'active' ? 'animate-pulse' : undefined} />
        {label && <span className="font-medium">{label}</span>}
        {badge != null &&
          (badgeClickable && onBadgeClick ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onBadgeClick()
              }}
              className="font-mono text-[10px] bg-surface-overlay rounded-full px-1.5 min-w-[18px] text-center hover:bg-surface-float transition-colors"
              title={`${badge} background blueprint(s) — click to view`}
            >
              {badge}
            </button>
          ) : (
            <span className="font-mono text-[10px]">{badge}</span>
          ))}
      </button>
    </div>
  )
}
