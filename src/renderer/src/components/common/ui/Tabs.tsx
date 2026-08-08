import { useRef, type ReactNode } from 'react'

export interface TabItem<T extends string> {
  key: T
  label: string
  /** Rendered as a dim count next to the label. */
  badge?: ReactNode
  /** Passed straight through as data-testid so E2E hooks survive. */
  testId?: string
  icon?: ReactNode
}

interface TabsProps<T extends string> {
  items: readonly TabItem<T>[]
  value: T
  onChange: (key: T) => void
  ariaLabel: string
  /** Namespaces the generated tab/panel ids. */
  idPrefix?: string
  className?: string
}

/**
 * Keyboard-navigable tab rail (WAI-ARIA roving tabindex).
 *
 * Replaces the hand-rolled row of buttons that had no tablist role, no
 * aria-selected, no arrow-key movement and no focus ring.
 */
export default function Tabs<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  idPrefix = 'tab',
  className = ''
}: TabsProps<T>): React.JSX.Element {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})

  const move = (delta: number): void => {
    const idx = items.findIndex((i) => i.key === value)
    if (idx < 0) return
    const next = items[(idx + delta + items.length) % items.length]
    onChange(next.key)
    refs.current[next.key]?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault()
        move(1)
        break
      case 'ArrowLeft':
        e.preventDefault()
        move(-1)
        break
      case 'Home':
        e.preventDefault()
        onChange(items[0].key)
        refs.current[items[0].key]?.focus()
        break
      case 'End': {
        e.preventDefault()
        const last = items[items.length - 1]
        onChange(last.key)
        refs.current[last.key]?.focus()
        break
      }
    }
  }

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      className={`flex items-center gap-0.5 ${className}`}
    >
      {items.map((item) => {
        const selected = item.key === value
        return (
          <button
            key={item.key}
            ref={(el) => {
              refs.current[item.key] = el
            }}
            role="tab"
            id={`${idPrefix}-${item.key}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}panel-${item.key}`}
            tabIndex={selected ? 0 : -1}
            data-testid={item.testId}
            onClick={() => onChange(item.key)}
            className={`relative inline-flex items-center gap-1.5 h-8 px-3 text-sm rounded-t-md transition-colors
              focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-focus ${
                selected
                  ? 'text-text-primary'
                  : 'text-text-muted hover:text-text-secondary hover:bg-surface-overlay/60'
              }`}
          >
            {item.icon}
            {item.label}
            {item.badge !== undefined && item.badge !== null && (
              <span className="font-mono text-[11px] tabular-nums text-text-muted">
                {item.badge}
              </span>
            )}
            {selected && (
              <span className="absolute inset-x-1 -bottom-px h-px bg-primary" aria-hidden="true" />
            )}
          </button>
        )
      })}
    </div>
  )
}
