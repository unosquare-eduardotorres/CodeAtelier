/**
 * PlanCard — Thin backward-compatibility wrapper.
 * All rendering logic has been unified into TaskPlanCard.
 * Kept so existing barrel imports (`export { default as PlanCard }`) continue to work.
 */
import TaskPlanCard from './TaskPlanCard'

interface PlanCardProps {
  planContent: string
  onBuildNow: () => void
  onRefine: () => void
  onSaveAsIdea?: () => void
  onOrchestratedBuild?: () => void
}

export default function PlanCard({
  planContent,
  onBuildNow,
  onRefine,
  onSaveAsIdea,
  onOrchestratedBuild
}: PlanCardProps): React.JSX.Element {
  return (
    <TaskPlanCard
      summary="Implementation Plan"
      mode="plan"
      planContent={planContent}
      onBuildNow={onBuildNow}
      onRefine={onRefine}
      onSaveAsIdea={onSaveAsIdea}
      onOrchestratedBuild={onOrchestratedBuild}
    />
  )
}
