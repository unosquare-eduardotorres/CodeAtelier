import { useCallback, useMemo, useState } from 'react'
import { AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react'

import { useMemoryStore } from '@renderer/store'
import { Button } from '@renderer/components/common/ui'
import DuplicatePairRow from './DuplicatePairRow'
import ReviewToolbar from './ReviewToolbar'
import { useDuplicatePairs, type DuplicatePair } from './useDuplicatePairs'
import { useReviewKeyboard } from './useReviewKeyboard'

const PAGE_SIZE = 25

interface ReviewTabProps {
  workspaceId: string
}

/** Duplicate / contradiction triage queue. */
export default function ReviewTab({ workspaceId }: ReviewTabProps): React.JSX.Element {
  const {
    facts,
    contradictions,
    contradictionsPage,
    contradictionsTotal,
    contradictionsPendingCount,
    embeddingStatus,
    loadContradictions,
    resolveContradiction,
    autoResolveDuplicates,
    scanForDuplicates
  } = useMemoryStore()

  const [threshold, setThreshold] = useState(0.95)
  const [scanning, setScanning] = useState(false)
  const [autoResolving, setAutoResolving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [cursor, setCursor] = useState(0)

  const pairs = useDuplicatePairs(contradictions, facts)

  // Genuine contradictions carry no cosine, so they are never threshold-filtered.
  const visible = useMemo(
    () => pairs.filter((p) => p.cosine === null || p.cosine >= threshold),
    [pairs, threshold]
  )

  const resolve = useCallback(
    (pair: DuplicatePair, kind: 'keepNew' | 'keepOld' | 'dismiss') => {
      const { contradiction, oldFact, newFact } = pair
      if (!oldFact || !newFact) return
      if (kind === 'keepNew') {
        resolveContradiction(
          contradiction.id,
          'Kept newer fact, archived older',
          newFact.id,
          oldFact.id
        )
      } else if (kind === 'keepOld') {
        resolveContradiction(
          contradiction.id,
          'Kept older fact, archived newer',
          oldFact.id,
          newFact.id
        )
      } else {
        resolveContradiction(contradiction.id, 'Dismissed — both facts are valid', newFact.id)
      }
      setSelected((prev) => {
        const next = new Set(prev)
        next.delete(contradiction.id)
        return next
      })
    },
    [resolveContradiction]
  )

  const atCursor = visible[Math.min(cursor, visible.length - 1)] ?? null

  useReviewKeyboard({
    count: visible.length,
    cursor,
    setCursor,
    enabled: visible.length > 0,
    onKeepNew: () => atCursor && resolve(atCursor, 'keepNew'),
    onKeepOld: () => atCursor && resolve(atCursor, 'keepOld'),
    onDismiss: () => atCursor && resolve(atCursor, 'dismiss'),
    onToggleSelect: () => atCursor && toggleSelect(atCursor.contradiction.id),
    onToggleExpand: () => atCursor && toggleExpand(atCursor.contradiction.id)
  })

  function toggleSelect(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleExpand(id: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleScan = useCallback(async () => {
    setScanning(true)
    setMessage(null)
    const result = await scanForDuplicates(workspaceId)
    setMessage(
      result.clustersFound > 0 || result.autoMerged > 0
        ? `Found ${result.clustersFound} cluster${result.clustersFound !== 1 ? 's' : ''}, auto-merged ${result.autoMerged}`
        : 'No duplicates found'
    )
    setScanning(false)
  }, [workspaceId, scanForDuplicates])

  const handleAutoResolve = useCallback(async () => {
    setAutoResolving(true)
    setMessage(null)
    const result = await autoResolveDuplicates(workspaceId, threshold)
    setMessage(
      result.resolvedCount > 0
        ? `Auto-resolved ${result.resolvedCount} duplicate${result.resolvedCount !== 1 ? 's' : ''}`
        : 'Nothing above the threshold to resolve'
    )
    setAutoResolving(false)
  }, [workspaceId, threshold, autoResolveDuplicates])

  const bulkResolve = useCallback(() => {
    for (const pair of visible) {
      if (selected.has(pair.contradiction.id) && pair.contradiction.status === 'pending') {
        resolve(pair, 'keepNew')
      }
    }
    setSelected(new Set())
  }, [visible, selected, resolve])

  const pendingSelectable = visible.filter((p) => p.contradiction.status === 'pending')
  const allSelected =
    pendingSelectable.length > 0 && pendingSelectable.every((p) => selected.has(p.contradiction.id))

  return (
    <div className="flex flex-col flex-1 h-full min-h-0">
      <ReviewToolbar
        threshold={threshold}
        onThresholdChange={setThreshold}
        scanning={scanning}
        onScan={() => void handleScan()}
        scanDisabledReason={
          (embeddingStatus?.pendingCount ?? 0) > 0 ? 'Embed memories first' : null
        }
        autoResolving={autoResolving}
        onAutoResolve={() => void handleAutoResolve()}
        canAutoResolve={contradictionsTotal > 0}
        message={message}
      />

      {/* One reconciled count — the tab badge and the body used to disagree */}
      <div className="flex items-center gap-3 pb-2 text-[11px] text-text-muted shrink-0">
        <span className="font-mono tabular-nums">{contradictionsPendingCount} pending</span>
        <span aria-hidden="true">·</span>
        <span className="font-mono tabular-nums">
          {Math.max(0, contradictionsTotal - contradictionsPendingCount)} resolved
        </span>
        {visible.length !== contradictions.length && (
          <>
            <span aria-hidden="true">·</span>
            <span>
              {contradictions.length - visible.length} hidden below {threshold.toFixed(2)}
            </span>
          </>
        )}
      </div>

      {/* Bulk bar */}
      {pendingSelectable.length > 0 && (
        <div className="flex items-center gap-2 pb-2 shrink-0">
          <label className="flex items-center gap-1.5 text-[11px] text-text-muted">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() =>
                setSelected(
                  allSelected
                    ? new Set()
                    : new Set(pendingSelectable.map((p) => p.contradiction.id))
                )
              }
              className="accent-primary"
            />
            Select all {pendingSelectable.length} shown
          </label>
          {selected.size > 0 && (
            <>
              <Button variant="success" onClick={bulkResolve}>
                Archive older on {selected.size} selected
              </Button>
              <Button variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </>
          )}
        </div>
      )}

      {/* List */}
      <div className="flex-1 min-h-0 overflow-auto">
        {visible.length === 0 ? (
          <div className="text-center py-12 text-text-muted">
            <AlertTriangle className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p>No contradictions to review.</p>
          </div>
        ) : (
          visible.map((pair, i) => (
            <DuplicatePairRow
              key={pair.contradiction.id}
              pair={pair}
              expanded={expanded.has(pair.contradiction.id)}
              onToggleExpand={() => toggleExpand(pair.contradiction.id)}
              selected={selected.has(pair.contradiction.id)}
              onToggleSelect={() => toggleSelect(pair.contradiction.id)}
              focused={i === Math.min(cursor, visible.length - 1)}
              onKeepNew={(p) => resolve(p, 'keepNew')}
              onKeepOld={(p) => resolve(p, 'keepOld')}
              onDismiss={(p) => resolve(p, 'dismiss')}
            />
          ))
        )}

        {contradictionsTotal > PAGE_SIZE && (
          <div className="flex items-center justify-center gap-3 py-3">
            <Button
              variant="secondary"
              size="xs"
              onClick={() => loadContradictions(undefined, contradictionsPage - 1)}
              disabled={contradictionsPage === 0}
            >
              <ChevronLeft className="w-3 h-3" /> Previous
            </Button>
            <span className="text-[11px] text-text-muted">
              Page {contradictionsPage + 1} of {Math.ceil(contradictionsTotal / PAGE_SIZE)}
            </span>
            <Button
              variant="secondary"
              size="xs"
              onClick={() => loadContradictions(undefined, contradictionsPage + 1)}
              disabled={(contradictionsPage + 1) * PAGE_SIZE >= contradictionsTotal}
            >
              Next <ChevronRight className="w-3 h-3" />
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
