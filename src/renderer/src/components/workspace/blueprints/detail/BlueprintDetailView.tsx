/**
 * BlueprintDetailView — thin layout for viewing a past or in-progress
 * blueprint run.
 *
 * Layout (impeccable focused review 2026-09-09: one verdict leads, evidence
 * is one click deep, metadata is one click deeper):
 *   ┌─ Header card (title, status, depth, branch, duration, description) ┐
 *   ├─ DraftPanel (drafts) / Attachments                                 ┤
 *   ├─ OutcomeSummary (stat chips, complete runs)                        ┤
 *   ├─ OutcomePanel (ONE verdict banner + primary action + evidence)     ┤
 *   ├─ HandoffCard (Continue in Chat)                                    ┤
 *   ├─ PhaseEvidence (pill tabs → shared deliverable router)             ┤
 *   └─ TranscriptSection (collapsed) + shared file viewer drawer         ┘
 */

import { useState, useMemo, useRef, useCallback, type JSX } from 'react'
import { Clock, ChevronDown, MessageSquarePlus, GitBranch } from 'lucide-react'
import type { BlueprintWithDetails } from '../../../../../../shared/blueprint-types'
import { StatusBadge } from '../StatusBadge'
import { formatTimeAgo } from '../utils'
import { BlueprintMarkdown } from '../BlueprintMarkdown'
import { OutcomePanel } from './OutcomePanel'
import { PhaseEvidence } from './PhaseEvidence'
import { OutcomeSummary } from './OutcomeSummary'
import { BlueprintHandoffCard } from './BlueprintHandoffCard'
import { getOutcomeStats, formatDuration } from './phase-summaries'
import { extractReferenceDocs, readBlueprintBranchName } from './reference-docs'
import { BlueprintAttachments } from './BlueprintAttachments'
import { DraftPanel } from './DraftPanel'
import { VerificationDepthBadge, VerificationDepthCaveat } from '../VerificationDepthBadge'
import { TranscriptSection } from './TranscriptSection'
import BlueprintFileViewerDrawer from '../BlueprintFileViewerDrawer'

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

// ── Props ──

interface BlueprintDetailViewProps {
  selectedId: string
  currentBlueprint: BlueprintWithDetails | null
  lastError: { blueprintId: string; message: string } | null
  isRunning: boolean
  workspaceId: string | null
  onBack: () => void
  onRetryPhase: () => void
  onNavigateToChat?: () => void
}

// ── Component ──

