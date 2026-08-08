import type { ReactNode } from 'react'

export interface Segment<T extends string> {
  value: T
  label: ReactNode
  title?: string
}

interface SegmentedControlProps<T extends string> {
  value: T
  segments: readonly Segment<T>[]
  onChange: (value: T) => void
  ariaLabel: string
  size?: 'xs' | 'sm'
  className?: string
}

/**
 * Radio-group segmented switch. Used for density and Rendered/Source toggles —
 * cases where a native `<select>` was previously dropping OS chrome into a
 * dark UI for a two-option choice.
 */
export default function SegmentedControl<T extends string>({
  value,
  segments,
  onChange,
  ariaLabel,
  size = 'sm',
  className = ''
}: SegmentedControlProps<T>): React.JSX.Element {
  const height = size === 'xs' ? 'h-6' : 'h-7'
  const text = size === 'xs' ? 'text-[11px]' : 'text-xs'

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`inline-flex items-center ${height} p-0.5 rounded-md bg-surface-overlay border border-border-default ${className}`}
    >
      {segments.map((seg) => {
        const selected = seg.value === value
        return (
          <button
            key={seg.value}
            type="button"
            role="radio"
            aria-checked={selected}
            title={seg.title}
            onClick={() => onChange(seg.value)}
            className={`inline-flex items-center gap-1 h-full px-2 rounded ${text} transition-colors
              focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-focus ${
                selected
                  ? 'bg-primary-muted text-primary-text'
                  : 'text-text-muted hover:text-text-primary'
              }`}
          >
            {seg.label}
          </button>
        )
      })}
    </div>
  )
}
