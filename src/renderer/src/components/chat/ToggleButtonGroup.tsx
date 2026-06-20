import type { LucideIcon } from 'lucide-react'

/**
 * Reusable two-option toggle group (used for Mode and Provider selectors).
 * Extracted from NewChatPage to eliminate duplication.
 */
export default function ToggleButtonGroup<T extends string>({
  label,
  value,
  onChange,
  options,
  description,
  'data-testid': dataTestId
}: {
  label: string
  value: T
  onChange: (value: T) => void
  options: Array<{
    value: T
    label: string
    icon: LucideIcon
    activeClass: string
  }>
  description?: string
  'data-testid'?: string
}): React.JSX.Element {
  return (
    <div className="w-full mb-5" data-testid={dataTestId}>
      <label className="block text-sm font-medium text-text-primary mb-1.5">{label}</label>
      <div className="flex items-center gap-2 bg-surface-overlay rounded-lg p-1 border border-border-subtle w-fit">
        {options.map((opt) => {
          const Icon = opt.icon
          const isActive = value === opt.value
          return (
            <button
              key={opt.value}
              onClick={() => onChange(opt.value)}
              className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
                isActive ? opt.activeClass : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              <Icon size={16} />
              {opt.label}
            </button>
          )
        })}
      </div>
      {description && <p className="text-xs text-text-muted mt-1.5">{description}</p>}
    </div>
  )
}
