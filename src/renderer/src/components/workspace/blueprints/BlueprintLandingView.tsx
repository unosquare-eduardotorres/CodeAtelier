// @ts-nocheck — TODO: fix after blueprint refactoring
import type { JSX } from 'react'
import { BookOpen, Plus, XCircle, RotateCcw, AlertTriangle, PlayCircle, X } from 'lucide-react'
import { BlueprintHistoryItem, BlueprintFilterBar, PHASE_CONFIG } from '.'
import type { BlueprintFilter } from '.'
import type { Blueprint } from '../../../../../shared/blueprint-types'

interface BlueprintLandingViewProps {
  history: Blueprint[]
  filteredHistory: Blueprint[]
  filter: BlueprintFilter
  searchQuery: string
  filterCounts: Record<BlueprintFilter, number>
  lastError: { phase: string; message: string; blueprintId: string } | null
  orphanedBlueprint: {
    blueprintId: string
    title: string
    currentPhase: string
    tasksCompleted: number
    totalTasks: number
  } | null
  workspaceId: string
  onFilterChange: (f: BlueprintFilter) => void
  onSearchChange: (q: string) => void
  onNewBlueprint: () => void
  onSelectBlueprint: (id: string) => void
  onRetry: (bp: Blueprint) => void
  onRetryPhase: (blueprintId: string, workspaceId: string) => void
  onDismissOrphan: () => void
  onDelete: (id: string) => void
}

const EMPTY_FILTER_MESSAGES: Record<BlueprintFilter, string> = {
  all: 'No blueprints yet. Create one to get started!',
  active: 'No active blueprints running.',
  complete: 'No completed blueprints yet.',
  failed: 'No failed blueprints — nice!'
}

export default function BlueprintLandingView({
  history,
  filteredHistory,
  filter,
  searchQuery,
  filterCounts,
  lastError,
  orphanedBlueprint,
  workspaceId,
  onFilterChange,
  onSearchChange,
  onNewBlueprint,
  onSelectBlueprint,
  onRetry,
  onRetryPhase,
  onDismissOrphan,
  onDelete
}: BlueprintLandingViewProps): JSX.Element {
  return (
    <div data-testid="blueprint-landing" className="max-w-3xl mx-auto w-full space-y-6">
      {/* Empty state */}
      {history.length === 0 && (
        <div className="flex flex-col items-center justify-center py-10 px-4">
          <div className="max-w-2xl w-full space-y-6">
            <div className="text-center space-y-2">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-emerald-500/15 mb-2">
                <BookOpen size={28} className="text-emerald-400" />
              </div>
              <h2 className="text-lg font-semibold text-text-primary">Your Blueprints</h2>
              <p className="text-sm text-text-secondary max-w-md mx-auto">
                Describe a feature and the agent will{' '}
                <span className="text-text-primary font-medium">
                  specify, clarify, plan, build, and verify
                </span>{' '}
                it through a 7-phase pipeline — pausing for your approval.
              </p>
            </div>

            {/* 7-phase workflow cards */}
            <div className="grid grid-cols-4 gap-3">
              {(['specify', 'plan', 'build', 'verify'] as const).map((phase) => {
                const config = PHASE_CONFIG[phase]
                const Icon = config.icon
                return (
                  <div
                    key={phase}
                    className="rounded-xl border border-border-subtle bg-surface-overlay p-3 space-y-1.5"
                  >
                    <div className="flex items-center gap-2">
                      <Icon size={16} className={config.color} />
                      <span className="text-sm font-semibold text-text-primary">
                        {config.label}
                      </span>
                    </div>
                    <p className="text-xs text-text-secondary leading-relaxed">
                      {config.description}
                    </p>
                  </div>
                )
              })}
            </div>

            <div className="flex justify-center">
              <button
                onClick={onNewBlueprint}
                className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 rounded-xl transition-colors"
              >
                <Plus size={16} />
                Create Your First Blueprint
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Filter bar + history list */}
      {history.length > 0 && (
        <div className="space-y-3">
          <BlueprintFilterBar
            filter={filter}
            searchQuery={searchQuery}
            counts={filterCounts}
            onFilterChange={onFilterChange}
            onSearchChange={onSearchChange}
            onNewBlueprint={onNewBlueprint}
          />

          {/* Blueprint error banner */}
          {lastError && (
            <div className="flex items-start gap-3 px-4 py-3 rounded-lg border border-red-500/20 bg-red-500/5 text-red-300">
              <XCircle size={16} className="mt-0.5 flex-shrink-0" />
              <div className="flex flex-col gap-0.5 flex-1">
                <span className="text-sm font-medium">
                  {lastError.phase.charAt(0).toUpperCase() + lastError.phase.slice(1)} phase failed
                </span>
                <span className="text-xs opacity-80">{lastError.message}</span>
              </div>
              <button
                onClick={() => onRetryPhase(lastError.blueprintId, workspaceId)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-primary-text bg-primary-muted border border-primary/20 rounded-lg hover:bg-primary/20 transition-colors flex-shrink-0"
              >
                <RotateCcw size={12} />
                Retry Phase
              </button>
            </div>
          )}

          {/* BP-RESUME-02: Orphaned blueprint resume banner */}
          {orphanedBlueprint && (
            <div className="flex items-start gap-3 px-4 py-3 rounded-lg border border-amber-500/20 bg-amber-500/5 text-amber-300">
              <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
              <div className="flex flex-col gap-0.5 flex-1">
                <span className="text-sm font-medium">
                  &ldquo;{orphanedBlueprint.title}&rdquo; was interrupted during{' '}
                  {orphanedBlueprint.currentPhase}
                </span>
                <span className="text-xs opacity-80">
                  {orphanedBlueprint.totalTasks > 0
                    ? `${orphanedBlueprint.tasksCompleted}/${orphanedBlueprint.totalTasks} tasks complete`
                    : 'No tasks started yet'}
                </span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={() => onRetryPhase(orphanedBlueprint.blueprintId, workspaceId)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-white bg-amber-600 hover:bg-amber-500 rounded-lg transition-colors"
                >
                  <PlayCircle size={12} />
                  Resume
                </button>
                <button
                  onClick={onDismissOrphan}
                  className="inline-flex items-center justify-center w-6 h-6 text-amber-400/60 hover:text-amber-300 rounded transition-colors"
                  title="Dismiss"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          )}

          {filteredHistory.length > 0 ? (
            <div className="space-y-2">
              {filteredHistory.map((bp) => (
                <BlueprintHistoryItem
                  key={bp.id}
                  blueprint={bp}
                  onSelect={() => onSelectBlueprint(bp.id)}
                  onRetry={() => onRetry(bp)}
                  onDelete={() => onDelete(bp.id)}
                />
              ))}
            </div>
          ) : (
            <div className="text-center py-8">
              <p className="text-xs text-text-muted">
                {searchQuery.trim()
                  ? 'No blueprints match your search.'
                  : EMPTY_FILTER_MESSAGES[filter]}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
