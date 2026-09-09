/**
 * PhaseDeliverableRouter — the ONE phase → deliverable-component dispatcher.
 *
 * Replaces the two hand-copied routers that had already diverged (the active
 * view's router handled `code-review`; the detail view's accordion router did
 * not, so that phase degraded to raw markdown — impeccable focused review,
 * 2026-09-09). Both shells now delegate here.
 *
 * `readOnly` strips task-mutation affordances (skip/accept/run-gates) so the
 * read-only detail view cannot mutate a finished run while the live
 * execution view stays interactive.
 */

import type { JSX } from 'react'
import type { BlueprintPhase, BlueprintTask } from '../../../../../../shared/blueprint-types'
import { BlueprintMarkdown } from '../BlueprintMarkdown'
import { SpecifyDeliverable } from './SpecifyDeliverable'
import { ClarifyDeliverable } from './ClarifyDeliverable'
import { PlanDeliverable } from './PlanDeliverable'
import { TasksDeliverable } from './TasksDeliverable'
import { ReviewDeliverable } from './ReviewDeliverable'
import { BuildDeliverable } from './BuildDeliverable'
import { CodeReviewDeliverable } from './CodeReviewDeliverable'
import { VerifyDeliverable } from './VerifyDeliverable'

export function PhaseDeliverableRouter({
  phase,
  tasks,
  blueprintId,
  duration,
  readOnly = false
}: {
  phase: BlueprintPhase
  tasks: BlueprintTask[]
  blueprintId?: string
  duration: number | null
  readOnly?: boolean
}): JSX.Element {
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
      return (
        <BuildDeliverable
          phase={phase}
          duration={duration}
          tasks={tasks}
          blueprintId={blueprintId}
          readOnly={readOnly}
        />
      )
    case 'code-review':
      return <CodeReviewDeliverable phase={phase} duration={duration} tasks={tasks} />
    case 'verify':
      return <VerifyDeliverable phase={phase} duration={duration} blueprintId={blueprintId} />
    default: {
      // Fallback: render any markdown artifact the phase carries.
      const mdArt = phase.artifactsJson?.find((a) => a.contentMd)
      if (mdArt?.contentMd) {
        return (
          <div>
            <BlueprintMarkdown>{mdArt.contentMd}</BlueprintMarkdown>
          </div>
        )
      }
      return <p className="text-xs text-text-muted italic">No content available.</p>
    }
  }
}
