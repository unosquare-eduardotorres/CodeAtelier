import { useState, useEffect } from 'react'
import { AlertTriangle, Copy, Archive, X } from 'lucide-react'

import TierBadge from './TierBadge'
import type { MemoryContradiction, MemoryFact } from '../../../../../shared/types'

// ── Component ──

interface ContradictionCardProps {
  contradiction: MemoryContradiction
  /** Pre-loaded facts list — used for local resolution before falling back to IPC */
  allFacts?: MemoryFact[]
  /** Called when user resolves this contradiction */
  onResolve?: (id: string, resolution: string, keepFactId: string, archiveFactId?: string) => void
}

/** Truncate content for the excerpt view */
function excerpt(text: string, maxLen = 120): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen).trimEnd() + '…'
}

/** Check if this contradiction is a duplicate (from dedup scan) vs a genuine contradiction */
function isDuplicate(contradiction: MemoryContradiction): boolean {
  return contradiction.resolution?.startsWith('duplicate') ?? false
}

export default function ContradictionCard({
  contradiction,
  allFacts,
  onResolve
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
  const dup = isDuplicate(contradiction)

  return (
    <div
      className={`border rounded-md p-3 space-y-3 ${
        isPending
          ? dup
            ? 'border-info/40 bg-info/5'
            : 'border-warning'
          : 'border-border-default'
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        {dup ? (
          <Copy className="w-4 h-4 text-info" />
        ) : (
          <AlertTriangle className="w-4 h-4 text-warning" />
        )}
        <span className="text-sm font-medium text-text-primary">
          {dup ? 'Duplicate' : 'Contradiction'}
        </span>
        <span
          className={`px-1.5 py-0.5 text-xs rounded ${
            isPending ? 'bg-warning-muted text-warning' : 'bg-success-muted text-success'
          }`}
        >
          {contradiction.status}
        </span>
        {dup && contradiction.resolution && (
          <span className="text-[10px] text-text-muted font-mono ml-auto">
            {contradiction.resolution.match(/cosine:\s*[\d.]+/)?.[0] ?? ''}
          </span>
        )}
      </div>

      {/* Side-by-side comparison */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* Old fact */}
        <div className="bg-surface-overlay rounded-md p-2.5 space-y-1.5 border border-border-default">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wider text-text-muted font-medium">
              {dup ? 'Fact A (older)' : 'Old (superseded)'}
            </span>
          </div>
          {oldFact ? (
            <>
              <div className="flex items-center gap-1.5">
                <TierBadge tier={oldFact.tier} confidence={oldFact.confidence} />
              </div>
              <p className="text-xs font-medium text-text-primary">{oldFact.title}</p>
              <p className="text-[11px] text-text-secondary leading-relaxed">{excerpt(oldFact.content)}</p>
            </>
          ) : (
            <p className="text-xs text-text-muted font-mono">{contradiction.oldFactId.slice(0, 12)}…</p>
          )}
        </div>

        {/* New fact */}
        <div className={`bg-surface-overlay rounded-md p-2.5 space-y-1.5 border ${dup ? 'border-info/30' : 'border-success/30'}`}>
          <div className="flex items-center gap-1.5">
            <span className={`text-[10px] uppercase tracking-wider font-medium ${dup ? 'text-info' : 'text-success'}`}>
              {dup ? 'Fact B (newer)' : 'New (active)'}
            </span>
          </div>
          {newFact ? (
            <>
              <div className="flex items-center gap-1.5">
                <TierBadge tier={newFact.tier} confidence={newFact.confidence} />
              </div>
              <p className="text-xs font-medium text-text-primary">{newFact.title}</p>
              <p className="text-[11px] text-text-secondary leading-relaxed">{excerpt(newFact.content)}</p>
            </>
          ) : (
            <p className="text-xs text-text-muted font-mono">{contradiction.newFactId.slice(0, 12)}…</p>
          )}
        </div>
      </div>

      {/* Action buttons (pending only) */}
      {isPending && onResolve && oldFact && newFact && (
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={() => onResolve(contradiction.id, 'Kept newer fact, archived older', newFact.id, oldFact.id)}
            className="flex items-center gap-1 px-2.5 py-1 text-xs bg-surface-overlay text-text-secondary border border-border-default rounded hover:bg-surface-float hover:text-text-primary transition-colors"
          >
            <Archive className="w-3 h-3" />
            Archive old · keep new
          </button>
          <button
            onClick={() => onResolve(contradiction.id, 'Kept older fact, archived newer', oldFact.id, newFact.id)}
            className="flex items-center gap-1 px-2.5 py-1 text-xs bg-surface-overlay text-text-secondary border border-border-default rounded hover:bg-surface-float hover:text-text-primary transition-colors"
          >
            <Archive className="w-3 h-3" />
            Keep old · discard new
          </button>
          <button
            onClick={() => onResolve(contradiction.id, 'Dismissed — both facts are valid', newFact.id)}
            className="flex items-center gap-1 px-2.5 py-1 text-xs text-text-muted hover:text-text-secondary transition-colors"
          >
            <X className="w-3 h-3" />
            Dismiss
          </button>
        </div>
      )}

      {/* Explanation line */}
      {isPending && !onResolve && (
        <p className="text-[11px] text-text-muted leading-relaxed">
          {dup
            ? 'These facts are near-duplicates. Archive one to clean up.'
            : 'The newer fact automatically superseded the older one. Review and archive the old fact if the new one is correct.'}
        </p>
      )}

      {/* Resolution */}
      {contradiction.resolution && !isPending && (
        <p className="text-xs text-text-secondary">
          <span className="font-medium">Resolution:</span> {contradiction.resolution}
        </p>
      )}
    </div>
  )
}
