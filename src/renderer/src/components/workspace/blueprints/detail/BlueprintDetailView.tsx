/**
 * BlueprintDetailView — top-level component for viewing a past or in-progress
 * blueprint run. Replaces the inline detail view that was in BlueprintPage.tsx.
 *
 * Layout:
 *   ┌─ Header card (title, status, priority, duration, created) ──┐
 *   │   ▸ Description (markdown, collapsed, gradient fade)        │
 *   ├─ OutcomeSummary (complete runs only) ───────────────────────┤
 *   ├─ Error/Stopped/Interrupted banners ─────────────────────────┤
 *   └─ PhaseJourney (accordion list of all phases) ───────────────┘
 */

import { useState, type JSX } from 'react'
import {
  StopCircle,
  Clock,
  XCircle,
  RotateCcw,
  PlayCircle,
  ChevronDown
} from 'lucide-react'
import type { BlueprintWithDetails } from '../../../../../../shared/blueprint-types'
import { StatusBadge } from '../StatusBadge'
import { formatTimeAgo } from '../utils'
import { BlueprintMarkdown } from '../BlueprintMarkdown'
import { PhaseJourney } from './PhaseJourney'
import { OutcomeSummary } from './OutcomeSummary'
import { getOutcomeStats, formatDuration } from './phase-summaries'

// ── Markdown Description Block (collapsible) ──

function DescriptionBlock({ description }: { description: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="relative">
      <div className={expanded ? '' : 'max-h-40 overflow-hidden'}>
        <BlueprintMarkdown>{description}</BlueprintMarkdown>
      </div>
      {!expanded && (
        <div className="absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-surface-raised to-transparent pointer-events-none" />
      )}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-xs text-accent hover:text-accent/80 font-medium mt-1 transition-colors"
      >
        <ChevronDown size={12} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
        {expanded ? 'Show less' : 'Show more'}
      </button>
    </div>
  )
}

// ── Mid-pipeline statuses (orphaned — pipeline not running) ──

const MID_PIPELINE_STATUSES = new Set([
  'specifying', 'clarifying', 'planning', 'tasking', 'reviewing', 'building', 'verifying'
])

// ── Props ──

interface BlueprintDetailViewProps {
  selectedId: string
  currentBlueprint: BlueprintWithDetails | null
  lastError: { blueprintId: string; message: string } | null
  isRunning: boolean
  onBack: () => void
  onRetryPhase: () => void
}

// ── Component ──

