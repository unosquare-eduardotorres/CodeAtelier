/**
 * Plan-related action callbacks extracted from useHealthPageState
 * to reduce cyclomatic complexity.
 */
import { useCallback } from 'react'
import { useAuditStore, useMpaStore } from '@renderer/store'
import { useCouncilStore } from '@renderer/store/council.store'
import { auditPlanToStructuredPlan } from '../../../utils/audit-plan-converter'

interface PlanActionCallbacks {
  onFixInNewChat: () => void
  onSendPlanToGrill?: (title: string, description: string) => void
  onNavigateToCouncil?: () => void
  onNavigateToGoals?: () => void
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function useHealthPlanActions(
  workspaceId: string | undefined,
  callbacks: PlanActionCallbacks,
  setView: (view: string) => void
) {
  const { currentPlan, generatePlan, clearPlan, setPendingFixContext, clearSelectedFindings } =
    useAuditStore()

  const planDoc = currentPlan?.plan.requirementDocument ?? currentPlan?.plan.summary ?? ''
  const planTitle = currentPlan?.plan.title ?? 'Audit Remediation Plan'

  const handleBuildPlan = useCallback(() => {
    if (!workspaceId) return
    setView('plan')
    generatePlan(workspaceId).catch(() => setView('active'))
  }, [workspaceId, generatePlan, setView])

  const handleSendPlanToChat = useCallback(() => {
    if (!currentPlan) return
    const structuredPlan = auditPlanToStructuredPlan(currentPlan.plan)
    const planBlock = '```plan\n' + JSON.stringify(structuredPlan, null, 2) + '\n```'
    setPendingFixContext({ title: `🔧 ${planTitle}`, description: planBlock })
    clearSelectedFindings()
    callbacks.onFixInNewChat()
  }, [currentPlan, planTitle, setPendingFixContext, clearSelectedFindings, callbacks])

  const handleSendPlanToCouncil = useCallback(() => {
    if (!workspaceId || !currentPlan) return
    const councilStore = useCouncilStore.getState()
    councilStore.startCouncil()
    const structuredPlan = auditPlanToStructuredPlan(currentPlan.plan)
    window.api
      .councilStart({
        workspaceId,
        inputType: 'plan',
        planContent: planDoc,
        structuredPlan,
        originalUserRequest: planTitle,
        conversationId: undefined
      })
      .then(({ sessionId }) => {
        councilStore.setSessionIdentity(sessionId, workspaceId)
        councilStore.setInputTitle(planTitle)
      })
      .catch(() => councilStore.reset())
    callbacks.onNavigateToCouncil?.()
  }, [workspaceId, currentPlan, planDoc, planTitle, callbacks])

  const handleSendPlanToGoals = useCallback(() => {
    if (!currentPlan) return
    useMpaStore.getState().setPreloadedGoal({ text: `${planTitle}\n\n${planDoc}` })
    callbacks.onNavigateToGoals?.()
  }, [currentPlan, planTitle, planDoc, callbacks])

  const handleSendPlanToGrill = useCallback(() => {
    if (!currentPlan) return
    callbacks.onSendPlanToGrill?.(planTitle, planDoc)
  }, [currentPlan, planTitle, planDoc, callbacks])

  const handleBackToResults = useCallback(() => {
    clearPlan()
    setView('active')
  }, [clearPlan, setView])

  return {
    currentPlan,
    planDoc,
    planTitle,
    handleBuildPlan,
    handleSendPlanToChat,
    handleSendPlanToCouncil,
    handleSendPlanToGoals,
    handleSendPlanToGrill,
    handleBackToResults
  }
}
