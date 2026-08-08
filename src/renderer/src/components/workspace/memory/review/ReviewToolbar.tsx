import { Copy, Keyboard, Zap } from 'lucide-react'

import { Button, Popover } from '@renderer/components/common/ui'

interface ReviewToolbarProps {
  threshold: number
  onThresholdChange: (value: number) => void
  scanning: boolean
  onScan: () => void
  scanDisabledReason: string | null
  autoResolving: boolean
  onAutoResolve: () => void
  canAutoResolve: boolean
  message: string | null
}

const SHORTCUTS: [string, string][] = [
  ['j / k', 'Move down / up'],
  ['a', 'Keep newer, archive older'],
  ['s', 'Keep older, archive newer'],
  ['d', 'Dismiss — both valid'],
  ['x', 'Select for bulk action'],
  ['Enter', 'Expand the full comparison']
]

/**
 * Scan / auto-resolve / similarity threshold.
 *
 * The threshold slider live-filters the list, which is what makes the
 * "≥0.95" auto-resolve action self-explanatory instead of a magic number
 * baked into a button label.
 */
export default function ReviewToolbar({
  threshold,
  onThresholdChange,
  scanning,
  onScan,
  scanDisabledReason,
  autoResolving,
  onAutoResolve,
  canAutoResolve,
  message
}: ReviewToolbarProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 flex-wrap py-2 shrink-0">
      <Button
        variant="secondary"
        onClick={onScan}
        disabled={scanning || scanDisabledReason !== null}
        title={scanDisabledReason ?? 'Scan embedded memories for near-duplicates'}
      >
        <Copy className="w-3.5 h-3.5" />
        {scanning ? 'Scanning…' : 'Scan for duplicates'}
      </Button>

      {canAutoResolve && (
        <Button variant="success" onClick={onAutoResolve} disabled={autoResolving}>
          <Zap className="w-3.5 h-3.5" />
          {autoResolving ? 'Resolving…' : `Auto-resolve ≥${threshold.toFixed(2)}`}
        </Button>
      )}

      <label className="flex items-center gap-2 text-[11px] text-text-muted">
        Similarity ≥
        <input
          type="range"
          min={0.85}
          max={1}
          step={0.01}
          value={threshold}
          onChange={(e) => onThresholdChange(Number(e.target.value))}
          className="w-28 accent-primary"
          aria-label="Minimum similarity"
        />
        <span className="font-mono tabular-nums text-text-secondary w-8">
          {threshold.toFixed(2)}
        </span>
      </label>

      <div className="flex-1" />

      {message && <span className="text-[11px] text-text-muted">{message}</span>}

      <Popover
        align="end"
        className="w-64 p-2"
        trigger={(props) => (
          <button
            type="button"
            aria-label="Keyboard shortcuts"
            title="Keyboard triage"
            {...props}
            className="inline-flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-focus"
          >
            <Keyboard className="w-4 h-4" />
          </button>
        )}
      >
        <ul className="space-y-1 text-xs">
          {SHORTCUTS.map(([key, desc]) => (
            <li key={key} className="flex items-center justify-between gap-3">
              <kbd className="px-1.5 py-0.5 rounded bg-surface-overlay border border-border-default font-mono text-[11px] text-text-secondary">
                {key}
              </kbd>
              <span className="text-text-muted">{desc}</span>
            </li>
          ))}
        </ul>
      </Popover>
    </div>
  )
}
