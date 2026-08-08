import { AlertTriangle, CircleDot, RefreshCw, Zap } from 'lucide-react'

import { Button, StatPill } from '@renderer/components/common/ui'
import type { MemoryEmbeddingStatus } from '../../../../../shared/types'

export interface EmbeddingStatusProps {
  status: MemoryEmbeddingStatus | null
  backfillProgress: { running: boolean; processed: number; total: number } | null
  backfillError: string | null
  onBackfill: () => void
  onDismissError: () => void
}

/**
 * Always-visible header readout.
 *
 * The steady state ("model · 2723 of 2723 embedded") used to occupy a
 * full-width bar reporting a fact that never changes — it is a pill now.
 */
export function EmbeddingChip({
  status,
  backfillProgress,
  backfillError
}: Pick<
  EmbeddingStatusProps,
  'status' | 'backfillProgress' | 'backfillError'
>): React.JSX.Element | null {
  if (!status) return null

  const embedded = status.totalCount - status.pendingCount
  const running = backfillProgress?.running === true

  if (backfillError) {
    return (
      <StatPill
        tone="danger"
        icon={<AlertTriangle className="w-3 h-3" />}
        label="Embedding"
        value="error"
      />
    )
  }
  if (running && backfillProgress) {
    const pct =
      backfillProgress.total > 0
        ? Math.round((backfillProgress.processed / backfillProgress.total) * 100)
        : 0
    return (
      <StatPill
        tone="info"
        icon={<CircleDot className="w-3 h-3 animate-pulse" />}
        label="Embedding"
        value={`${pct}%`}
      />
    )
  }
  if (!status.isReady) {
    return (
      <StatPill
        tone="warning"
        icon={<CircleDot className="w-3 h-3" />}
        label="Model"
        value="offline"
      />
    )
  }

  return (
    <StatPill
      tone={status.pendingCount > 0 ? 'warning' : 'success'}
      icon={<CircleDot className="w-3 h-3" />}
      label={status.modelName ?? 'Embedding'}
      value={`${embedded}/${status.totalCount}`}
      title={
        status.pendingCount > 0
          ? `${status.pendingCount} memories are not embedded yet`
          : 'Every memory is embedded and semantically searchable'
      }
    />
  )
}

/**
 * The full-width bar, rendered only when there is something to act on —
 * error, offline, running, or memories still waiting to be embedded.
 *
 * Owns its own spacing so callers do not need an `empty:hidden` wrapper to
 * avoid a stray gap in the steady state.
 */
export function EmbeddingBar(props: EmbeddingStatusProps): React.JSX.Element | null {
  const body = embeddingBarBody(props)
  if (!body) return null
  return <div className="shrink-0 mb-3">{body}</div>
}

function embeddingBarBody({
  status,
  backfillProgress,
  backfillError,
  onBackfill,
  onDismissError
}: EmbeddingStatusProps): React.JSX.Element | null {
  if (!status) return null

  const isRunning = backfillProgress?.running === true

  if (backfillError) {
    return (
      <div className="flex items-center gap-3 px-4 py-2 bg-danger-muted border border-danger/30 rounded-md">
        <AlertTriangle className="w-3.5 h-3.5 text-danger shrink-0" />
        <span className="flex-1 text-danger text-xs">{backfillError}</span>
        <Button
          variant="secondary"
          onClick={() => {
            onDismissError()
            onBackfill()
          }}
        >
          <RefreshCw className="w-3 h-3" /> Retry
        </Button>
      </div>
    )
  }

  if (!status.isReady && !isRunning) {
    return (
      <div className="flex items-center gap-3 px-4 py-2 bg-surface-overlay border border-border-default rounded-md">
        <CircleDot className="w-3.5 h-3.5 text-warning shrink-0" />
        <span className="flex-1 text-text-secondary text-xs">Embedding model offline</span>
        <Button variant="secondary" onClick={onBackfill}>
          <RefreshCw className="w-3 h-3" /> Retry &amp; Embed
        </Button>
      </div>
    )
  }

  if (isRunning && backfillProgress) {
    const pct =
      backfillProgress.total > 0
        ? Math.round((backfillProgress.processed / backfillProgress.total) * 100)
        : 0
    return (
      <div className="px-4 py-2 bg-surface-overlay border border-border-default rounded-md space-y-1.5">
        <div className="flex items-center gap-3 text-xs">
          <CircleDot className="w-3.5 h-3.5 text-info shrink-0 animate-pulse" />
          <span className="flex-1 text-text-secondary">
            Embedding… {backfillProgress.processed} / {backfillProgress.total}
          </span>
          <span className="font-mono tabular-nums text-text-muted">{pct}%</span>
        </div>
        <div className="w-full h-1 bg-border-default rounded-full overflow-hidden">
          <div
            className="h-full bg-info rounded-full transition-all duration-300 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    )
  }

  if (status.pendingCount > 0) {
    return (
      <div className="flex items-center gap-3 px-4 py-2 bg-surface-overlay border border-border-default rounded-md">
        <CircleDot className="w-3.5 h-3.5 text-warning shrink-0" />
        <span className="flex-1 text-text-secondary text-xs">
          {status.pendingCount} memories are waiting to be embedded — they will not appear in
          semantic search until they are.
        </span>
        <Button variant="primary" onClick={onBackfill}>
          <Zap className="w-3 h-3" /> Embed Now
        </Button>
      </div>
    )
  }

  // Fully embedded — the chip in the header already says so.
  return null
}
