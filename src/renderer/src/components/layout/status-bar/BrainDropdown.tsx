/**
 * BrainDropdown — shown when clicking the badge on the Feed Brain status
 * indicator. Lists background workspaces that are ingesting or paused.
 * Clicking an entry switches to that workspace's Memory page.
 */

import { Brain, PauseCircle } from 'lucide-react'
import type { BootstrapStatusEntry } from '../hooks/useBootstrapStatusBar'

interface BrainDropdownProps {
  entries: BootstrapStatusEntry[]
  onSelect: (workspaceId: string) => void
  onClose: () => void
}

export function BrainDropdown({
  entries,
  onSelect,
  onClose
}: BrainDropdownProps): React.JSX.Element {
  return (
    <div className="absolute bottom-full right-0 mb-1 w-64 bg-surface-float border border-border-default rounded-lg shadow-xl z-50 p-1.5">
      <div className="px-2 py-1.5 text-[10px] font-medium text-text-muted uppercase tracking-wider">
        Feeding Brain
      </div>
      {entries.map((entry) => {
        const paused = entry.jobStatus === 'paused'
        return (
          <button
            key={entry.workspaceId}
            onClick={() => {
              onSelect(entry.workspaceId)
              onClose()
            }}
            className="flex items-center gap-2 w-full px-2 py-2 rounded-md hover:bg-surface-overlay transition-colors text-left"
          >
            {paused ? (
              <PauseCircle size={12} className="text-purple-400 shrink-0" />
            ) : (
              <Brain size={12} className="text-teal animate-pulse shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-medium text-text-primary truncate">
                {entry.workspaceName}
              </div>
              <div className="text-[10px] text-text-muted">
                {paused ? 'Paused' : `${entry.percent}%`} · {entry.itemsDone}/{entry.itemsTotal}{' '}
                items · {entry.factsCreated} memories
              </div>
            </div>
          </button>
        )
      })}
    </div>
  )
}
