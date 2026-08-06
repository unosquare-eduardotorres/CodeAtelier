/**
 * RunProgressPanel — the live numbers for an ingestion run.
 *
 * Everything here is item-derived. The old panel drew the bar from
 * `(phaseIndex + 0.5) / 7`, so it jumped 14% at a time and sat frozen for the
 * entire Docs phase; this one moves once per document.
 */

import { Loader2, CheckCircle, PauseCircle, AlertTriangle } from 'lucide-react'
import type { BootstrapProgress, BootstrapPhaseLabel } from '../../../../../../shared/types'
import { PHASE_INFO, DEEP_SCAN_PHASES, FULL_PHASES, formatDuration } from './phase-meta'
import { itemLabel, detailLine } from './detail-line'

function PhaseStep({
  phase,
  progress
}: {
  phase: BootstrapPhaseLabel
  progress: BootstrapProgress
}): React.JSX.Element {
  const info = PHASE_INFO[phase]
  const stats = progress.perPhase[phase]
  const isCurrent = progress.phaseLabel === phase && progress.jobStatus === 'running'
  const isDone = stats ? stats.done >= stats.total && stats.total > 0 : false
  // preflight/finalize have no items — fall back to phase ordering for them.
  const phases = progress.mode === 'deep-scan' ? DEEP_SCAN_PHASES : FULL_PHASES
  const passed = phases.indexOf(phase) < progress.phaseIndex

  const complete = stats ? isDone : passed

  return (
    <div
      className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors ${
        isCurrent
          ? 'bg-teal/15 text-teal border border-teal/30'
          : complete
            ? 'bg-green-500/10 text-green-400'
            : 'text-text-muted'
      }`}
      title={info?.description}
    >
      {isCurrent ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : complete ? (
        <CheckCircle className="w-3.5 h-3.5" />
      ) : (
        (info?.icon ?? <div className="w-3.5 h-3.5" />)
      )}
      <span>{info?.label ?? phase}</span>
      {stats && stats.total > 0 && (
        <span className="font-mono text-[10px] opacity-70">
          {stats.done}/{stats.total}
        </span>
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-text-muted">{label}</span>
      <span className="text-sm font-medium text-text-primary tabular-nums">{value}</span>
    </div>
  )
}

export default function RunProgressPanel({
  progress
}: {
  progress: BootstrapProgress
}): React.JSX.Element {
  const phases = progress.mode === 'deep-scan' ? DEEP_SCAN_PHASES : FULL_PHASES
  const settled = progress.itemsDone + progress.itemsSkipped + progress.itemsFailed
  const percent =
    progress.itemsTotal > 0 ? Math.min(100, Math.round((settled / progress.itemsTotal) * 100)) : 0

  const isPaused = progress.jobStatus === 'paused'
  const isError = progress.jobStatus === 'error'
  const isDone = progress.jobStatus === 'done'

  const barColor = isError
    ? 'bg-red-500'
    : isDone
      ? 'bg-green-500'
      : isPaused
        ? 'bg-purple-400'
        : 'bg-teal'

  const memoriesPerItem =
    progress.itemsDone > 0 ? (progress.factsCreated / progress.itemsDone).toFixed(1) : '—'

  const label = itemLabel(progress)
  const detail = detailLine(progress)

  return (
    <div className="space-y-3">
      {/* Phase stepper with real per-phase counts */}
      <div className="flex flex-wrap gap-1.5">
        {phases.map((phase) => (
          <PhaseStep key={phase} phase={phase} progress={progress} />
        ))}
      </div>

      {/* Item-based progress bar */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs gap-3">
          <span className="text-text-secondary truncate flex items-center gap-1.5 min-w-0">
            {isPaused && <PauseCircle className="w-3.5 h-3.5 text-purple-400 shrink-0" />}
            {isError && <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0" />}
            <span className="truncate">{label ?? progress.message}</span>
          </span>
          <span className="text-text-muted font-mono shrink-0 tabular-nums">
            {settled}/{progress.itemsTotal} · {percent}%
          </span>
        </div>

        <div className="h-1.5 bg-surface-overlay rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-300 ${barColor}`}
            style={{ width: `${percent}%` }}
          />
        </div>

        {detail && <div className="text-[11px] text-text-muted truncate">{detail}</div>}
      </div>

      {/* Live metrics */}
      <div className="grid grid-cols-4 gap-3 pt-1">
        <Metric label="Memories" value={String(progress.factsCreated)} />
        <Metric label="Per item" value={memoriesPerItem} />
        <Metric
          label="Rate"
          value={progress.itemsPerMinute !== null ? `${progress.itemsPerMinute}/min` : '—'}
        />
        <Metric
          label="ETA"
          value={progress.etaSeconds !== null ? formatDuration(progress.etaSeconds) : '—'}
        />
      </div>

      {(progress.itemsSkipped > 0 || progress.itemsFailed > 0) && (
        <div className="flex gap-3 text-[11px] text-text-muted">
          {progress.itemsSkipped > 0 && <span>{progress.itemsSkipped} unchanged/skipped</span>}
          {progress.itemsFailed > 0 && (
            <span className="text-red-400">{progress.itemsFailed} failed</span>
          )}
        </div>
      )}
    </div>
  )
}
