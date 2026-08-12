import { useCallback } from 'react'
import { useChatStore } from '@renderer/store'
import { useCouncilStore } from '@renderer/store/council.store'
import { useMpaStore } from '@renderer/store/mpa.store'
import { usePlanStore } from '@renderer/store/plan.store'
import type { PlanRecord } from '../../../../../shared/types'
import { copyTextToClipboard } from '@renderer/utils/clipboard'

interface PlanNavigation {
  onNavigateToChat: () => void
  onNavigateToGoals?: () => void
  onNavigateToCouncil?: () => void
}

interface PlanActions {
  handleOpenInChat: (plan: PlanRecord) => void
  handleStartGoal: (plan: PlanRecord) => void
  handleCouncilReview: (plan: PlanRecord) => void
  handleCopyPlan: (plan: PlanRecord) => void
  handleArchive: (plan: PlanRecord) => void
  handleRestore: (plan: PlanRecord) => void
  handleDelete: (plan: PlanRecord) => void
  handleOpenConversation: (conversationId: string) => void
}

export function usePlanActions(
  workspaceId: string | undefined,
  navigation: PlanNavigation
): PlanActions {
  const { updateStatus, deletePlan, importPlan } = usePlanStore()
  const { onNavigateToChat, onNavigateToGoals, onNavigateToCouncil } = navigation

  const handleOpenInChat = useCallback(
    async (plan: PlanRecord) => {
      if (!workspaceId) return
      try {
        await importPlan(plan.id, workspaceId)
        onNavigateToChat()
      } catch (err) {
        console.error('Failed to import plan:', err)
      }
    },
    [workspaceId, importPlan, onNavigateToChat]
  )

  const handleStartGoal = useCallback(
    (plan: PlanRecord) => {
      const planContent = plan.requirementDocument || `# ${plan.title}\n\n${plan.summary}`
      useMpaStore.getState().setPreloadedGoal({ text: planContent })
      updateStatus(plan.id, 'handed_off')
      onNavigateToGoals?.()
    },
    [updateStatus, onNavigateToGoals]
  )

  const handleCouncilReview = useCallback(
    (plan: PlanRecord) => {
      if (!workspaceId) return

      const councilStore = useCouncilStore.getState()
      councilStore.startCouncil()

      const planContent = plan.requirementDocument || `# ${plan.title}\n\n${plan.summary}`

      window.api
        .councilStart({
          workspaceId,
          inputType: 'plan' as const,
          planContent,
          structuredPlan: plan.structuredPlan ?? undefined,
          originalUserRequest: plan.title,
          conversationId: undefined
        })
        .then(({ sessionId }) => {
          councilStore.setSessionIdentity(sessionId, workspaceId)
          councilStore.setInputTitle(plan.title)
          updateStatus(plan.id, 'handed_off')
        })
        .catch(() => councilStore.reset())

      onNavigateToCouncil?.()
    },
    [workspaceId, updateStatus, onNavigateToCouncil]
  )

  const handleCopyPlan = useCallback(async (plan: PlanRecord) => {
    const content =
      plan.requirementDocument ||
      `# ${plan.title}\n\n${plan.summary}\n\n${JSON.stringify(plan.structuredPlan, null, 2)}`
    await copyTextToClipboard(content)
  }, [])

  const handleArchive = useCallback(
    (plan: PlanRecord) => updateStatus(plan.id, 'archived'),
    [updateStatus]
  )

  const handleRestore = useCallback(
    (plan: PlanRecord) => updateStatus(plan.id, 'saved'),
    [updateStatus]
  )

  const handleDelete = useCallback((plan: PlanRecord) => deletePlan(plan.id), [deletePlan])

  const handleOpenConversation = useCallback(
    async (conversationId: string) => {
      try {
        await useChatStore.getState().selectConversation(conversationId)
      } catch (err) {
        console.error('Failed to select conversation:', err)
      }
      onNavigateToChat()
    },
    [onNavigateToChat]
  )

  return {
    handleOpenInChat,
    handleStartGoal,
    handleCouncilReview,
    handleCopyPlan,
    handleArchive,
    handleRestore,
    handleDelete,
    handleOpenConversation
  }
}
