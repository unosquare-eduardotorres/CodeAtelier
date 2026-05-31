import type { ReactNode } from 'react'

/**
 * Generic data table with header styling matching TokenUsagePage conventions.
 * Replaces 3 nearly identical table patterns (Per-Agent, Per-Conversation, Recent Sessions).
 */
export default function UsageDataTable<T>({
  title,
  columns,
  rows,
  keyFn,
  emptyState
}: {
  title: string
  columns: Array<{
    header: string
    align?: 'left' | 'right'
    width?: string
    render: (row: T, index: number) => ReactNode
  }>
  rows: T[]
  keyFn: (row: T, index: number) => string | number
  emptyState?: ReactNode
}): React.JSX.Element {
  if (rows.length === 0 && emptyState) {
    return (
      <div className="mb-8">
        <h3 className="text-xs text-text-secondary uppercase tracking-wider mb-3 font-medium">
          {title}
        </h3>
        {emptyState}
      </div>
    )
  }

  if (rows.length === 0) return <></>

  return (
    <div className="mb-8">
      <h3 className="text-xs text-text-secondary uppercase tracking-wider mb-3 font-medium">
        {title}
      </h3>
      <div className="bg-surface-overlay border border-border-subtle rounded overflow-hidden shadow-sm">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border-subtle text-xs text-text-secondary uppercase tracking-wider">
              {columns.map((col) => (
                <th
                  key={col.header}
                  className={`${col.align === 'right' ? 'text-right' : 'text-left'} px-4 py-2.5 font-medium ${col.width ?? ''}`}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => (
              <tr
                key={keyFn(row, idx)}
                className="border-b border-border-subtle/50 last:border-b-0 hover:bg-surface-overlay/50"
              >
                {columns.map((col) => (
                  <td
                    key={col.header}
                    className={`px-4 py-2.5 ${col.align === 'right' ? 'text-right' : ''}`}
                  >
                    {col.render(row, idx)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
