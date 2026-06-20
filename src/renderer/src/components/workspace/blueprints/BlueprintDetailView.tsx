import type { JSX } from 'react'
import { ArrowLeft, Clock, XCircle, RotateCcw } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { StatusBadge, ReferenceDocList, formatTimeAgo, PHASE_CONFIG } from '.'
import { PhaseListItem } from './PhaseListItem'
import { TaskListItem } from './TaskListItem'
import type { Blueprint, ReferenceDocument } from '../../../../../shared/blueprint-types'

// ── Helpers ──

export function hasReferenceDocuments(blueprint: Blueprint): boolean {
  const settings = blueprint.settingsJson as Record<string, unknown> | null
  return !!(
    settings?.referenceDocuments &&
    Array.isArray(settings.referenceDocuments) &&
    (settings.referenceDocuments as unknown[]).length > 0
  )
}

export function getReferenceDocuments(blueprint: Blueprint): ReferenceDocument[] {
  const settings = blueprint.settingsJson as Record<string, unknown>
  return settings.referenceDocuments as ReferenceDocument[]
}

export function getFailedPhaseError(
  blueprint: Blueprint,
  lastError: { blueprintId: string; message: string } | null
): string | null {
  if (lastError?.blueprintId === blueprint.id) return lastError.message
  return null
}

// ── Detail View ──

interface BlueprintDetailViewProps {
  selectedId: string
  currentBlueprint: Blueprint | null
  lastError: { phase: string; message: string; blueprintId: string } | null
  descriptionExpanded: boolean
  expandedPhases: Set<string>
  copiedArtifact: string | null
  workspaceId: string
  onBack: () => void
  onDescriptionExpandToggle: () => void
  onTogglePhaseExpand: (phaseId: string) => void
  onCopiedArtifact: (v: string | null) => void
  onRetryPhase: (blueprintId: string, workspaceId: string) => Promise<void>
}

