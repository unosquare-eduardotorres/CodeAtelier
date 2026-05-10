/**
 * WizardSummaryStep — Step 3 of the Create New Project wizard.
 *
 * Read-only confirmation screen showing project info, grill results
 * (if a grill session was run), and what will be created. Triggers
 * the actual project creation via IPC.
 */

import { useState, useMemo } from 'react'
import {
  ArrowLeft,
  FolderPlus,
  FileText,
  Database,
  Loader2,
  CheckCircle2,
  AlertCircle
} from 'lucide-react'
import type { GrillDecision, GrillTrackScore } from '../../../../../shared/types'

interface WizardSummaryStepProps {
  projectName: string
  parentFolder: string
  description: string
  grillDecisions: GrillDecision[]
  trackScores: GrillTrackScore[]
  skippedGrill: boolean
  onBack: () => void
  onCreateProject: () => Promise<void>
}

type CreationPhase =
  | 'idle'
  | 'creating-folder'
  | 'generating-claudemd'
  | 'registering'
  | 'done'
  | 'error'

const PHASE_LABELS: Record<CreationPhase, string> = {
  idle: '',
  'creating-folder': 'Creating folder…',
  'generating-claudemd': 'Generating CLAUDE.md…',
  registering: 'Registering workspace…',
  done: 'Project created!',
  error: 'Creation failed'
}

export default function WizardSummaryStep({
  projectName,
  parentFolder,
  description,
  grillDecisions,
  trackScores,
  skippedGrill,
  onBack,
  onCreateProject
}: WizardSummaryStepProps): React.JSX.Element {
  const [creationPhase, setCreationPhase] = useState<CreationPhase>('idle')
  const [error, setError] = useState<string | null>(null)

  const resolvedPath = `${parentFolder}/${projectName.trim()}`

  const overallScore = useMemo(() => {
    if (trackScores.length === 0) return null
    const sum = trackScores.reduce((a, b) => a + b.score, 0)
    return Math.round(sum / trackScores.length)
  }, [trackScores])

  const isCreating =
    creationPhase !== 'idle' && creationPhase !== 'done' && creationPhase !== 'error'

  const handleCreate = async (): Promise<void> => {
    setError(null)
    try {
      setCreationPhase('creating-folder')
      // Small delay to show progress
      await new Promise((r) => setTimeout(r, 300))

      setCreationPhase('generating-claudemd')
      await new Promise((r) => setTimeout(r, 200))

      setCreationPhase('registering')
      await onCreateProject()

      setCreationPhase('done')
    } catch (err) {
      setCreationPhase('error')
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  // Group decisions by track for display
  const decisionsByTrack = useMemo(() => {
    const map = new Map<string, GrillDecision[]>()
    for (const d of grillDecisions) {
      const list = map.get(d.trackId) ?? []
      list.push(d)
      map.set(d.trackId, list)
    }
    return map
  }, [grillDecisions])

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
        </div>
      </div>

      {/* Grill Results Card */}
      {!skippedGrill && trackScores.length > 0 && (
        <div className="rounded-xl border border-border-subtle bg-surface-overlay p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-text-primary">Grill Results</h3>
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

          {/* Per-track scores */}
          <div className="space-y-1.5 mb-4">
            {trackScores.map((ts) => (
              <div key={ts.trackId} className="flex items-center gap-2">
                <span className="text-xs text-text-muted w-28 flex-shrink-0 capitalize">
                  {ts.trackId.replace('-', ' ')}
                </span>
                <div className="flex-1 h-1.5 rounded-full bg-surface-base overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      ts.score >= 61 ? 'bg-success' : ts.score >= 41 ? 'bg-warning' : 'bg-danger'
                    }`}
                    style={{ width: `${ts.score}%` }}
                  />
                </div>
                <span className="text-xs text-text-secondary w-10 text-right">{ts.score}</span>
              </div>
            ))}
          </div>

          {/* Key decisions */}
          {grillDecisions.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-text-muted mb-2 uppercase tracking-wider">
                Key Decisions ({grillDecisions.length})
              </h4>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {Array.from(decisionsByTrack.entries()).map(([trackId, decisions]) => (
                  <div key={trackId}>
                    <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">
                      {trackId}
                    </span>
                    {decisions.map((d) => (
                      <div key={d.questionId} className="flex items-start gap-1.5 ml-2 mt-0.5">
                        <span className="text-text-muted mt-1">•</span>
                        <span className="text-xs text-text-secondary">
                          <span className="font-medium text-text-primary">{d.questionText}</span>:{' '}
                          {d.selectedOption}
                          {d.otherText && <span className="text-text-muted"> ({d.otherText})</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {skippedGrill && (
        <div className="rounded-xl border border-border-subtle bg-surface-overlay p-4">
          <p className="text-sm text-text-muted text-center">
            Grill session was skipped — a basic CLAUDE.md will be generated from your description.
          </p>
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
      {isCreating && (
        <div className="flex items-center justify-center gap-2 py-2">
          <Loader2 size={16} className="animate-spin text-primary-text" />
          <span className="text-sm text-text-secondary">{PHASE_LABELS[creationPhase]}</span>
        </div>
      )}

      {/* Buttons */}
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

        <button
          type="button"
          onClick={handleCreate}
          disabled={isCreating || creationPhase === 'done'}
          className="flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-medium
                     bg-primary hover:bg-primary-hover text-white
                     transition-colors disabled:opacity-40 disabled:cursor-not-allowed
                     focus:outline-none focus:ring-2 focus:ring-primary/50 press-scale"
        >
          {creationPhase === 'done' ? (
            <>
              <CheckCircle2 size={14} />
              Created!
            </>
          ) : (
            <>
              <FolderPlus size={14} />
              Create Project
            </>
          )}
        </button>
      </div>
    </div>
  )
}
