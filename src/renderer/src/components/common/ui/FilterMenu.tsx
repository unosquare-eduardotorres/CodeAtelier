import { Check, ChevronDown } from 'lucide-react'
import Popover from './Popover'

export interface FilterOption<T extends string | number> {
  value: T
  label: string
  count?: number
  /** Optional colour class applied to the label. */
  toneClass?: string
}

interface FilterMenuProps<T extends string | number> {
  label: string
  options: readonly FilterOption<T>[]
  selected: ReadonlySet<T>
  onChange: (next: Set<T>) => void
  className?: string
}

/**
 * Multi-select filter dropdown with inline counts and an explicit "Only"
 * (solo) action per row.
 *
 * The old UI had two chip rows that looked identical but behaved oppositely —
 * tier chips soloed, category chips toggled. Both now use this one model, and
 * soloing is a labelled button instead of undiscoverable click behaviour.
 */
export default function FilterMenu<T extends string | number>({
  label,
  options,
  selected,
  onChange,
  className = ''
}: FilterMenuProps<T>): React.JSX.Element {
  const allSelected = options.every((o) => selected.has(o.value))
  const summary = allSelected ? 'All' : `${selected.size}/${options.length}`

  const toggle = (value: T): void => {
    const next = new Set(selected)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    // An empty filter shows nothing, which reads as a bug — treat it as "all".
    onChange(next.size === 0 ? new Set(options.map((o) => o.value)) : next)
  }

  return (
    <Popover
      className="w-56 p-1"
      trigger={(props) => (
        <button
          type="button"
          {...props}
          className={`inline-flex items-center gap-1.5 h-7 px-2.5 text-xs rounded-md border transition-colors
            focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-focus ${
              allSelected
                ? 'border-border-default bg-surface-overlay text-text-secondary hover:text-text-primary'
                : 'border-primary/40 bg-primary-muted text-primary-text'
            } ${className}`}
        >
          {label}
          <span className="font-mono tabular-nums text-text-muted">{summary}</span>
          <ChevronDown className="w-3 h-3" />
        </button>
      )}
    >
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-border-default">
        <span className="text-[11px] uppercase tracking-wider text-text-muted">{label}</span>
        <button
          type="button"
          onClick={() => onChange(new Set(options.map((o) => o.value)))}
          className="text-[11px] text-text-muted hover:text-text-primary"
        >
          Select all
        </button>
      </div>
      <ul className="py-1 max-h-72 overflow-auto">
        {options.map((opt) => {
          const isOn = selected.has(opt.value)
          return (
            <li key={String(opt.value)} className="group flex items-center">
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={isOn}
                onClick={() => toggle(opt.value)}
                className="flex-1 flex items-center gap-2 px-2 py-1.5 text-xs rounded text-left hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-focus"
              >
                <Check
                  className={`w-3.5 h-3.5 shrink-0 ${isOn ? 'text-primary-text' : 'text-transparent'}`}
                />
                <span className={`flex-1 truncate ${opt.toneClass ?? 'text-text-secondary'}`}>
                  {opt.label}
                </span>
                {opt.count !== undefined && (
                  <span className="font-mono tabular-nums text-text-muted">{opt.count}</span>
                )}
              </button>
              <button
                type="button"
                onClick={() => onChange(new Set([opt.value]))}
                title={`Show only ${opt.label}`}
                className="px-2 py-1.5 text-[11px] text-text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-primary-text focus-visible:outline-none"
              >
                Only
              </button>
            </li>
          )
        })}
      </ul>
    </Popover>
  )
}
