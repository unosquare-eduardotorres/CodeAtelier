import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued'
import { AlertTriangle, ArrowLeft, ArrowRight, ChevronDown, ChevronRight, X } from 'lucide-react'

import { Meter, Tooltip } from '@renderer/components/common/ui'
import { compactDiffStyles } from '@renderer/components/chat/diff-theme'
import TierBadge from '../TierBadge'
import { wordDiff, type DiffToken } from './word-diff'
import type { DuplicatePair } from './useDuplicatePairs'

export interface PairActions {
  onKeepNew: (pair: DuplicatePair) => void
  onKeepOld: (pair: DuplicatePair) => void
  onDismiss: (pair: DuplicatePair) => void
}

interface DuplicatePairRowProps extends PairActions {
  pair: DuplicatePair
  expanded: boolean
  onToggleExpand: () => void
  selected: boolean
  onToggleSelect: () => void
  /** Row under the keyboard cursor. */
  focused: boolean
}

const TOKEN_CLASS: Record<DiffToken['side'], string> = {
  same: '',
  a: 'bg-danger-muted text-danger rounded-sm',
  b: 'bg-success-muted text-success rounded-sm'
}

function DiffLine({ tokens }: { tokens: DiffToken[] }): React.JSX.Element {
  return (
    <span className="truncate">
      {tokens.map((t, i) => (
        <span key={i} className={TOKEN_CLASS[t.side]}>
          {t.text}
        </span>
      ))}
    </span>
  )
}

/**
 * One duplicate/contradiction pair on a single line.
 *
 * The previous card printed both facts in full with tier badges, confidence
 * bars and three long text buttons — ~150px each, so a page of 20 was a
 * 3000px wall of near-identical sentences and 60 repeated button labels.
 */
export default function DuplicatePairRow({
  pair,
  expanded,
  onToggleExpand,
  selected,
  onToggleSelect,
  focused,
  onKeepNew,
  onKeepOld,
  onDismiss
}: DuplicatePairRowProps): React.JSX.Element {
  const { contradiction, oldFact, newFact, cosine, isDuplicate } = pair
  const ready = oldFact !== null && newFact !== null
  const diff = ready ? wordDiff(oldFact.title, newFact.title) : null

  return (
    <div
      className={`rounded-md border transition-colors ${
        focused
          ? 'border-primary bg-surface-overlay/50'
          : expanded
            ? 'border-border-strong bg-surface-overlay/30'
            : 'border-transparent hover:border-border-default hover:bg-surface-overlay/20'
      }`}
    >
      <div className="flex items-center gap-2 h-11 px-2">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          aria-label={`Select pair ${contradiction.id}`}
          className="shrink-0 accent-primary"
        />

        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          className="shrink-0 text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-focus rounded"
          aria-label={expanded ? 'Collapse pair' : 'Expand pair'}
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </button>

        {isDuplicate && cosine !== null ? (
          <Tooltip content={`Cosine similarity ${cosine.toFixed(3)} — 1.000 is identical`}>
            <Meter
              value={cosine}
              tone={cosine >= 0.95 ? 'danger' : 'info'}
              label={cosine.toFixed(2)}
              width="w-10"
            />
          </Tooltip>
        ) : (
          <Tooltip content="Genuine contradiction — the newer fact superseded the older one">
            <AlertTriangle className="w-3.5 h-3.5 text-warning" />
          </Tooltip>
        )}

        {/* Word-diffed titles — red is only in the older fact, green only in the newer */}
        <div className="flex-1 min-w-0 grid grid-cols-2 gap-3 text-xs">
          {diff ? (
            <>
              <DiffLine tokens={diff.left} />
              <DiffLine tokens={diff.right} />
            </>
          ) : (
            <span className="col-span-2 font-mono text-text-muted">Loading pair…</span>
          )}
        </div>

        {ready && contradiction.status === 'pending' && (
          <div className="flex items-center gap-0.5 shrink-0">
            <Tooltip content="Keep newer, archive older (a)">
              <button
                type="button"
                onClick={() => onKeepNew(pair)}
                aria-label="Keep newer, archive older"
                className="p-1.5 rounded text-text-muted hover:text-success hover:bg-success-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-focus"
              >
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </Tooltip>
            <Tooltip content="Keep older, archive newer (s)">
              <button
                type="button"
                onClick={() => onKeepOld(pair)}
                aria-label="Keep older, archive newer"
                className="p-1.5 rounded text-text-muted hover:text-info hover:bg-info-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-focus"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
              </button>
            </Tooltip>
            <Tooltip content="Dismiss — both are valid (d)">
              <button
                type="button"
                onClick={() => onDismiss(pair)}
                aria-label="Dismiss, both facts are valid"
                className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-surface-float focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-focus"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </Tooltip>
          </div>
        )}
      </div>

      {expanded && ready && (
        <div className="px-2 pb-3 pl-9 space-y-2">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-text-muted">
              Older
              <TierBadge tier={oldFact.tier} confidence={oldFact.confidence} />
            </span>
            <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-text-muted">
              Newer
              <TierBadge tier={newFact.tier} confidence={newFact.confidence} />
            </span>
          </div>
          <div className="rounded overflow-hidden border border-border-subtle/50">
            <ReactDiffViewer
              oldValue={oldFact.content}
              newValue={newFact.content}
              splitView={false}
              useDarkTheme={true}
              compareMethod={DiffMethod.WORDS}
              showDiffOnly={false}
              styles={compactDiffStyles}
            />
          </div>
          {contradiction.resolution && contradiction.status !== 'pending' && (
            <p className="text-xs text-text-secondary">
              <span className="font-medium">Resolution:</span> {contradiction.resolution}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
