import type { ReactNode } from 'react'

export type StatTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

const TONES: Record<StatTone, string> = {
  neutral: 'border-border-default bg-surface-overlay text-text-secondary',
  info: 'border-info/30 bg-info-muted text-info',
  success: 'border-success/30 bg-success-muted text-success',
  warning: 'border-warning/30 bg-warning-muted text-warning',
  danger: 'border-danger/30 bg-danger-muted text-danger'
}

interface StatPillProps {
  icon?: ReactNode
  label: string
  value?: ReactNode
  tone?: StatTone
  title?: string
  onClick?: () => void
  className?: string
}

/**
 * Compact `label value` readout for header status. Collapses a full-width
 * status bar down to something that costs no vertical space.
 */
export default function StatPill({
  icon,
  label,
  value,
  tone = 'neutral',
  title,
  onClick,
  className = ''
}: StatPillProps): React.JSX.Element {
  const body = (
    <>
      {icon}
      <span className="text-text-muted">{label}</span>
      {value !== undefined && <span className="font-mono tabular-nums font-medium">{value}</span>}
    </>
  )

  const shared = `inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border text-[11px] ${TONES[tone]} ${className}`

  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`${shared} transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-focus`}
    >
      {body}
    </button>
  ) : (
    <span title={title} className={shared}>
      {body}
    </span>
  )
}
