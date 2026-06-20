/**
 * Custom hook encapsulating CouncilView state management, IPC wiring, and computed values.
 * Extracted from CouncilView to reduce component cyclomatic complexity.
 */
import { useEffect, useMemo, useState, useCallback } from 'react'
import { useCouncilStore } from '@renderer/store/council.store'
import { COUNCIL_ADVISOR_ROLES } from '../../../../../shared/constants'
import type { CouncilAdvisorRole } from '../../../../../shared/types'

interface CouncilViewCallbacks {
  onAcceptAndBuild?: () => void
  onRevisePlan?: (feedback: string) => void
  onDismiss?: () => void
  onSendToGoal?: (goal: string, title: string) => void
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function useCouncilViewState(inputTitle: string | undefined, callbacks: CouncilViewCallbacks) {
  const {
    phase, advisors, peerReviews, verdict,
    currentSessionId, currentWorkspaceId,
    inputTitle: storeInputTitle,
    handlePhaseChanged, handleMemberStream, handleMemberComplete,
    handlePeerReviewComplete, handleVerdict,
    reset, startCouncil, setSessionIdentity
  } = useCouncilStore()

  const resolvedTitle = inputTitle ?? storeInputTitle ?? undefined

  // Local UI state
  const [selectedAdvisor, setSelectedAdvisor] = useState<CouncilAdvisorRole>(COUNCIL_ADVISOR_ROLES[0])
  const [activeTab, setActiveTab] = useState<'overview' | 'advisors' | 'peer-reviews'>('overview')

  // Wire IPC listeners
  useEffect(() => {
    const api = window.api
    const cleanups: (() => void)[] = []
    cleanups.push(api.onCouncilPhaseChanged((data) => handlePhaseChanged(data.phase as never)))
    cleanups.push(api.onCouncilMemberStream((data) => handleMemberStream(data)))
    cleanups.push(api.onCouncilMemberComplete((data) => handleMemberComplete(data.advisorRole, data.review as never)))
    cleanups.push(api.onCouncilPeerReviewComplete((data) => handlePeerReviewComplete(data.peerReviews as never)))
    cleanups.push(api.onCouncilVerdict((data) => handleVerdict(data.verdict as never)))
    return () => { cleanups.forEach((fn) => fn()) }
  }, [handlePhaseChanged, handleMemberStream, handleMemberComplete, handlePeerReviewComplete, handleVerdict])

  // Computed
  const isRunning = phase !== 'complete' && phase !== 'cancelled' && phase !== 'failed'
  const isFailed = phase === 'failed'

  const completedCount = useMemo(
    () => COUNCIL_ADVISOR_ROLES.filter((r) => advisors[r].status === 'completed').length,
    [advisors]
  )

  // Action callbacks
  const handleAcceptAndBuild = useCallback(() => {
    reset()
    callbacks.onAcceptAndBuild?.()
  }, [reset, callbacks])

  const handleSendToGoal = useCallback(() => {
    if (!verdict) return
    const goalText = [
      verdict.sections.recommendation, '',
      'Key revisions:',
      ...verdict.revisions
        .filter((r) => r.priority === 'high' || r.priority === 'medium')
        .map((r) => `- ${r.description}`)
    ].join('\n')
    reset()
    callbacks.onSendToGoal?.(goalText, resolvedTitle ?? 'Council-reviewed plan')
  }, [verdict, reset, callbacks, resolvedTitle])

  const handleRevisePlan = useCallback(() => {
    if (!verdict) return
    const feedback = [
      'Council Review Feedback:',
      `Overall Score: ${verdict.overallScore}/100`, '',
      `Recommendation: ${verdict.sections.recommendation}`, '',
      'Revisions needed:',
      ...verdict.revisions.map((r) => `- [${r.priority.toUpperCase()}] ${r.description} (${r.consensus})`)
    ].join('\n')
    reset()
    callbacks.onRevisePlan?.(feedback)
  }, [verdict, reset, callbacks])

  const handleDismiss = useCallback(() => {
    reset()
    callbacks.onDismiss?.()
  }, [reset, callbacks])

  const handleCancel = useCallback(() => {
    window.api.councilCancel()
    reset()
    callbacks.onDismiss?.()
  }, [reset, callbacks])

  const handleResume = useCallback(() => {
    if (currentSessionId && currentWorkspaceId) {
      const sid = currentSessionId
      const wid = currentWorkspaceId
      startCouncil()
      setSessionIdentity(sid, wid)
      window.api.councilResume({ sessionId: sid, workspaceId: wid }).catch(console.error)
    }
  }, [currentSessionId, currentWorkspaceId, startCouncil, setSessionIdentity])

  return {
    // Store values
    phase, advisors, peerReviews, verdict, resolvedTitle,
    // Local state
    selectedAdvisor, setSelectedAdvisor, activeTab, setActiveTab,
    // Computed
    isRunning, isFailed, completedCount,
    // Actions
    handleAcceptAndBuild, handleSendToGoal, handleRevisePlan,
    handleDismiss, handleCancel, handleResume
  }
}
