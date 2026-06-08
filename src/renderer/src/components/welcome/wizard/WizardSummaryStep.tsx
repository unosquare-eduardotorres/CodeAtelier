/**
 * WizardSummaryStep — Step 4 (Create) of the Create New Project wizard.
 *
 * Read-only confirmation screen showing project info, grill decisions
 * summary per track, and what will be created. Triggers project creation.
 */

import { useState, useMemo } from 'react'
import {
  ArrowLeft,
  FolderPlus,
  FileText,
  Database,
  Loader2,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Landmark
} from 'lucide-react'
import type { GrillDecision, GrillTrackScore } from '../../../../../shared/types'
import type { ProjectDestination } from '../CreateProjectWizard'
import { GRILL_TRACKS } from '../../../../../shared/constants'

interface WizardSummaryStepProps {
  projectName: string
  parentFolder: string
  description: string
  attachments: string[]
  grillDecisions: GrillDecision[]
  trackScores: GrillTrackScore[]
  onBack: () => void
  /** Finalize the blueprint then route into the new workspace at the chosen destination. */
  onFinalize: (destination: ProjectDestination) => Promise<void>
}

export default function WizardSummaryStep({
  projectName,
  parentFolder,
  description,
  attachments,
  grillDecisions,
  trackScores,
  onBack,
  onFinalize
}: WizardSummaryStepProps): React.JSX.Element {
  const [finalizing, setFinalizing] = useState<ProjectDestination | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedTracks, setExpandedTracks] = useState<Set<string>>(new Set())

  const resolvedPath = `${parentFolder}/${projectName.trim()}`

  const overallScore = useMemo(() => {
    if (trackScores.length === 0) return null
    const sum = trackScores.reduce((a, b) => a + b.score, 0)
    return Math.round(sum / trackScores.length)
  }, [trackScores])

  const isCreating = finalizing !== null

  // Group decisions by track
  const decisionsByTrack = useMemo(() => {
    const map = new Map<string, GrillDecision[]>()
    for (const d of grillDecisions) {
      const list = map.get(d.trackId) ?? []
      list.push(d)
      map.set(d.trackId, list)
    }
    return map
  }, [grillDecisions])

  const toggleTrackExpand = (trackId: string): void => {
    setExpandedTracks((prev) => {
      const next = new Set(prev)
      if (next.has(trackId)) {
        next.delete(trackId)
      } else {
        next.add(trackId)
      }
      return next
    })
  }

  const handleFinalize = async (destination: ProjectDestination): Promise<void> => {
    if (finalizing) return
    setError(null)
    setFinalizing(destination)
    try {
      await onFinalize(destination)
      // On success the wizard unmounts as the app routes into the new workspace.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setFinalizing(null)
    }
  }

  const FINALIZE_LABELS: Record<ProjectDestination, string> = {
    chat: 'Opening project…',
    goals: 'Starting goal…',
    council: 'Convening council…'
  }

  return (
    <div className="flex flex-col gap-6 max-w-2xl mx-auto w-full">
      {/* Header */}
      <div className="text-center mb-2">
        <h2 className="text-xl font-semibold text-text-primary">Review & Create</h2>
        <p className="text-sm text-text-secondary mt-1">
          Confirm your project details before creation
        </p>
      </div>

      {/* Project Info Card */}
      <div className="rounded-xl border border-border-subtle bg-surface-overlay p-4">
        <h3 className="text-sm font-semibold text-text-primary mb-3">Project Info</h3>
        <div className="space-y-2">
          <div className="flex items-start gap-2">
            <span className="text-xs font-medium text-text-muted w-20 flex-shrink-0 pt-0.5">
              Name
            </span>
            <span className="text-sm text-text-primary">{projectName}</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-xs font-medium text-text-muted w-20 flex-shrink-0 pt-0.5">
              Location
            </span>
            <code className="text-xs text-text-secondary font-mono bg-surface-base px-1.5 py-0.5 rounded break-all">
              {resolvedPath}
            </code>
          </div>
          {description && (
            <div className="flex items-start gap-2">
              <span className="text-xs font-medium text-text-muted w-20 flex-shrink-0 pt-0.5">
                Description
              </span>
              <p className="text-sm text-text-secondary leading-relaxed line-clamp-4">
                {description}
              </p>
            </div>
          )}
          {attachments.length > 0 && (
            <div className="flex items-start gap-2">
              <span className="text-xs font-medium text-text-muted w-20 flex-shrink-0 pt-0.5">
                Attachments
              </span>
              <span className="text-sm text-text-secondary">
                {attachments.length} file{attachments.length !== 1 ? 's' : ''}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Decisions Summary Card */}
      {trackScores.length > 0 && (
        <div className="rounded-xl border border-border-subtle bg-surface-overlay p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-text-primary">Decisions Summary</h3>
            {overallScore !== null && (
              <span
                className={`text-sm font-semibold px-2 py-0.5 rounded-full ${
                  overallScore >= 61
                    ? 'bg-success-muted text-success'
                    : overallScore >= 41
                      ? 'bg-warning-muted text-warning'
                      : 'bg-danger-muted text-danger'
                }`}
              >
                {overallScore}/100
              </span>
            )}
          </div>

          {/* Per-track expandable sections */}
          <div className="space-y-1.5">
            {trackScores.map((ts) => {
              const trackDecisions = decisionsByTrack.get(ts.trackId) ?? []
              const isExpanded = expandedTracks.has(ts.trackId)
              const trackName = GRILL_TRACKS[ts.trackId]?.name ?? ts.trackId

              return (
                <div key={ts.trackId}>
                  <button
                    type="button"
                    onClick={() => toggleTrackExpand(ts.trackId)}
                    className="w-full flex items-center gap-2 rounded-lg px-2.5 py-2 hover:bg-surface-base transition-colors"
                  >
                    {isExpanded ? (
                      <ChevronDown size={12} className="text-text-muted flex-shrink-0" />
                    ) : (
                      <ChevronRight size={12} className="text-text-muted flex-shrink-0" />
                    )}
                    <span className="text-xs font-medium text-text-primary flex-1 text-left">
                      {trackName}
                    </span>
                    <span className="text-xs text-text-muted">
                      {trackDecisions.length} decision{trackDecisions.length !== 1 ? 's' : ''}
                    </span>
                    <div className="w-16 h-1.5 rounded-full bg-surface-base overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          ts.score >= 61
                            ? 'bg-success'
                            : ts.score >= 41
                              ? 'bg-warning'
                              : 'bg-danger'
                        }`}
                        style={{ width: `${ts.score}%` }}
                      />
                    </div>
                    <span className="text-xs font-semibold text-text-secondary w-8 text-right">
                      {ts.score}
                    </span>
                  </button>

                  {isExpanded && trackDecisions.length > 0 && (
                    <div className="ml-6 pl-2 border-l border-border-subtle space-y-1 py-1.5">
                      {trackDecisions.map((d) => (
                        <div key={d.questionId} className="flex items-start gap-1.5">
                          <span className="text-text-muted mt-0.5 flex-shrink-0">•</span>
                          <span className="text-xs text-text-secondary">
                            <span className="font-medium text-text-primary">{d.questionText}</span>:{' '}
                            {d.selectedOption}
                            {d.otherText && (
                              <span className="text-text-muted"> ({d.otherText})</span>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* What will be created */}
      <div className="rounded-xl border border-border-subtle bg-surface-overlay p-4">
        <h3 className="text-sm font-semibold text-text-primary mb-3">What will be created</h3>
        <div className="space-y-2">
          <div className="flex items-center gap-2.5 text-sm text-text-secondary">
            <FolderPlus size={16} className="text-primary-text flex-shrink-0" />
            <code className="text-xs font-mono">{resolvedPath}/</code>
          </div>
          <div className="flex items-center gap-2.5 text-sm text-text-secondary">
            <FileText size={16} className="text-primary-text flex-shrink-0" />
            <span>CLAUDE.md — project blueprint with your decisions</span>
          </div>
          <div className="flex items-center gap-2.5 text-sm text-text-secondary">
            <Database size={16} className="text-primary-text flex-shrink-0" />
            <span>Workspace registered in Code Atelier</span>
          </div>
        </div>
      </div>

      {/* Error display */}
      {error && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-danger-muted border border-danger/30">
          <AlertCircle size={16} className="text-danger flex-shrink-0 mt-0.5" />
          <p className="text-sm text-danger">{error}</p>
        </div>
      )}

      {/* Creation progress */}
      {isCreating && finalizing && (
        <div className="flex items-center justify-center gap-2 py-2">
          <Loader2 size={16} className="animate-spin text-primary-text" />
          <span className="text-sm text-text-secondary">{FINALIZE_LABELS[finalizing]}</span>
        </div>
      )}

      {/* Buttons — create the project then route to the chosen destination */}
      <div className="flex items-center justify-between pt-4 border-t border-border-subtle">
        <button
          type="button"
          onClick={onBack}
          disabled={isCreating}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
                     text-text-secondary hover:text-text-primary hover:bg-surface-overlay
                     transition-colors disabled:opacity-40 disabled:cursor-not-allowed
                     focus:outline-none focus:ring-2 focus:ring-primary/50"
        >
          <ArrowLeft size={14} />
          Back
        </button>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => handleFinalize('council')}
            disabled={isCreating}
            aria-label="Create project and convene the council"
            className="flex items-center gap-1.5 px-3 py-2.5 rounded-lg text-sm font-medium
                       border border-purple-500 text-purple-400 hover:bg-purple-500/10
                       transition-colors disabled:opacity-40 disabled:cursor-not-allowed press-scale"
          >
            <Landmark size={14} />
            Council Sweep
          </button>
          <button
            type="button"
            onClick={() => handleFinalize('chat')}
            disabled={isCreating}
            aria-label="Create project and continue in chat"
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium
                       bg-primary hover:bg-primary-hover text-white
                       transition-colors disabled:opacity-40 disabled:cursor-not-allowed
                       focus:outline-none focus:ring-2 focus:ring-primary/50 press-scale"
          >
            <MessageSquare size={14} />
            Continue in Chat
          </button>
        </div>
      </div>
    </div>
  )
}
