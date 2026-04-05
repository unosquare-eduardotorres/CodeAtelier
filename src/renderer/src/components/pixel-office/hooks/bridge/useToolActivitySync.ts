/**
 * Syncs tool activity state from Zustand chat store → Pixel Office engine.
 * Maps tool usage to thought bubbles and tool state for active agents.
 */

import { useEffect, type RefObject } from 'react'
import { useAgentStore, useChatStore } from '@renderer/store'
import type { PixelOfficeEngine } from './types'
import { agentIdToNumeric } from './types'

/**
 * Sync tool activities to the pixel office engine.
 * Shows tool names as thought bubbles on active agents.
 */
export function useToolActivitySync(
  engineRef: RefObject<PixelOfficeEngine | null>,
  engineReady: boolean
): void {
  const statuses = useAgentStore((s) => s.statuses)
  const toolActivities = useChatStore((s) => s.toolActivities)

  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return

    for (const activity of toolActivities) {
      const activeAgent = statuses.find((s) => s.status === 'writing' || s.status === 'thinking')
      if (!activeAgent) continue

      const numericId = agentIdToNumeric(activeAgent.agentId)

      if (activity.status === 'running') {
        engine.setAgentTool(numericId, activity.toolName)
        engine.setAgentThought(numericId, `\u{1F527} ${activity.toolName}`)
      } else {
        engine.setAgentTool(numericId, null)
      }
    }
  }, [toolActivities, statuses, engineRef, engineReady])
}