export function BlueprintDetailView({
  selectedId,
  currentBlueprint,
  lastError,
  isRunning,
  onBack,
  onRetryPhase
}: BlueprintDetailViewProps): JSX.Element {
  if (!currentBlueprint || currentBlueprint.id !== selectedId) {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
          ← Back to list
        </button>
        <div className="text-xs text-text-muted animate-pulse text-center py-8">
          Loading blueprint...
        </div>
      </div>
    )
  }

  const bp = currentBlueprint
  const isComplete = bp.status === 'complete'
  const outcomeStats = isComplete ? getOutcomeStats(bp.phases, bp.tasks) : null

  // Compute total duration for header
  const startTimes = bp.phases.map((p) => p.startedAt).filter(Boolean) as string[]
  const endTimes = bp.phases.map((p) => p.completedAt).filter(Boolean) as string[]
  let totalDuration: string | null = null
  if (startTimes.length > 0 && endTimes.length > 0) {
    const earliest = new Date(Math.min(...startTimes.map((s) => new Date(s).getTime()))).toISOString()
    const latest = new Date(Math.max(...endTimes.map((s) => new Date(s).getTime()))).toISOString()
    totalDuration = formatDuration(earliest, latest)
  }

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="text-xs text-text-secondary hover:text-text-primary transition-colors"
      >
        ← Back to list
      </button>

      {/* ── Header Card ── */}
      <div className="bg-surface-raised rounded-xl border border-border-subtle p-4 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <h4 className="text-sm font-semibold text-text-primary">
            {bp.title}
          </h4>
          <StatusBadge status={bp.status} />
          <span className="text-[10px] text-text-muted">{bp.priority}</span>
          {totalDuration && (
            <span className="text-[10px] text-text-muted flex items-center gap-1">
              <Clock size={10} />
              {totalDuration}
            </span>
          )}
        </div>
        {bp.description && (
          <DescriptionBlock description={bp.description} />
        )}
        <div className="flex items-center gap-2 text-[10px] text-text-muted">
          <Clock size={10} />
          <span>Created {formatTimeAgo(new Date(bp.createdAt))}</span>
        </div>
      </div>

      {/* ── Outcome Summary (complete runs only) ── */}
      {outcomeStats && (
        <OutcomeSummary stats={outcomeStats} />
      )}

      {/* ── Failed phase error banner with retry ── */}
      {bp.status === 'failed' && (() => {
        const failedPhase = bp.phases.find((p) => p.status === 'failed')
        const errorMsg = lastError?.blueprintId === bp.id ? lastError.message : null
        return failedPhase ? (
          <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-danger/20 bg-danger-muted text-danger">
            <XCircle size={16} className="mt-0.5 flex-shrink-0" />
            <div className="flex flex-col gap-0.5 flex-1">
              <span className="text-sm font-medium">
                {failedPhase.phase.charAt(0).toUpperCase() + failedPhase.phase.slice(1)} phase failed
              </span>
              <span className="text-xs opacity-80">
                {errorMsg ?? 'An error occurred during this phase. Retry to try again.'}
              </span>
            </div>
            <button
              onClick={onRetryPhase}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-danger hover:bg-danger/80 rounded-lg transition-colors flex-shrink-0"
            >
              <RotateCcw size={12} />
              Retry
            </button>
          </div>
        ) : null
      })()}

      {/* ── Stopped banner with Resume ── */}
      {bp.status === 'cancelled' && (() => {
        const interruptedPhase = bp.currentPhase
        const phaseLabel = interruptedPhase
          ? interruptedPhase.charAt(0).toUpperCase() + interruptedPhase.slice(1)
          : 'next'
        return (
          <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-info/20 bg-info-muted text-info">
            <StopCircle size={16} className="mt-0.5 flex-shrink-0" />
            <div className="flex flex-col gap-0.5 flex-1">
              <span className="text-sm font-medium">Stopped</span>
              <span className="text-xs opacity-80">
                Resume to continue from the {phaseLabel} phase.
              </span>
            </div>
            <button
              onClick={onRetryPhase}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-info hover:bg-info/80 rounded-lg transition-colors flex-shrink-0"
            >
              <PlayCircle size={12} />
              Resume
            </button>
          </div>
        )
      })()}

      {/* ── Interrupted banner (orphaned mid-pipeline, not running) ── */}
      {MID_PIPELINE_STATUSES.has(bp.status) && !isRunning && (() => {
        const interruptedPhase = bp.currentPhase
        const phaseLabel = interruptedPhase
          ? interruptedPhase.charAt(0).toUpperCase() + interruptedPhase.slice(1)
          : 'current'
        return (
          <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-info/20 bg-info-muted text-info">
            <RotateCcw size={16} className="mt-0.5 flex-shrink-0" />
            <div className="flex flex-col gap-0.5 flex-1">
              <span className="text-sm font-medium">Interrupted</span>
              <span className="text-xs opacity-80">
                This blueprint was interrupted during the {phaseLabel} phase. Resume to continue.
              </span>
            </div>
            <button
              onClick={onRetryPhase}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-info hover:bg-info/80 rounded-lg transition-colors flex-shrink-0"
            >
              <PlayCircle size={12} />
              Resume
            </button>
          </div>
        )
      })()}

      {/* ── Phase Journey (replaces flat Phases + Tasks lists) ── */}
      <PhaseJourney
        phases={bp.phases}
        tasks={bp.tasks}
        autoExpandActive={true}
      />
    </div>
  )
}
