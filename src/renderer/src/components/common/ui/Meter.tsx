export type MeterTone = 'info' | 'success' | 'warning' | 'danger' | 'teal' | 'muted'

const TONES: Record<MeterTone, string> = {
  info: 'bg-info',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  teal: 'bg-teal',
  muted: 'bg-text-muted'
}

interface MeterProps {
  /** 0–1. */
  value: number
  tone?: MeterTone
  /** Renders the numeric value in mono next to the bar. */
  label?: string
  className?: string
  /** Bar width in Tailwind units, e.g. 'w-12'. */
  width?: string
}

/**
 * Tiny horizontal gauge for cosine similarity / confidence.
 * A bare `0.920` cannot be compared at a glance; a bar can.
 */
export default function Meter({
  value,
  tone = 'info',
  label,
  className = '',
  width = 'w-12'
}: MeterProps): React.JSX.Element {
  const pct = Math.max(0, Math.min(1, value)) * 100
  return (
    <span
      className={`inline-flex items-center gap-1.5 ${className}`}
      role="meter"
      aria-valuenow={Number(value.toFixed(3))}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-label={label ?? 'value'}
    >
      <span className={`${width} h-1 rounded-full bg-border-default overflow-hidden`}>
        <span className={`block h-full rounded-full ${TONES[tone]}`} style={{ width: `${pct}%` }} />
      </span>
      {label && <span className="font-mono text-[11px] tabular-nums text-text-muted">{label}</span>}
    </span>
  )
}
