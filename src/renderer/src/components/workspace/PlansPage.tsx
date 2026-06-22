/**
 * PlansPage — Browse and manage plans from Chat, Grill, Health, and Council.
 *
 * Renders filtered plan cards with status tabs, search, and action buttons
 * that route plans to Chat, Goals, or Council.
 */

import { useEffect } from 'react'
import { ClipboardList } from 'lucide-react'
import { useWorkspaceStore } from '@renderer/store'
import { usePlanStore, useFilteredPlans } from '@renderer/store/plan.store'
import PlanCard from './plans/PlanCard'
import PlanFilters from './plans/PlanFilters'
import PlanEmptyState from './plans/PlanEmptyState'
import { usePlanActions } from './plans/usePlanActions'

interface PlansPageProps {
  onNavigateToChat: () => void
  onNavigateToGoals?: () => void
  onNavigateToCouncil?: () => void
}

export default function PlansPage({
  onNavigateToChat,
  onNavigateToGoals,
  onNavigateToCouncil
}: PlansPageProps): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const { plans, isLoading, loadPlans, reset } = usePlanStore()
  const filteredPlans = useFilteredPlans()

  const workspaceId = activeWorkspace?.id

  const {
    handleOpenInChat,
    handleStartGoal,
    handleCouncilReview,
    handleCopyPlan,
    handleArchive,
    handleRestore,
    handleDelete,
    handleOpenConversation
  } = usePlanActions(workspaceId, { onNavigateToChat, onNavigateToGoals, onNavigateToCouncil })

  // Load plans on mount and workspace change
  useEffect(() => {
    if (workspaceId) {
      loadPlans(workspaceId)
    }
    return () => {
      reset()
    }
  }, [workspaceId, loadPlans, reset])

  // ── Loading skeleton ──

  if (isLoading && plans.length === 0) {
    return (
      <div className="p-6 space-y-4">
        <div className="flex items-center gap-2 mb-4">
          <ClipboardList size={16} className="text-mode-plan-text" />
          <h3 className="text-sm font-semibold text-text-primary">Plans</h3>
        </div>
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-24 rounded-lg bg-surface-overlay animate-pulse border border-border-subtle"
          />
        ))}
      </div>
    )
  }

  return (
    <div data-testid="plans-page" className="p-6">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <ClipboardList size={16} className="text-mode-plan-text" />
        <h3 className="text-sm font-semibold text-text-primary">Plans</h3>
      </div>
      <p className="text-xs text-text-secondary mb-4">
        Browse and manage plans from Chat, Grill, Health, and Council.
      </p>

      {/* Filters + Search */}
      {plans.length > 0 && <PlanFilters />}

      {/* Plan list or empty state */}
      {plans.length === 0 ? (
        <PlanEmptyState />
      ) : filteredPlans.length === 0 ? (
        <div className="py-8 text-center">
          <p className="text-xs text-text-muted">No plans match the current filters.</p>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {filteredPlans.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              onOpenInChat={handleOpenInChat}
              onStartGoal={handleStartGoal}
              onCouncilReview={handleCouncilReview}
              onCopyPlan={handleCopyPlan}
              onArchive={handleArchive}
              onRestore={handleRestore}
              onDelete={handleDelete}
              onOpenConversation={handleOpenConversation}
            />
          ))}
        </div>
      )}
    </div>
  )
}
