/**
 * SaveBar — one save control for the whole Configure tab.
 *
 * Pinned to the bottom of the viewport rather than placed after the last
 * section, because the sections are collapsible and tall: the old per-card Save
 * button sat below an expanded model list and was routinely off-screen at the
 * moment the user wanted it.
 *
 * Only rendered when there is something to save, so it costs nothing when idle.
 */

import { Loader2, Save } from 'lucide-react'

interface SaveBarProps {
  /** Number of distinct unsaved decisions — 0 hides the bar entirely. */
  changeCount: number
  saving: boolean
  onSave: () => void
  onDiscard: () => void
}

export default function SaveBar({
  changeCount,
  saving,
  onSave,
  onDiscard
}: SaveBarProps): React.JSX.Element | null {
  if (changeCount === 0) return null

  return (
    <div
      data-testid="model-config-save-bar"
      className="sticky bottom-0 z-10 -mx-6 mt-6 px-6 py-3 border-t border-border-default bg-surface-float/95 backdrop-blur"
    >
      <div className="flex items-center gap-3">
        <span className="inline-flex items-center gap-1.5 text-xs text-amber-400">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
          {changeCount} unsaved change{changeCount !== 1 ? 's' : ''}
        </span>
        <button
          onClick={onSave}
          disabled={saving}
          className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg text-white bg-primary hover:bg-primary-hover transition-colors disabled:opacity-50"
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          Save
        </button>
        <button
          onClick={onDiscard}
          disabled={saving}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg text-text-secondary border border-border-default hover:bg-surface-hover transition-colors disabled:opacity-50"
        >
          Discard
        </button>
      </div>
    </div>
  )
}
