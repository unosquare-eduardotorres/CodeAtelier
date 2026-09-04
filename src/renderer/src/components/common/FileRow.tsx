/**
 * FileRow — the shared file row used by every file-list surface
 * (PLAN chips, BUILD created/modified lists, VERIFY modified files).
 *
 * Variants:
 *  - compact: inline mono chip with a language icon — for planned files with
 *    no disk presence yet (no status chip / counts).
 *  - full: list row with language icon, truncated mono path, status chip
 *    (Modified/Added/Deleted) and `+N −M` line counts.
 *
 * Rows with an `onClick` render as a <button> (respecting `disabled`);
 * without one they render as a static <span> — never a dead button.
 */
import { memo } from 'react'
import FileLanguageIcon from './FileLanguageIcon'

/** Git-style change status. */
export type FileStatus = 'M' | 'A' | 'D'

const STATUS_CONFIG: Record<FileStatus, { label: string; className: string }> = {
  M: { label: 'Modified', className: 'text-amber-400' },
  A: { label: 'Added', className: 'text-emerald-400' },
  D: { label: 'Deleted', className: 'text-danger' }
}

interface FileRowProps {
  path: string
  status?: FileStatus
  additions?: number
  deletions?: number
  /** Open handler — presence switches the row from static span to button. */
  onClick?: () => void
  /** Inline chip form (PLAN-style) instead of a full-width list row. */
  compact?: boolean
  disabled?: boolean
  selected?: boolean
}

function FileRow({
  path,
  status,
  additions,
  deletions,
  onClick,
  compact = false,
  disabled = false,
  selected = false
}: FileRowProps): React.JSX.Element {
  const statusConfig = status ? STATUS_CONFIG[status] : undefined
  const showCounts = additions != null || deletions != null
  const interactive = Boolean(onClick)

  // Compact chip — mirrors the old FileChips look, plus a language icon.
  if (compact) {
    const className =
      'inline-flex items-center gap-1 font-mono text-xs bg-surface-inset px-1.5 py-0.5 rounded text-text-muted leading-tight transition-colors' +
      (interactive && !disabled ? ' cursor-pointer hover:bg-surface-hover/60' : '') +
      (disabled ? ' opacity-50' : '')
    const content = (
      <>
        <FileLanguageIcon filePath={path} size={12} />
        {path}
      </>
    )
    return interactive ? (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={className}
        title={path}
        data-testid="file-row"
      >
        {content}
      </button>
    ) : (
      <span className={className} title={path} data-testid="file-row">
        {content}
      </span>
    )
  }

  // Full list row.
  const stateClass = selected
    ? 'bg-surface-overlay'
    : disabled
      ? 'opacity-50 cursor-not-allowed'
      : 'hover:bg-surface-overlay/50'
  const className = `w-full flex items-center gap-2 px-3 py-2 text-left min-w-0 transition-colors ${stateClass}`
  const content = (
    <>
      <FileLanguageIcon filePath={path} size={14} />
      <span className="font-mono text-[11px] truncate min-w-0 flex-1">{path}</span>
      {statusConfig && (
        <span className={`text-[10px] font-medium flex-shrink-0 ${statusConfig.className}`}>
          {statusConfig.label}
        </span>
      )}
      {showCounts && (
        <span className="text-[10px] tabular-nums flex-shrink-0">
          {additions != null && <span className="text-emerald-400">+{additions}</span>}
          {additions != null && deletions != null ? ' ' : ''}
          {deletions != null && <span className="text-danger">−{deletions}</span>}
        </span>
      )}
    </>
  )
  return interactive ? (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={className}
      title={path}
      data-testid="file-row"
    >
      {content}
    </button>
  ) : (
    <span className={className} title={path} data-testid="file-row">
      {content}
    </span>
  )
}

export default memo(FileRow)
