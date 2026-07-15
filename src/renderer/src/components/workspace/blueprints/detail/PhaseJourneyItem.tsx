/**
 * PhaseJourneyItem — expanded content renderers for each blueprint phase.
 *
 * Each phase type gets a dedicated renderer that extracts and presents
 * the relevant data from phase.artifactsJson:
 *   specify  → spec markdown
 *   clarify  → Q&A list
 *   plan     → BlueprintPlanCard
 *   tasks    → wave stat grid + BlueprintTasksCard
 *   review   → recommendation + review markdown
 *   build    → metric tiles + file chips
 *   verify   → status banner + remediation tasks + verify markdown
 */

import { useState, type JSX } from 'react'
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ChevronDown,
  FileText,
  MessageCircleQuestion,
  User
} from 'lucide-react'
import type {
  BlueprintPhase,
  BlueprintTask,
  BlueprintArtifact
} from '../../../../../../shared/blueprint-types'
import { BlueprintMarkdown } from '../BlueprintMarkdown'
import { BlueprintPlanCard, BlueprintTasksCard, FileChips } from '../BlueprintPlanCard'
import { getBuildSummary, getVerifySummary } from './phase-summaries'

// ── Helpers ──

function findArtifact(phase: BlueprintPhase, ...types: string[]): BlueprintArtifact | undefined {
  return phase.artifactsJson?.findLast((a) => types.includes(a.type))
}

function findAllArtifacts(phase: BlueprintPhase, ...types: string[]): BlueprintArtifact[] {
  return phase.artifactsJson?.filter((a) => types.includes(a.type)) ?? []
}

