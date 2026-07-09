/**
 * SectionCard — Shared card primitive for uniform chrome across the testing dashboard.
 *
 * Consistent header style, border radius, and background across
 * Run History, Charts, and Results sections.
 *
 * Supports optional lucide icon, collapsible body with chevron toggle,
 * and defaultOpen control.
 */

import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

interface SectionCardProps {
  title: string
  /** Lucide icon slot rendered before the title */
  icon?: React.ReactNode
  /** Optional right-aligned header slot (e.g. Cancel button, count) */
  action?: React.ReactNode
  /** Remove body padding for tables/lists that manage their own */
  flush?: boolean
  /** Header becomes a toggle button; body unmounts when closed */
  collapsible?: boolean
  /** Default expanded state when collapsible (default true) */
  defaultOpen?: boolean
  children: React.ReactNode
}

export default function SectionCard({
  title,
  icon,
  action,
  flush,
  collapsible,
  defaultOpen = true,
  children
}: SectionCardProps): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)

  const headerContent = (
    <>
      <div className="flex items-center gap-2">
        {collapsible && (
          open
            ? <ChevronDown size={14} className="text-text-muted shrink-0" />
            : <ChevronRight size={14} className="text-text-muted shrink-0" />
        )}
        {icon && <span className="text-text-muted shrink-0">{icon}</span>}
        <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
          {title}
        </h3>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </>
  )

  return (
    <div className="rounded-lg border border-border-subtle bg-surface-raised/40">
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-2.5 text-left hover:bg-surface-raised/50 transition-colors"
        >
          {headerContent}
        </button>
      ) : (
        <div className="flex items-center justify-between px-4 py-2.5">
          {headerContent}
        </div>
      )}
      {(!collapsible || open) && (
        <div className={flush ? '' : 'px-4 py-3'}>
          {children}
        </div>
      )}
    </div>
  )
}
