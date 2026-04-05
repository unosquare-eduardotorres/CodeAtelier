/**
 * Syncs Agent Studio Zustand agent store → Pixel Office engine.
 * Handles agent add/remove, status-to-animation mapping, placeholder management,
 * display name resolution, and status-based speech bubbles.
 */

import { useEffect, useMemo, useRef, type RefObject } from 'react'
import { useAgentStore } from '@renderer/store'
import { useSpecialistStore } from '@renderer/store/specialist.store'
import {
  getSpriteAssignment,
  getDefaultSeatIndex,
  STATUS_BUBBLES
} from '../../agentMapping'
import type { PixelOfficeEngine } from './types'
import {
  agentIdToNumeric,
  KNOWN_AGENT_TYPES,
  resolveDisplayName,
  findAgentTypeForId
} from './types'

/**
 * Sync agent statuses from Zustand stores to the pixel office engine.
 * Handles add/remove, active state, thought bubbles, display names, and placeholders.
 */
export function useAgentSync(
  engineRef: RefObject<PixelOfficeEngine | null>,
  engineReady: boolean
): void {
  const statuses = useAgentStore((s) => s.statuses)
  const specialists = useSpecialistStore((s) => s.specialists)

  const specialistMap = useMemo(
    () => new Map(specialists.map((s) => [s.agentId, s])),
    [specialists]
  )

  const trackedAgents = useRef<Set<string>>(new Set())
  const bubbleTimeouts = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return

    const currentAgentIds = new Set(statuses.map((s) => s.agentId))
    const totalSeats = engine.getTotalSeats()

    // Add new agents
    for (const status of statuses) {
      if (!trackedAgents.current.has(status.agentId)) {
        const placeholderId = engine.getPlaceholderNumericId(status.agentType)
        if (placeholderId !== undefined) {
          engine.removePlaceholder(status.agentType)
        }

        const specialist = specialistMap.get(status.agentType)
        const assignment = getSpriteAssignment(status.agentType, specialist?.color)
        const seatIndex = getDefaultSeatIndex(status.agentType, totalSeats)
        const numericId = agentIdToNumeric(status.agentId)

        const displayName = resolveDisplayName(status.agentType, specialist)

        const pixelSpriteId = specialist?.pixelSpriteId ?? assignment.pixelSpriteId

        engine.addAgent(
          status.agentId,
          numericId,
          assignment.spriteIndex,
          assignment.hueShift,
          seatIndex,
          displayName,
          pixelSpriteId
        )
        trackedAgents.current.add(status.agentId)
      }

      // Update animation state
      const numericId = agentIdToNumeric(status.agentId)
      const isActive =
        status.status === 'thinking' || status.status === 'writing' || status.status === 'reviewing'
      engine.setAgentActive(numericId, isActive)

      // Map status to thought bubble
      if (status.status === 'thinking') {
        engine.setAgentThought(numericId, '\u{1F4AD} Thinking...')
      } else if (status.status === 'writing') {
        engine.setAgentThought(numericId, '\u270D\uFE0F Writing code...')
      } else if (status.status === 'reviewing') {
        engine.setAgentThought(numericId, '\u{1F440} Reviewing...')
      } else if (status.status === 'completed') {
        engine.setAgentThought(numericId, '\u2705 Done!')
      } else if (status.status === 'idle') {
        engine.setAgentThought(numericId, null)
      }

      // Handle status-based speech bubbles
      const bubbleConfig = STATUS_BUBBLES[status.status]
      if (bubbleConfig) {
        engine.showPermissionBubble(numericId, bubbleConfig.text)

        const existingTimeout = bubbleTimeouts.current.get(status.agentId)
        if (existingTimeout) clearTimeout(existingTimeout)

        const timeout = setTimeout(() => {
          engine.clearPermissionBubble(numericId)
          bubbleTimeouts.current.delete(status.agentId)
        }, bubbleConfig.durationMs)
        bubbleTimeouts.current.set(status.agentId, timeout)
      }
    }

    // Remove agents no longer in statuses
    for (const trackedId of trackedAgents.current) {
      if (!currentAgentIds.has(trackedId)) {
        const numericId = agentIdToNumeric(trackedId)
        engine.setAgentThought(numericId, null)
        engine.removeAgent(numericId)
        trackedAgents.current.delete(trackedId)

        const agentType = findAgentTypeForId(trackedId)
        if (agentType) {
          engine.restorePlaceholder(agentType)
        }

        const timeout = bubbleTimeouts.current.get(trackedId)
        if (timeout) {
          clearTimeout(timeout)
          bubbleTimeouts.current.delete(trackedId)
        }
      }
    }

    // Sync display names for tracked agents
    for (const status of statuses) {
      if (trackedAgents.current.has(status.agentId)) {
        const numericId = agentIdToNumeric(status.agentId)
        const specialist = specialistMap.get(status.agentType)
        const displayName = resolveDisplayName(status.agentType, specialist)
        engine.updateDisplayName(numericId, displayName)
      }
    }

    // Sync placeholder display names
    for (const agentType of KNOWN_AGENT_TYPES) {
      const placeholderNumericId = engine.getPlaceholderNumericId(agentType)
      if (placeholderNumericId === undefined) continue
      const specialist = specialistMap.get(agentType)
      const displayName = resolveDisplayName(agentType, specialist)
      engine.updateDisplayName(placeholderNumericId, displayName)
    }
  }, [statuses, specialistMap, engineRef, engineReady])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const timeout of bubbleTimeouts.current.values()) {
        clearTimeout(timeout)
      }
      bubbleTimeouts.current.clear()
      trackedAgents.current.clear()
    }
  }, [])
}
