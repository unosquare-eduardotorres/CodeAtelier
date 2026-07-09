import { useState, useEffect } from 'react'
import { AlertTriangle } from 'lucide-react'

import TierBadge from './TierBadge'
import type { MemoryContradiction, MemoryFact } from '../../../../../shared/types'

// ── Component ──

interface ContradictionCardProps {
  contradiction: MemoryContradiction
  /** Pre-loaded facts list — used for local resolution before falling back to IPC */
  allFacts?: MemoryFact[]
}

/** Truncate content for the excerpt view */
function excerpt(text: string, maxLen = 120): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen).trimEnd() + '…'
}

export default function ContradictionCard({
  contradiction,
  allFacts
}: ContradictionCardProps): React.JSX.Element {
  const [oldFact, setOldFact] = useState<MemoryFact | null>(null)
  const [newFact, setNewFact] = useState<MemoryFact | null>(null)

  // Resolve fact IDs to full fact objects
  useEffect(() => {
    const resolveLocal = (id: string): MemoryFact | undefined =>
      allFacts?.find((f) => f.id === id)

    const resolveFact = async (id: string): Promise<MemoryFact | null> => {
      // Try local first
      const local = resolveLocal(id)
      if (local) return local
      // Fall back to IPC
      try {
        return await window.api.memoryFactsGet({ id })
      } catch {
        return null
      }
    }

    void resolveFact(contradiction.oldFactId).then(setOldFact)
    void resolveFact(contradiction.newFactId).then(setNewFact)
  }, [contradiction.oldFactId, contradiction.newFactId, allFacts])

  const isPending = contradiction.status === 'pending'

  return (
    <div className={`border rounded-md p-3 space-y-3 ${isPending ? 'border-warning' : 'border-border'}`}>
      {/* Header */}
      <div className="flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-warning" />
        <span className="text-sm font-medium text-primary">Contradiction</span>
        <span
          className={`px-1.5 py-0.5 text-xs rounded ${
            isPending ? 'bg-warning-muted text-warning' : 'bg-success-muted text-success'
          }`}
        >
          {contradiction.status}
        </span>
      </div>

      {/* Side-by-side comparison */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* Old fact (superseded) */}
        <div className="bg-surface-overlay rounded-md p-2.5 space-y-1.5 border border-border">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wider text-tertiary font-medium">Old (superseded)</span>
          </div>
          {oldFact ? (
            <>
              <div className="flex items-center gap-1.5">
                <TierBadge tier={oldFact.tier} confidence={oldFact.confidence} />
              </div>
              <p className="text-xs font-medium text-primary">{oldFact.title}</p>
              <p className="text-[11px] text-secondary leading-relaxed">{excerpt(oldFact.content)}</p>
            </>
          ) : (
            <p className="text-xs text-tertiary font-mono">{contradiction.oldFactId.slice(0, 12)}…</p>
          )}
        </div>

        {/* New fact (active) */}
        <div className="bg-surface-overlay rounded-md p-2.5 space-y-1.5 border border-success/30">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wider text-success font-medium">New (active)</span>
          </div>
          {newFact ? (
            <>
              <div className="flex items-center gap-1.5">
                <TierBadge tier={newFact.tier} confidence={newFact.confidence} />
              </div>
              <p className="text-xs font-medium text-primary">{newFact.title}</p>
              <p className="text-[11px] text-secondary leading-relaxed">{excerpt(newFact.content)}</p>
            </>
          ) : (
            <p className="text-xs text-tertiary font-mono">{contradiction.newFactId.slice(0, 12)}…</p>
          )}
        </div>
      </div>

      {/* Explanation line */}
      {isPending && (
        <p className="text-[11px] text-tertiary leading-relaxed">
          The newer fact automatically superseded the older one. Review and archive the old fact if the new one is correct.
        </p>
      )}

      {/* Resolution */}
      {contradiction.resolution && (
        <p className="text-xs text-secondary">
          <span className="font-medium">Resolution:</span> {contradiction.resolution}
        </p>
      )}
    </div>
  )
}
