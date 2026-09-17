/**
 * BlueprintDropdown — shown when clicking the badge on the blueprint status indicator.
 * Lists every running blueprint across all workspaces (keyed by blueprintId).
 * Clicking an entry switches to that workspace (if needed) and focuses the run.
 */

import { LayoutGrid } from 'lucide-react'
import type { BlueprintStatusEntry } from '../hooks/useBlueprintStatusBar'

const PHASE_LABELS: Record<string, string> = {
  specify: 'Specifying',
  clarify: 'Clarifying',
  plan: 'Planning',
  tasks: 'Tasking',
  review: 'Reviewing',
  build: 'Building',
  'code-review': 'Code Review',
  verify: 'Verifying'
}

interface BlueprintDropdownProps {
  entries: BlueprintStatusEntry[]
  /** Focus a run — same-workspace focus or cross-workspace switch. */
  onSelect: (blueprintId: string, workspaceId: string) => void
  onClose: () => void
}

export function BlueprintDropdown({
  entries,
  onSelect,
  onClose
}: BlueprintDropdownProps): React.JSX.Element {
  return (
    <div className="absolute bottom-full right-0 mb-1 w-64 bg-surface-float border border-border-default rounded-lg shadow-xl z-50 p-1.5">
      <div className="px-2 py-1.5 text-[10px] font-medium text-text-muted uppercase tracking-wider">
        Running Blueprints
      </div>
      {entries.map((entry) => (
        <button
          key={entry.blueprintId}
          onClick={() => {
            onSelect(entry.blueprintId, entry.workspaceId)
            onClose()
          }}
          className="flex items-center gap-2 w-full px-2 py-2 rounded-md hover:bg-surface-overlay transition-colors text-left"
        >
          <LayoutGrid size={12} className="text-cyan-400 animate-pulse shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-medium text-text-primary truncate">
              {entry.blueprintTitle ?? entry.blueprintId.slice(0, 8)}
            </div>
            <div className="text-[10px] text-text-muted truncate">
              {entry.workspaceName} · {PHASE_LABELS[entry.currentPhase ?? ''] ?? 'Running…'}
            </div>
          </div>
        </button>
      ))}
    </div>
  )
}
