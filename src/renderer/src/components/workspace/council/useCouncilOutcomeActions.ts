/**
 * useCouncilOutcomeActions — bridges council verdict → chat/plan execution.
 *
 * Two flows:
 *   - "Update Plan" (has originConversationId): go back to chat, agent regenerates
 *   - "Accept & Build" (standalone): create new chat via Plan Hub import
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePlanStore } from '@renderer/store/plan.store'
import { useChatStore } from '@renderer/store'
import { usePlanExecutionStore } from '@renderer/store/plan-execution.store'
import { useToastStore } from '@renderer/store/toast.store'
import { useCouncilStore } from '@renderer/store/council.store'
import type { CouncilVerdict } from '../../../../../shared/types'

function buildUpdatePlanMessage(verdict: CouncilVerdict, currentGoal?: string): string {
  const lines = [
    `🏛️ **Council Review Complete** — Score: **${verdict.overallScore}/100**`,
    '',
    `**Recommendation:** ${verdict.sections.recommendation}`
  ]
  if (currentGoal) {
    lines.push('', `**Current Goal:** ${currentGoal}`)
  }
  if (verdict.revisions?.length) {
    lines.push('', '**Revisions to incorporate:**')
    for (const r of verdict.revisions) {
      lines.push(`- [${r.priority.toUpperCase()}] ${r.description} (${r.consensus})`)
    }
  }
  lines.push(
    '',
    `Regenerate the plan incorporating these revisions${currentGoal ? ' and the goal above' : ', including an updated `goal` field that reflects the revised scope'}. ` +
      'Output the updated plan in a ```plan``` block.'
  )
  return lines.join('\n')
}

interface OutcomeActions {
  /** Go back to originating chat, send council feedback, agent regenerates plan */
  handleUpdatePlan: (
    sessionId: string,
    verdict: CouncilVerdict,
    originConversationId: string,
    workspaceId: string
  ) => Promise<void>
  /** Create new chat with imported plan, navigate to it */
  handleAcceptAndBuild: (sessionId: string, workspaceId: string) => Promise<void>
  /** Whether an action is in progress */
  isProcessing: boolean
}

export function useCouncilOutcomeActions(onNavigateToChat: () => void): OutcomeActions {
  const [isProcessing, setIsProcessing] = useState(false)
  const mountedRef = useRef(true)
  const { importPlan } = usePlanStore()

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const handleUpdatePlan = useCallback(
    async (
      sessionId: string,
      verdict: CouncilVerdict,
      originConversationId: string,
      workspaceId: string
    ): Promise<void> => {
      setIsProcessing(true)
      try {
        const chatStore = useChatStore.getState()

        // Verify originating conversation still exists
        const conv = chatStore.conversations.find((c) => c.id === originConversationId)
        if (!conv) {
          // Fallback: conversation was deleted — treat as standalone
          console.warn('[council-outcome] Origin conversation not found, falling back to import')
          const plan = await window.api.planFindBySource({
            source: 'council',
            sourceId: sessionId
          })
          if (!plan) {
            useCouncilStore.getState().reset()
            useToastStore.getState().addToast({
              type: 'info',
              message: 'Origin conversation was deleted and no plan record exists'
            })
            return
          }
          const result = await importPlan(plan.id, workspaceId)
          const { setLatestPlanContent } = usePlanExecutionStore.getState()
          setLatestPlanContent(result.conversationId, JSON.stringify(plan.structuredPlan))
          await chatStore.selectConversation(result.conversationId)
          onNavigateToChat()
          useCouncilStore.getState().reset()
          return
        }

        // Switch to originating conversation
        await chatStore.selectConversation(originConversationId)
        onNavigateToChat()

        // Guard: don't send into an active stream
        const {
          isStreaming,
          sendingConversationIds,
          activeConversation: activeConv
        } = useChatStore.getState()
        if (isStreaming || sendingConversationIds.has(activeConv?.id ?? '')) {
          useCouncilStore.getState().reset()
          useToastStore.getState().addToast({
            type: 'info',
            message: 'Chat is busy — council feedback was not sent. Paste it manually when ready.'
          })
          return
        }

        // Retrieve stored goal from the council session's structuredPlan
        let storedGoal: string | undefined
        try {
          const plan = await window.api.planFindBySource({
            source: 'council',
            sourceId: sessionId
          })
          if (plan?.structuredPlan?.goal) {
            storedGoal = plan.structuredPlan.goal
          }
        } catch {
          // Non-critical — proceed without goal
        }

        // Send council feedback — triggers agent to regenerate the plan
        const message = buildUpdatePlanMessage(verdict, storedGoal)
        await chatStore.sendMessage(message)

        // Reset council store AFTER navigation + message send completes
        useCouncilStore.getState().reset()
      } catch (err) {
        console.error('[council-outcome] Update plan failed:', err)
        useCouncilStore.getState().reset()
        useToastStore.getState().addToast({
          type: 'error',
          message: 'Failed to update plan from council feedback'
        })
      } finally {
        if (mountedRef.current) setIsProcessing(false)
      }
    },
    [onNavigateToChat, importPlan]
  )

  const handleAcceptAndBuild = useCallback(
    async (sessionId: string, workspaceId: string): Promise<void> => {
      setIsProcessing(true)
      try {
        const plan = await window.api.planFindBySource({
          source: 'council',
          sourceId: sessionId
        })
        if (!plan) {
          useCouncilStore.getState().reset()
          console.warn('[council-outcome] No plan record found for session:', sessionId)
          useToastStore.getState().addToast({
            type: 'info',
            message: 'No structured plan was recorded for this council session'
          })
          return
        }

        const result = await importPlan(plan.id, workspaceId)

        // GAP-4 FIX: Populate plan panel immediately.
        // planImport creates a user message (no ```plan``` block),
        // so we must manually seed latestPlanContent for the panel.
        const { setLatestPlanContent } = usePlanExecutionStore.getState()
        setLatestPlanContent(result.conversationId, JSON.stringify(plan.structuredPlan))

        await useChatStore.getState().selectConversation(result.conversationId)
        onNavigateToChat()

        // Reset council store AFTER navigation completes
        useCouncilStore.getState().reset()
      } catch (err) {
        console.error('[council-outcome] Accept & build failed:', err)
        useCouncilStore.getState().reset()
        useToastStore.getState().addToast({
          type: 'error',
          message: 'Failed to create chat from council plan'
        })
      } finally {
        if (mountedRef.current) setIsProcessing(false)
      }
    },
    [onNavigateToChat, importPlan]
  )

  return { handleUpdatePlan, handleAcceptAndBuild, isProcessing }
}
