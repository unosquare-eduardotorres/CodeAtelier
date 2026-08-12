/**
 * PhaseJourneyItem — expanded content renderers for each blueprint phase.
 *
 * Delegates to the full-featured Deliverable components (same ones used
 * during active runs), giving past blueprints the same rich structured UI
 * (quality gates grid, artifact verification bars, progress bars, tables).
 */

import { useState, type JSX } from 'react'
import { ChevronDown } from 'lucide-react'
import type { BlueprintPhase, BlueprintTask } from '../../../../../../shared/blueprint-types'
import { BlueprintMarkdown } from '../BlueprintMarkdown'
import { SpecifyDeliverable } from '../deliverables/SpecifyDeliverable'
import { ClarifyDeliverable } from '../deliverables/ClarifyDeliverable'
import { PlanDeliverable } from '../deliverables/PlanDeliverable'
import { TasksDeliverable } from '../deliverables/TasksDeliverable'
import { ReviewDeliverable } from '../deliverables/ReviewDeliverable'
import { BuildDeliverable } from '../deliverables/BuildDeliverable'
import { VerifyDeliverable } from '../deliverables/VerifyDeliverable'

// ── Helpers ──

/** Capped markdown viewer with expand toggle */
function CappedMarkdown({
  content,
  maxH = 'max-h-96'
}: {
  content: string
  maxH?: string
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return (
    <div>
      <div className={expanded ? '' : `${maxH} overflow-hidden relative`}>
        <BlueprintMarkdown>{content}</BlueprintMarkdown>
        {!expanded && (
          <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-surface-base to-transparent pointer-events-none" />
        )}
      </div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-xs text-accent hover:text-accent/80 font-medium mt-1.5 transition-colors"
      >
        <ChevronDown size={12} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
        {expanded ? 'Show less' : 'Show more'}
      </button>
    </div>
  )
}

// ── Main Dispatcher ──

interface PhaseJourneyItemContentProps {
  phase: BlueprintPhase
  tasks: BlueprintTask[]
}

export function PhaseJourneyItemContent({
  phase,
  tasks
}: PhaseJourneyItemContentProps): JSX.Element {
  // Compute duration from phase timestamps (deliverables expect ms or null)
  const duration =
    phase.startedAt && phase.completedAt
      ? Math.max(0, new Date(phase.completedAt).getTime() - new Date(phase.startedAt).getTime())
      : null

  switch (phase.phase) {
    case 'specify':
      return <SpecifyDeliverable phase={phase} duration={duration} />
    case 'clarify':
      return <ClarifyDeliverable phase={phase} duration={duration} />
    case 'plan':
      return <PlanDeliverable phase={phase} duration={duration} />
    case 'tasks':
      return <TasksDeliverable phase={phase} duration={duration} tasks={tasks} />
    case 'review':
      return <ReviewDeliverable phase={phase} duration={duration} />
    case 'build':
      return <BuildDeliverable phase={phase} duration={duration} tasks={tasks} />
    case 'verify':
      return <VerifyDeliverable phase={phase} duration={duration} />
    default: {
      // Fallback: show any markdown artifact
      const mdArt = phase.artifactsJson?.find((a) => a.contentMd)
      if (mdArt?.contentMd) return <CappedMarkdown content={mdArt.contentMd} />
      return <p className="text-xs text-text-muted italic">No content available.</p>
    }
  }
}