export default function BlueprintDetailView({
  selectedId,
  currentBlueprint,
  lastError,
  descriptionExpanded,
  expandedPhases,
  copiedArtifact,
  workspaceId,
  onBack,
  onDescriptionExpandToggle,
  onTogglePhaseExpand,
  onCopiedArtifact,
  onRetryPhase
}: BlueprintDetailViewProps): JSX.Element {
  if (!currentBlueprint || currentBlueprint.id !== selectedId) {
    return (
      <div className="max-w-3xl mx-auto w-full space-y-4">
        <BackButton onClick={onBack} />
        <div className="text-xs text-text-muted animate-pulse text-center py-8">
          Loading blueprint...
        </div>
      </div>
    )
  }

  const failedPhase = currentBlueprint.phases.find((p) => p.status === 'failed')
  const errorMsg = getFailedPhaseError(currentBlueprint, lastError)

  const completedOrFailed = currentBlueprint.phases.filter(
    (p) => p.status === 'complete' || p.status === 'failed' || p.status === 'skipped'
  )
  const pendingPhases = currentBlueprint.phases.filter((p) => p.status === 'pending')
  const activePhases = currentBlueprint.phases.filter((p) => p.status === 'active')

  const completedCount = currentBlueprint.phases.filter(
    (p) => p.status === 'complete' || p.status === 'skipped'
  ).length
  const totalCount = currentBlueprint.phases.length
  const pct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0

  const progressBarColor =
    currentBlueprint.status === 'failed'
      ? 'bg-red-500'
      : currentBlueprint.status === 'complete'
        ? 'bg-success'
        : 'bg-emerald-500'

  return (
    <div data-testid="blueprint-detail-view" className="max-w-3xl mx-auto w-full space-y-4">
      <BackButton onClick={onBack} />

      <div className="space-y-4">
        {/* Blueprint header */}
        <div className="bg-surface-raised rounded-xl border border-border-subtle p-4 space-y-2">
          <div className="flex items-center gap-2 min-w-0">
            <h4 className="text-sm font-semibold text-text-primary truncate flex-1 min-w-0">
              {currentBlueprint.title}
            </h4>
            <StatusBadge status={currentBlueprint.status} />
            <span className="text-[10px] text-text-muted flex-shrink-0">
              {currentBlueprint.priority}
            </span>
          </div>

          {/* Progress bar */}
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1.5 bg-surface-base rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${progressBarColor}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-[10px] text-text-muted flex-shrink-0">
              {completedCount}/{totalCount} phases
            </span>
          </div>

          {/* Description */}
          {currentBlueprint.description && (
            <DescriptionBlock
              description={currentBlueprint.description}
              expanded={descriptionExpanded}
              onToggle={onDescriptionExpandToggle}
            />
          )}

          <div className="flex items-center gap-2 text-[10px] text-text-muted">
            <Clock size={10} />
            <span>Created {formatTimeAgo(new Date(currentBlueprint.createdAt))}</span>
          </div>
        </div>

        {/* Failed phase error banner */}
        {currentBlueprint.status === 'failed' && failedPhase && (
          <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-red-500/20 bg-red-500/5 text-red-300">
            <XCircle size={16} className="mt-0.5 flex-shrink-0" />
            <div className="flex flex-col gap-0.5 flex-1">
              <span className="text-sm font-medium">
                {failedPhase.phase.charAt(0).toUpperCase() + failedPhase.phase.slice(1)} phase
                failed
              </span>
              <span className="text-xs opacity-80">
                {errorMsg ?? 'An error occurred during this phase. Retry to try again.'}
              </span>
            </div>
            <button
              onClick={() => onRetryPhase(currentBlueprint.id, workspaceId)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-500 rounded-lg transition-colors flex-shrink-0"
            >
              <RotateCcw size={12} />
              Retry
            </button>
          </div>
        )}

        {/* Reference Documents */}
        {hasReferenceDocuments(currentBlueprint) && (
          <div className="bg-surface-raised rounded-xl border border-border-subtle p-4 space-y-2">
            <h5 className="text-xs font-medium text-text-secondary">Reference Documents</h5>
            <ReferenceDocList documents={getReferenceDocuments(currentBlueprint)} readonly />
          </div>
        )}

        {/* Phase list */}
        <div className="space-y-2">
          <h5 className="text-xs font-medium text-text-secondary">Phases</h5>
          {activePhases.map((phase) => (
            <PhaseListItem
              key={phase.id}
              phase={phase}
              blueprintStatus={currentBlueprint.status}
              isExpanded={expandedPhases.has(phase.id)}
              copiedArtifact={copiedArtifact}
              onToggleExpand={onTogglePhaseExpand}
              onCopiedArtifact={onCopiedArtifact}
              onRetryPhase={() => onRetryPhase(currentBlueprint.id, workspaceId)}
            />
          ))}
          {completedOrFailed.map((phase) => (
            <PhaseListItem
              key={phase.id}
              phase={phase}
              blueprintStatus={currentBlueprint.status}
              isExpanded={expandedPhases.has(phase.id)}
              copiedArtifact={copiedArtifact}
              onToggleExpand={onTogglePhaseExpand}
              onCopiedArtifact={onCopiedArtifact}
              onRetryPhase={() => onRetryPhase(currentBlueprint.id, workspaceId)}
            />
          ))}
          {pendingPhases.length > 0 && (
            <PendingPhasesSummary phases={pendingPhases} />
          )}
        </div>

        {/* Tasks */}
        {currentBlueprint.tasks.length > 0 && (
          <div className="space-y-2">
            <h5 className="text-xs font-medium text-text-secondary">
              Tasks ({currentBlueprint.tasks.length})
            </h5>
            {currentBlueprint.tasks.map((task) => (
              <TaskListItem key={task.id} task={task} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Small sub-components ──

function BackButton({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary bg-surface-base hover:bg-surface-hover border border-border-subtle rounded-lg transition-colors"
    >
      <ArrowLeft size={14} />
      Back to list
    </button>
  )
}

function DescriptionBlock({
  description,
  expanded,
  onToggle
}: {
  description: string
  expanded: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <div className="relative">
      <div
        className={`prose prose-sm max-w-none text-text-secondary overflow-hidden ${
          expanded ? 'max-h-72 overflow-y-auto' : 'max-h-36'
        }`}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkBreaks]}
          components={{
            a: ({
              href,
              children
            }: {
              href?: string
              children?: React.ReactNode
            }) => (
              <a
                href={href}
                className="text-accent hover:text-accent/80 underline"
                target="_blank"
                rel="noreferrer"
                onClick={(e) => {
                  e.preventDefault()
                  if (href) window.open(href, '_blank')
                }}
              >
                {children}
              </a>
            )
          }}
        >
          {description}
        </ReactMarkdown>
      </div>
      {description.length > 300 && (
        <>
          {!expanded && (
            <div className="absolute bottom-6 left-0 right-0 h-8 bg-gradient-to-t from-surface-raised to-transparent pointer-events-none" />
          )}
          <button
            type="button"
            onClick={onToggle}
            className="text-[11px] text-primary-text hover:text-primary-hover transition-colors mt-1"
          >
            {expanded ? 'Show less' : 'Show more…'}
          </button>
        </>
      )}
    </div>
  )
}

function PendingPhasesSummary({
  phases
}: {
  phases: { phase: string }[]
}): JSX.Element {
  return (
    <div className="rounded-lg bg-surface-base/50 border border-border-subtle/50 px-3 py-2">
      <span className="text-[11px] text-text-muted">
        {phases.length} phase{phases.length !== 1 ? 's' : ''} pending
        <span className="ml-1 opacity-60">
          ({phases.map((p) => PHASE_CONFIG[p.phase as keyof typeof PHASE_CONFIG]?.label ?? p.phase).join(', ')})
        </span>
      </span>
    </div>
  )
}
