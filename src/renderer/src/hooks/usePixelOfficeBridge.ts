/**
 * Bridge hook that syncs Agent Studio Zustand stores → Pixel Office engine state.
 *
 * Subscribes to useAgentStore (agent statuses) and useChatStore (tool activities),
 * and translates changes into pixel office engine commands (addAgent, setAnimation, etc.).
 *
 * Handles placeholder↔real agent swaps: idle placeholder agents are removed when
 * a real session starts and restored when it ends.
 *
 * Uses alias names from useProfileStore (coreAgentAliases) and specialist DB names.
 */

import { useEffect, useRef, type RefObject } from 'react'
import { useAgentStore, useChatStore } from '@renderer/store'
import { useSpecialistStore } from '@renderer/store/specialist.store'
import { useProfileStore } from '@renderer/store/profile.store'
import {
  getSpriteAssignment,
  getDefaultSeatIndex,
  STATUS_BUBBLES
} from '@renderer/components/pixel-office/agentMapping'

// Forward reference to the engine interface — will be fully typed once engine is ported
export interface PixelOfficeEngine {
  addAgent(
    id: string,
    numericId: number,
    spriteIndex: number,
    hueShift: number,
    seatIndex: number,
    displayName?: string,
    pixelSpriteId?: string
  ): void
  removeAgent(numericId: number): void
  setAgentActive(numericId: number, active: boolean): void
  setAgentTool(numericId: number, toolName: string | null): void
  showPermissionBubble(numericId: number, text: string): void
  clearPermissionBubble(numericId: number): void
  getTotalSeats(): number
  getAgentNumericId(agentId: string): number | undefined
  /** Get placeholder numeric ID for an agent type, if one exists */
  getPlaceholderNumericId(agentType: string): number | undefined
  /** Remove a placeholder agent to make room for a real session */
  removePlaceholder(agentType: string): void
  /** Restore a placeholder idle agent when a real session ends */
  restorePlaceholder(agentType: string): void
  /** Set the thought/activity text bubble for an agent */
  setAgentThought(numericId: number, thought: string | null): void
  /** Update an agent display name label */
  updateDisplayName(numericId: number, name: string): void
}

/**
 * Simple hash to generate a stable numeric ID from a string agent ID.
 */
function agentIdToNumeric(agentId: string): number {
  let hash = 0
  for (let i = 0; i < agentId.length; i++) {
    hash = (hash << 5) - hash + agentId.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash) % 100000
}

/**
 * Hook that bridges Zustand stores to the pixel office engine.
 *
 * @param engineRef - Ref to the pixel office engine instance (null when engine not ready)
 */
