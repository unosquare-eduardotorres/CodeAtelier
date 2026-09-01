import { Check, ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'
import Popover from './Popover'

export interface SelectOption<T extends string> {
  value: T
  label: string
}

interface SelectMenuProps<T extends string> {
  label?: string
  icon?: ReactNode
  value: T
  options: readonly SelectOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
  /** Passed through to the trigger as data-testid so E2E hooks survive. */
  testId?: string
  className?: string
}

/**
 * Single-select dropdown that replaces native `<select>` elements — those
 * rendered with OS chrome (light grey on macOS/Windows) inside a dark UI.
 */
export default function SelectMenu<T extends string>({
  label,
  icon,
  value,
  options,
  onChange,
  ariaLabel,
  testId,
  className = ''
}: SelectMenuProps<T>): React.JSX.Element {
  const current = options.find((o) => o.value === value)

  return (
    <Popover
      align="end"
      className="w-44 p-1"
      trigger={(props) => (
        <button
          type="button"
          aria-label={ariaLabel}
          data-testid={testId}
          {...props}
          className={`inline-flex items-center gap-1.5 h-7 px-2.5 text-xs rounded-md border border-border-default bg-surface-overlay text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-focus ${className}`}
        >
          {icon}
          {label && <span className="text-text-muted">{label}</span>}
          {current?.label ?? value}
          <ChevronDown className="w-3 h-3" />
        </button>
      )}
    >
      <ul className="py-0.5" role="menu">
        {options.map((opt) => (
          <li key={opt.value}>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={opt.value === value}
              onClick={() => onChange(opt.value)}
              className="w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded text-left text-text-secondary hover:bg-surface-overlay hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-focus"
            >
              <Check
                className={`w-3.5 h-3.5 shrink-0 ${
                  opt.value === value ? 'text-primary-text' : 'text-transparent'
                }`}
              />
              {opt.label}
            </button>
          </li>
        ))}
      </ul>
    </Popover>
  )
}
