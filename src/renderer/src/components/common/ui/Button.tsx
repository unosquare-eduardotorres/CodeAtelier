import type { ButtonHTMLAttributes } from 'react'

// ── Variants ──

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success'
export type ButtonSize = 'xs' | 'sm' | 'md'

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-primary text-white border border-primary hover:bg-primary-hover disabled:hover:bg-primary',
  secondary:
    'bg-surface-overlay text-text-secondary border border-border-default hover:bg-surface-float hover:text-text-primary',
  ghost:
    'bg-transparent text-text-muted border border-transparent hover:text-text-primary hover:bg-surface-overlay',
  danger:
    'bg-danger-muted text-danger border border-danger/30 hover:bg-danger/20 hover:text-danger',
  success:
    'bg-success-muted text-success border border-success/30 hover:bg-success/20 hover:text-success'
}

const SIZES: Record<ButtonSize, string> = {
  xs: 'h-6 px-2 text-[11px] gap-1 rounded',
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-md',
  md: 'h-8 px-3 text-sm gap-1.5 rounded-md'
}

const ICON_SIZES: Record<ButtonSize, string> = {
  xs: 'w-6 px-0',
  sm: 'w-7 px-0',
  md: 'w-8 px-0'
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Square icon-only button — pass an aria-label alongside it. */
  iconOnly?: boolean
}

/**
 * The single button primitive for the memory surfaces.
 *
 * Replaces the copy-pasted
 * `px-3 py-1.5 bg-primary-muted text-primary-text border …` string that was
 * duplicated a dozen times and gave every action the same visual weight.
 */
export default function Button({
  variant = 'secondary',
  size = 'sm',
  iconOnly = false,
  className = '',
  type = 'button',
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center font-medium whitespace-nowrap transition-colors
        focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-focus
        disabled:opacity-50 disabled:cursor-not-allowed
        ${SIZES[size]} ${iconOnly ? ICON_SIZES[size] : ''} ${VARIANTS[variant]} ${className}`}
      {...rest}
    />
  )
}