export function usePixelOfficeBridge(engineRef: RefObject<PixelOfficeEngine | null>): void {
  const statuses = useAgentStore((s) => s.statuses)
  const toolActivities = useChatStore((s) => s.toolActivities)
  const specialists = useSpecialistStore((s) => s.specialists)
  const coreAgentAliases = useProfileStore((s) => s.coreAgentAliases)

  // Track which agents we've already added to the engine
  const trackedAgents = useRef<Set<string>>(new Set())
  // Track active speech bubble timeouts
  const bubbleTimeouts = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // ── Sync agent statuses → engine ──
  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return

    const currentAgentIds = new Set(statuses.map((s) => s.agentId))
    const totalSeats = engine.getTotalSeats()

    // Add new agents
    for (const status of statuses) {
      if (!trackedAgents.current.has(status.agentId)) {
        // Remove placeholder for this agent type first
        const placeholderId = engine.getPlaceholderNumericId(status.agentType)
        if (placeholderId !== undefined) {
          engine.removePlaceholder(status.agentType)
        }

        // Look up specialist metadata for color-based hue
        const specialist = specialists.find((s) => s.agentId === status.agentType)
        const assignment = getSpriteAssignment(status.agentType, specialist?.color)
        const seatIndex = getDefaultSeatIndex(status.agentType, totalSeats)
        const numericId = agentIdToNumeric(status.agentId)

        // Resolve display name: alias → specialist DB name → derived from ID
        const displayName = resolveDisplayName(
          status.agentType,
          coreAgentAliases,
          specialist?.displayName
        )

        // Prefer DB pixelSpriteId → static assignment pixelSpriteId → legacy fallback
        const pixelSpriteId = specialist?.pixelSpriteId ?? assignment.pixelSpriteId

        engine.addAgent(status.agentId, numericId, assignment.spriteIndex, assignment.hueShift, seatIndex, displayName, pixelSpriteId)
        trackedAgents.current.add(status.agentId)
      }

      // Update animation state
      const numericId = agentIdToNumeric(status.agentId)
      const isActive =
        status.status === 'thinking' || status.status === 'writing' || status.status === 'reviewing'
      engine.setAgentActive(numericId, isActive)

      // Map status to thought bubble
      if (status.status === 'thinking') {
        engine.setAgentThought(numericId, '💭 Thinking...')
      } else if (status.status === 'writing') {
        engine.setAgentThought(numericId, '✍️ Writing code...')
      } else if (status.status === 'reviewing') {
        engine.setAgentThought(numericId, '👀 Reviewing...')
      } else if (status.status === 'completed') {
        engine.setAgentThought(numericId, '✅ Done!')
      } else if (status.status === 'idle') {
        engine.setAgentThought(numericId, null)
      }

      // Handle status-based speech bubbles (completed/failed)
      const bubbleConfig = STATUS_BUBBLES[status.status]
      if (bubbleConfig) {
        engine.showPermissionBubble(numericId, bubbleConfig.text)

        // Clear any existing timeout for this agent
        const existingTimeout = bubbleTimeouts.current.get(status.agentId)
        if (existingTimeout) clearTimeout(existingTimeout)

        // Auto-clear bubble after duration
        const timeout = setTimeout(() => {
          engine.clearPermissionBubble(numericId)
          bubbleTimeouts.current.delete(status.agentId)
        }, bubbleConfig.durationMs)
        bubbleTimeouts.current.set(status.agentId, timeout)
      }
    }

    // Remove agents that are no longer in statuses
    for (const trackedId of trackedAgents.current) {
      if (!currentAgentIds.has(trackedId)) {
        const numericId = agentIdToNumeric(trackedId)
        engine.setAgentThought(numericId, null)
        engine.removeAgent(numericId)
        trackedAgents.current.delete(trackedId)

        // Restore placeholder for this agent type
        // Find the agent type from the tracked ID (we need to look it up from last known statuses)
        // Since we're iterating over agents being removed, we need to find the agentType
        // The trackedId is the agentId — we can derive agentType from it
        // For now, restore placeholder by checking known agent type patterns
        const agentType = findAgentTypeForId(trackedId)
        if (agentType) {
          engine.restorePlaceholder(agentType)
        }

        // Clean up bubble timeout
        const timeout = bubbleTimeouts.current.get(trackedId)
        if (timeout) {
          clearTimeout(timeout)
          bubbleTimeouts.current.delete(trackedId)
        }
      }
    }

    // Sync display names for all tracked agents (aliases may load after initial add)
    for (const status of statuses) {
      if (trackedAgents.current.has(status.agentId)) {
        const numericId = agentIdToNumeric(status.agentId)
        const specialist = specialists.find((s) => s.agentId === status.agentType)
        const displayName = resolveDisplayName(
          status.agentType,
          coreAgentAliases,
          specialist?.displayName
        )
        engine.updateDisplayName(numericId, displayName)
      }
    }

    // Sync placeholder display names for known idle agent types
    for (const agentType of KNOWN_AGENT_TYPES) {
      const placeholderNumericId = engine.getPlaceholderNumericId(agentType)
      if (placeholderNumericId === undefined) continue

      const specialist = specialists.find((s) => s.agentId === agentType)
      const displayName = resolveDisplayName(agentType, coreAgentAliases, specialist?.displayName)
      engine.updateDisplayName(placeholderNumericId, displayName)
    }
  }, [statuses, specialists, coreAgentAliases, engineRef])

  // ── Sync tool activities → thought bubbles + tool state ──
  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return

    for (const activity of toolActivities) {
      // Tool activities don't have an agentId directly — we match by
      // looking at active agents. For now, show tool on the first active agent.
      // TODO: When tool activities include agentId, use it directly.
      const activeAgent = statuses.find((s) => s.status === 'writing' || s.status === 'thinking')
      if (!activeAgent) continue

      const numericId = agentIdToNumeric(activeAgent.agentId)

      if (activity.status === 'running') {
        engine.setAgentTool(numericId, activity.toolName)
        engine.setAgentThought(numericId, `🔧 ${activity.toolName}`)
      } else {
        engine.setAgentTool(numericId, null)
      }
    }
  }, [toolActivities, statuses, engineRef])

  // ── Cleanup on unmount ──
  useEffect(() => {
    return () => {
      // Clear all bubble timeouts
      for (const timeout of bubbleTimeouts.current.values()) {
        clearTimeout(timeout)
      }
      bubbleTimeouts.current.clear()
      trackedAgents.current.clear()
    }
  }, [])
}

// ── Helpers ──

/**
 * Resolve the display name for an agent using alias, specialist name, or ID derivation.
 */
function resolveDisplayName(
  agentType: string,
  coreAgentAliases: Array<{ agentRole: string; alias: string | null }>,
  specialistName?: string
): string {
  // Check core agent aliases first
  if (agentType === 'generalist') {
    const alias = coreAgentAliases.find((a) => a.agentRole === 'generalist')?.alias
    if (alias) return alias
  }
  if (agentType === 'orchestrator') {
    const alias = coreAgentAliases.find((a) => a.agentRole === 'coordinator')?.alias
    if (alias) return alias
  }

  // Use specialist DB name
  if (specialistName) return specialistName

  // Fallback: derive from agent type ID
  return agentType
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Try to find the agent type from a tracked agent ID.
 * Agent IDs may contain the type (e.g., 'generalist-session-abc' contains 'generalist').
 * This is a best-effort match.
 */
const KNOWN_AGENT_TYPES = [
  'orchestrator',
  'generalist',
  'react-architect',
  'dotnet-architect',
  'electron-architect',
  'agentic-architect',
  'db-architect',
  'ux-ui-specialist',
  'git-github-specialist',
  'requirements-specialist',
  'code-planner',
  'execution-planner',
  'cicd-devops',
  'cloud-infrastructure'
] as const

function findAgentTypeForId(agentId: string): string | null {
  // Check if the agentId starts with or contains a known type
  for (const type of KNOWN_AGENT_TYPES) {
    if (agentId === type || agentId.startsWith(type + '-') || agentId.startsWith(type + ':')) {
      return type
    }
  }
  return null
}
