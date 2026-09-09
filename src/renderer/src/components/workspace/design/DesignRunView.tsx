/**
 * DesignRunView — live and completed view of a single design run.
 *
 * One pass per selected evaluate command down the left, the live stream or the
 * findings for the selected pass on the right, and the overall score in the
 * header. Deliberately smaller than HealthDetailPanel: a design run has no
 * per-track rerun, no plan step, and no handoff until P6.
 */

import { useMemo, useState } from 'react'
import {
  ChevronLeft,
  Palette,
  Loader2,
  Square,
  CheckCircle2,
  AlertTriangle,
  Ban
} from 'lucide-react'
import { useDesignStore } from '@renderer/store'
import {
  DESIGN_COMMANDS_BY_ID,
  designCommandFromTrackId
} from '../../../../../shared/design-commands'
import type { AuditResult, AuditTrackId } from '../../../../../shared/types'
import ScoreGauge from '../ScoreGauge'
import DesignStreamView from './DesignStreamView'
import DesignFindingsList from './DesignFindingsList'

interface DesignRunViewProps {
  onBack: () => void
}

/** `design:critique` → `Critique`; falls back to the raw id for stale rows. */
function commandName(trackId: AuditTrackId): string {
  const commandId = designCommandFromTrackId(trackId)
  return commandId ? DESIGN_COMMANDS_BY_ID[commandId].name : trackId
}

function ResultIcon({ status }: { status: AuditResult['status'] }): React.JSX.Element {
  switch (status) {
    case 'completed':
      return <CheckCircle2 size={13} className="text-success shrink-0" />
    case 'failed':
      return <AlertTriangle size={13} className="text-danger shrink-0" />
    case 'cancelled':
      return <Ban size={13} className="text-text-muted shrink-0" />
    case 'running':
      return <Loader2 size={13} className="text-info animate-spin shrink-0" />
    default:
      return (
        <div className="w-[13px] h-[13px] rounded-full border border-border-default shrink-0" />
      )
  }
}

export default function DesignRunView({ onBack }: DesignRunViewProps): React.JSX.Element {
  const currentRun = useDesignStore((s) => s.currentRun)
  const isRunning = useDesignStore((s) => s.isRunning)
  const selectedFindings = useDesignStore((s) => s.selectedFindings)
  const toggleFinding = useDesignStore((s) => s.toggleFinding)
  const cancelDesign = useDesignStore((s) => s.cancelDesign)

  const results = useMemo(() => currentRun?.results ?? [], [currentRun])

  // Auto-follow the running pass until the user picks one. Derived rather than
  // synced in an effect: `currentRun` is replaced on every progress event, so an
  // effect would re-run per chunk just to compute a value that is a pure
  // function of the results it already has.
  const [pinnedTrackId, setPinnedTrackId] = useState<AuditTrackId | null>(null)
  const runningTrackId = results.find((r) => r.status === 'running')?.trackId ?? null
  const active =
    results.find((r) => r.trackId === pinnedTrackId) ??
    results.find((r) => r.trackId === runningTrackId) ??
    results[0] ??
    null
  const activeTrackId = active?.trackId ?? null
  const completedCount = results.filter((r) => r.status === 'completed').length

  if (!currentRun) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <Loader2 size={32} className="text-primary-text animate-spin" />
        <span className="text-sm text-text-secondary">Starting design review…</span>
      </div>
    )
  }

  return (
    <div data-testid="design-run-view" className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-subtle bg-surface-raised">
        <div className="flex items-center gap-2">
          {/*
            Never disabled. `isRunning` is derived from the persisted run status,
            so a row left at 'running' by a crash used to lock the user inside
            this view with no way out. Leaving mid-run is harmless anyway — the
            run keeps streaming into the store and the landing page shows it.
          */}
          <button
            onClick={onBack}
            className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
            title="Back to design history"
          >
            <ChevronLeft size={16} />
          </button>
          <Palette size={16} className="text-purple-400" />
          <h2 className="text-sm font-bold text-text-primary">Design Review</h2>
        </div>

        {currentRun.overallScore != null && (
          <div className="flex items-center gap-2">
            <ScoreGauge score={currentRun.overallScore} size={36} />
            <span className="text-xs text-text-secondary">
              {completedCount}/{results.length} passes
            </span>
          </div>
        )}

        {isRunning && (
          <button
            data-testid="design-cancel-btn"
            onClick={() => void cancelDesign()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-danger/10 text-danger hover:bg-danger/20 transition-colors"
          >
            <Square size={12} />
            Cancel
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        <div className="w-56 shrink-0 border-r border-border-subtle overflow-y-auto p-2 space-y-1">
          {currentRun.designConfig?.brief && (
            <p className="px-2 py-2 text-[11px] text-text-muted italic border-b border-border-subtle mb-1">
              “{currentRun.designConfig.brief}”
            </p>
          )}
          {results.map((result) => {
            const isActive = result.trackId === activeTrackId
            return (
              <button
                key={result.trackId}
                data-testid="design-pass-tab"
                data-track-id={result.trackId}
                onClick={() => setPinnedTrackId(result.trackId)}
                className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left transition-colors ${
                  isActive
                    ? 'bg-primary-muted text-primary-text border border-primary/20'
                    : 'text-text-secondary hover:bg-surface-overlay border border-transparent'
                }`}
              >
                <ResultIcon status={result.status} />
                <span className="text-xs font-medium truncate flex-1">
                  {commandName(result.trackId)}
                </span>
                {result.score != null && (
                  <span className="text-[10px] text-text-muted">{result.score}</span>
                )}
              </button>
            )
          })}

          {/* Refine cards never execute — say so rather than leave them invisible. */}
          {(currentRun.designConfig?.commandIds.length ?? 0) > results.length && (
            <p className="px-2 pt-3 text-[10px] text-text-muted leading-relaxed">
              Also selected:{' '}
              {(currentRun.designConfig?.commandIds ?? [])
                .filter((id) => !results.some((r) => designCommandFromTrackId(r.trackId) === id))
                .map((id) => DESIGN_COMMANDS_BY_ID[id]?.name ?? id)
                .join(', ')}{' '}
              — these shape the review rather than running as their own pass.
            </p>
          )}
        </div>

        <div className="flex-1 min-w-0 flex flex-col">
          {active === null ? (
            <div className="flex-1 flex items-center justify-center text-xs text-text-muted">
              No passes in this run.
            </div>
          ) : active.status === 'running' || active.findings.length === 0 ? (
            <DesignStreamView
              trackId={active.trackId}
              commandName={commandName(active.trackId)}
              isStreaming={active.status === 'running'}
            />
          ) : (
            <div className="flex-1 overflow-y-auto p-4">
              {active.summary && (
                <p className="text-xs text-text-secondary mb-3">{active.summary}</p>
              )}
              <DesignFindingsList
                findings={active.findings}
                selectedFindings={selectedFindings}
                onToggle={toggleFinding}
                commandName={commandName(active.trackId)}
                score={active.score}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