/** Capped markdown viewer with expand toggle */
function CappedMarkdown({ content, maxH = 'max-h-96' }: { content: string; maxH?: string }): JSX.Element {
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

// ── Specify Phase ──

function SpecifyContent({ phase }: { phase: BlueprintPhase }): JSX.Element {
  const spec = findArtifact(phase, 'spec', 'specification')
  if (spec?.contentMd) {
    return <CappedMarkdown content={spec.contentMd} />
  }
  return <p className="text-xs text-text-muted italic">No specification artifact found.</p>
}

// ── Clarify Phase ──

function ClarifyContent({ phase }: { phase: BlueprintPhase }): JSX.Element {
  const qas = findAllArtifacts(phase, 'clarify-qa', 'clarify-questions')

  if (qas.length > 0) {
    return (
      <div className="space-y-3">
        {qas.map((qa, idx) => {
          const json = qa.contentJson as Record<string, unknown> | undefined
          const questions = (json?.questions as Array<Record<string, unknown>>) ?? []
          if (questions.length === 0 && qa.contentMd) {
            return <CappedMarkdown key={idx} content={qa.contentMd} />
          }
          return (
            <div key={idx} className="space-y-2">
              {idx > 0 && <div className="border-t border-border-subtle" />}
              <span className="text-[10px] font-medium text-text-muted uppercase tracking-wide">
                Round {idx + 1}
              </span>
              {questions.map((q, qi) => (
                <div key={qi} className="rounded-lg bg-surface-inset/50 p-3 space-y-1.5">
                  <div className="flex items-start gap-2">
                    <MessageCircleQuestion size={14} className="text-warning mt-0.5 flex-shrink-0" />
                    <span className="text-xs font-medium text-text-primary">
                      {String(q.question ?? q.text ?? '')}
                    </span>
                  </div>
                  {q.answer ? (
                    <div className="flex items-start gap-2 pl-5">
                      <User size={12} className="text-accent mt-0.5 flex-shrink-0" />
                      <span className="text-xs text-text-secondary">
                        {String(q.answer)}
                      </span>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )
        })}
      </div>
    )
  }

  // Fallback to any markdown content in the phase
  const mdArtifact = phase.artifactsJson?.find((a) => a.contentMd)
  if (mdArtifact?.contentMd) {
    return <CappedMarkdown content={mdArtifact.contentMd} />
  }

  if (phase.status === 'skipped') {
    return <p className="text-xs text-text-muted italic">Clarification was skipped.</p>
  }
  return <p className="text-xs text-text-muted italic">No clarification data found.</p>
}

// ── Plan Phase ──

function PlanContent({ phase }: { phase: BlueprintPhase }): JSX.Element {
  const plan = findArtifact(phase, 'plan', 'blueprint-plan')
  if (plan?.contentJson) {
    return <BlueprintPlanCard plan={plan.contentJson as Record<string, unknown>} />
  }
  if (plan?.contentMd) {
    return <CappedMarkdown content={plan.contentMd} />
  }
  return <p className="text-xs text-text-muted italic">No plan artifact found.</p>
}

// ── Tasks Phase ──

function TasksContent({ phase }: { phase: BlueprintPhase }): JSX.Element {
  const tasksArt = findArtifact(phase, 'tasks', 'blueprint-tasks')
  if (tasksArt?.contentJson) {
    return <BlueprintTasksCard tasks={tasksArt.contentJson as Record<string, unknown>} />
  }
  if (tasksArt?.contentMd) {
    return <CappedMarkdown content={tasksArt.contentMd} />
  }
  return <p className="text-xs text-text-muted italic">No tasks artifact found.</p>
}

// ── Review Phase ──

function ReviewContent({ phase }: { phase: BlueprintPhase }): JSX.Element {
  const review = findArtifact(phase, 'review', 'blueprint-review')
  const recommendation = (review?.contentJson as Record<string, unknown>)?.recommendation as string | undefined

  return (
    <div className="space-y-3">
      {recommendation && (
        <div className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold ${
          recommendation === 'approve'
            ? 'bg-success/10 text-success border border-success/20'
            : 'bg-warning/10 text-warning border border-warning/20'
        }`}>
          {recommendation === 'approve' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
          {recommendation === 'approve' ? 'Approved' : recommendation.charAt(0).toUpperCase() + recommendation.slice(1)}
        </div>
      )}
      {review?.contentMd && <CappedMarkdown content={review.contentMd} />}
      {!review && (
        <p className="text-xs text-text-muted italic">No review artifact found.</p>
      )}
    </div>
  )
}

// ── Build Phase ──

function BuildContent({ phase, tasks }: { phase: BlueprintPhase; tasks: BlueprintTask[] }): JSX.Element {
  const result = getBuildSummary(phase, tasks)
  const stats = result.stats

  return (
    <div className="space-y-3">
      {/* Metric tiles */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <MetricTile label="Tasks" value={`${stats.tasksCompleted}/${stats.totalTasks}`} />
          <MetricTile label="Created" value={String(stats.filesCreated.length)} />
          <MetricTile label="Modified" value={String(stats.filesModified.length)} />
          {result.duration && <MetricTile label="Duration" value={result.duration} />}
        </div>
      )}

      {/* Files created */}
      {stats && stats.filesCreated.length > 0 && (
        <div className="space-y-1.5">
          <span className="text-[10px] font-medium text-text-muted uppercase tracking-wide">
            Files Created
          </span>
          <FileChips files={stats.filesCreated} />
        </div>
      )}

      {/* Files modified */}
      {stats && stats.filesModified.length > 0 && (
        <div className="space-y-1.5">
          <span className="text-[10px] font-medium text-text-muted uppercase tracking-wide">
            Files Modified
          </span>
          <FileChips files={stats.filesModified} />
        </div>
      )}

      {/* Fallback: if no build stats, show task status summary */}
      {!stats && tasks.length > 0 && (
        <div className="text-xs text-text-secondary">
          {tasks.filter((t) => t.status === 'complete').length}/{tasks.length} tasks completed
        </div>
      )}
    </div>
  )
}

function MetricTile({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-inset/50 px-3 py-2 text-center">
      <div className="text-sm font-semibold text-text-primary">{value}</div>
      <div className="text-[10px] text-text-muted uppercase tracking-wide mt-0.5">{label}</div>
    </div>
  )
}

// ── Verify Phase ──

function VerifyContent({ phase }: { phase: BlueprintPhase }): JSX.Element {
  const result = getVerifySummary(phase)
  const stats = result.stats
  const verify = findArtifact(phase, 'verify', 'verification')

  return (
    <div className="space-y-3">
      {/* Status banner */}
      {stats && (
        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium ${
          stats.overallStatus === 'passed'
            ? 'bg-success/10 text-success border border-success/20'
            : stats.overallStatus === 'human_needed'
            ? 'bg-accent/10 text-accent border border-accent/20'
            : 'bg-danger/10 text-danger border border-danger/20'
        }`}>
          {stats.overallStatus === 'passed' ? (
            <CheckCircle2 size={16} />
          ) : stats.overallStatus === 'human_needed' ? (
            <AlertTriangle size={16} />
          ) : (
            <XCircle size={16} />
          )}
          {stats.overallStatus === 'passed' ? 'Verification Passed' :
           stats.overallStatus === 'human_needed' ? 'Human Review Needed' :
           stats.overallStatus === 'gaps_found' ? 'Gaps Found' :
           stats.overallStatus}
        </div>
      )}

      {/* Remediation tasks */}
      {stats && stats.remediationTasks.length > 0 && (
        <div className="space-y-1.5">
          <span className="text-[10px] font-medium text-text-muted uppercase tracking-wide">
            Remediation Tasks ({stats.remediationTasks.length})
          </span>
          <div className="space-y-1">
            {stats.remediationTasks.map((task) => (
              <div
                key={task.taskId}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-inset/50 border border-border-subtle"
              >
                {task.status === 'complete' ? (
                  <CheckCircle2 size={12} className="text-success flex-shrink-0" />
                ) : task.status === 'failed' ? (
                  <XCircle size={12} className="text-danger flex-shrink-0" />
                ) : (
                  <FileText size={12} className="text-text-muted flex-shrink-0" />
                )}
                <span className="text-xs font-mono text-text-muted flex-shrink-0">{task.taskId}</span>
                <span className="text-xs text-text-secondary truncate">{task.description}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Verify markdown content */}
      {verify?.contentMd && <CappedMarkdown content={verify.contentMd} />}

      {!stats && !verify && (
        <p className="text-xs text-text-muted italic">No verification data found.</p>
      )}
    </div>
  )
}

// ── Main Dispatcher ──

interface PhaseJourneyItemContentProps {
  phase: BlueprintPhase
  tasks: BlueprintTask[]
}

export function PhaseJourneyItemContent({ phase, tasks }: PhaseJourneyItemContentProps): JSX.Element {
  switch (phase.phase) {
    case 'specify': return <SpecifyContent phase={phase} />
    case 'clarify': return <ClarifyContent phase={phase} />
    case 'plan': return <PlanContent phase={phase} />
    case 'tasks': return <TasksContent phase={phase} />
    case 'review': return <ReviewContent phase={phase} />
    case 'build': return <BuildContent phase={phase} tasks={tasks} />
    case 'verify': return <VerifyContent phase={phase} />
    default:
      // Fallback: show any markdown artifact
      const mdArt = phase.artifactsJson?.find((a) => a.contentMd)
      if (mdArt?.contentMd) return <CappedMarkdown content={mdArt.contentMd} />
      return <p className="text-xs text-text-muted italic">No content available.</p>
  }
}