export function BlueprintDetailView({
  selectedId,
  currentBlueprint,
  lastError,
  isRunning,
  workspaceId,
  onBack,
  onRetryPhase,
  onNavigateToChat
}: BlueprintDetailViewProps): JSX.Element {
  // All hooks must be called before any early returns (Rules of Hooks)
  const bp = currentBlueprint
  const isComplete = bp?.status === 'complete'
  const isDraft = bp?.status === 'draft'
  const referenceDocs = useMemo(() => (bp ? extractReferenceDocs(bp.settingsJson) : []), [bp])
  const branchName = bp ? readBlueprintBranchName(bp.settingsJson) : null
  const outcomeStats = isComplete && bp ? getOutcomeStats(bp.phases, bp.tasks) : null

  // The handoff card sits below the outcome panel. The header button scrolls
  // to it rather than duplicating the intent picker: one place to choose an
  // intent, two places to find it.
  const handoffCardRef = useRef<HTMLDivElement>(null)
  const scrollToHandoff = useCallback(() => {
    handoffCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [])

  if (!bp || bp.id !== selectedId) {
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

  // Compute total duration for header
  const startTimes = bp.phases.map((p) => p.startedAt).filter(Boolean) as string[]
  const endTimes = bp.phases.map((p) => p.completedAt).filter(Boolean) as string[]
  let totalDuration: string | null = null
  if (startTimes.length > 0 && endTimes.length > 0) {
    const earliest = new Date(
      Math.min(...startTimes.map((s) => new Date(s).getTime()))
    ).toISOString()
    const latest = new Date(Math.max(...endTimes.map((s) => new Date(s).getTime()))).toISOString()
    totalDuration = formatDuration(earliest, latest)
  }

  return (
    <div className="flex min-h-0">
      {/* Main column — the detail scroll area */}
      <div className="flex-1 min-w-0 space-y-4">
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
            <h2 className="text-base font-semibold text-text-primary">{bp.title}</h2>
            <StatusBadge status={bp.status} />
            {/* U2 — the depth this run was verified at. Without it, "complete"
                cannot be read correctly: the same badge means three different
                strengths of proof. */}
            <VerificationDepthBadge settingsJson={bp.settingsJson} />
            {/* The run's own branch. Absent until the run starts, and deliberately
              distinct from the status bar, which shows the workspace checkout. */}
            {branchName && (
              <span
                data-testid="blueprint-branch-chip"
                title={`This blueprint works on ${branchName}`}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono rounded bg-surface-inset text-text-secondary max-w-[240px]"
              >
                <GitBranch size={10} className="flex-shrink-0" />
                <span className="truncate">{branchName}</span>
              </span>
            )}
            {totalDuration && (
              <span className="text-[10px] text-text-muted flex items-center gap-1">
                <Clock size={10} />
                {totalDuration}
              </span>
            )}
            {isComplete && (
              <button
                type="button"
                data-testid="blueprint-handoff-jump"
                onClick={scrollToHandoff}
                className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium text-accent hover:bg-accent/10 rounded-lg transition-colors"
              >
                <MessageSquarePlus size={11} />
                Continue in chat
              </button>
            )}
          </div>
          {bp.description && <DescriptionBlock description={bp.description} />}
          <VerificationDepthCaveat settingsJson={bp.settingsJson} className="block" />
          <div className="flex items-center gap-2 text-[10px] text-text-muted">
            <Clock size={10} />
            <span title={bp.createdAt}>Created {formatTimeAgo(new Date(bp.createdAt))}</span>
            {bp.completedAt &&
              (bp.status === 'complete' || bp.status === 'failed' || bp.status === 'cancelled') && (
                <>
                  <span>·</span>
                  <span title={bp.completedAt}>
                    {bp.status === 'complete'
                      ? 'Completed'
                      : bp.status === 'failed'
                        ? 'Failed'
                        : 'Stopped'}{' '}
                    {formatTimeAgo(new Date(bp.completedAt))}
                  </span>
                </>
              )}
          </div>
        </div>

        {/* ── Draft: edit + start, the only actions a never-run blueprint has ── */}
        {isDraft && <DraftPanel blueprint={bp} workspaceId={workspaceId} />}

        {/* ── Attachments (drafts render their own copy inside DraftPanel) ── */}
        {!isDraft && <BlueprintAttachments documents={referenceDocs} />}

        {/* ── Outcome Summary (stat chips, complete runs only) ── */}
        {outcomeStats && <OutcomeSummary stats={outcomeStats} />}

        {/* ── Outcome: ONE verdict banner + primary action + evidence ── */}
        <OutcomePanel bp={bp} isRunning={isRunning} lastError={lastError} onRetryPhase={onRetryPhase} />

        {/* ── Continue in Chat (only once the run has produced something to hand over) ── */}
        {!isRunning && bp.phases.some((p) => p.status === 'complete') && (
          <div ref={handoffCardRef}>
            <BlueprintHandoffCard
              blueprintId={bp.id}
              blueprintTitle={bp.title}
              workspaceId={workspaceId}
              onNavigateToChat={onNavigateToChat}
              prominent={isComplete}
            />
          </div>
        )}

        {/* ── Phase evidence — pill tabs through the shared deliverable router ── */}
        <PhaseEvidence phases={bp.phases} tasks={bp.tasks} blueprintId={bp.id} />

        {/* ── Transcript (read-only hydrated chat history) ── */}
        <TranscriptSection blueprintId={bp.id} />
      </div>

      {/* ── Shared file viewer drawer — any deliverable can open files here ── */}
      <BlueprintFileViewerDrawer />
    </div>
  )
}
