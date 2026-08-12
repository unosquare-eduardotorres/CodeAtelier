import type { ButtonHTMLAttributes, ReactNode } from 'react'

interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children: ReactNode
  /** Renders the pressed/selected treatment and sets aria-pressed. */
  active?: boolean
  /** Renders a dismiss affordance instead of a toggle. */
  onDismiss?: () => void
}

/**
 * Toggle chip used for active-filter pills and inline multi-selects.
 * Always announces its state — the old chips were plain buttons whose
 * selected/unselected difference was carried by opacity alone.
 *
 * With no `onClick` the label is inert text rather than a button that looks
 * clickable and does nothing.
 */
export default function Chip({
  children,
  active = false,
  onDismiss,
  onClick,
  className = '',
  ...rest
}: ChipProps): React.JSX.Element {
  const labelClass = 'inline-flex items-center gap-1.5 pl-2.5 pr-2 py-1 rounded-full'

  return (
    <span
      className={`inline-flex items-center rounded-full border text-[11px] leading-none transition-colors ${
        active
          ? 'border-primary/40 bg-primary-muted text-primary-text'
          : 'border-border-default bg-surface-overlay text-text-secondary'
      } ${className}`}
    >
      {onClick ? (
        <button
          type="button"
          aria-pressed={active}
          onClick={onClick}
          className={`${labelClass} focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-focus`}
          {...rest}
        >
          {children}
        </button>
      ) : (
        <span className={labelClass}>{children}</span>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Remove filter"
          className="pr-2 pl-0.5 py-1 text-text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-focus rounded-full"
        >
          ×
        </button>
      )}
    </span>
  )
}
