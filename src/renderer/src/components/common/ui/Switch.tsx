import { useId } from 'react'

interface SwitchProps {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  description?: string
  /** Trailing marker next to the label, e.g. a cost badge. */
  badge?: React.ReactNode
  disabled?: boolean
  /**
   * Render the toggle alone, with `label` exposed only to assistive tech.
   * For rows that already name the control themselves — e.g. an integration
   * header where the name doubles as the expand affordance.
   */
  hideLabel?: boolean
  /** Native tooltip, used to explain why the control is disabled. */
  title?: string
}

/**
 * Accessible on/off row.
 *
 * The previous CaptureToggle wrapped a bare `<div onClick>` in a `<label>`:
 * clicking the label text did nothing, the control could not be focused, and
 * screen readers saw no state. This uses a real `role="switch"` button with
 * the label wired through `aria-labelledby`.
 */
export default function Switch({
  checked,
  onChange,
  label,
  description,
  badge,
  disabled = false,
  hideLabel = false,
  title
}: SwitchProps): React.JSX.Element {
  const labelId = useId()
  const descId = useId()

  const control = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={hideLabel ? label : undefined}
      aria-labelledby={hideLabel ? undefined : labelId}
      aria-describedby={!hideLabel && description ? descId : undefined}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!checked)}
      className={`relative shrink-0 w-9 h-5 rounded-full transition-colors
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-focus
        disabled:opacity-50 disabled:cursor-not-allowed ${hideLabel ? '' : 'mt-0.5'} ${
          checked ? 'bg-teal' : 'bg-surface-float border border-border-default'
        }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
          checked ? 'translate-x-4' : ''
        }`}
      />
    </button>
  )

  if (hideLabel) return control

  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div id={labelId} className="flex items-center gap-1.5 text-sm text-text-primary">
          {label}
          {badge}
        </div>
        {description && (
          <div id={descId} className="text-xs text-text-muted mt-0.5">
            {description}
          </div>
        )}
      </div>
      {control}
    </div>
  )
}
