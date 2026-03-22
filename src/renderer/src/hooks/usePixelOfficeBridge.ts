/**
 * Bridge hook that syncs Agent Studio Zustand stores → Pixel Office engine state.
 *
 * Subscribes to useAgentStore (agent statuses) and useChatStore (tool activities),
 * and translates changes into pixel office engine commands (addAgent, setAnimation, etc.).
 */

import { useEffect, useRef, type RefObject } from 'react';
import { useAgentStore, useChatStore } from '@renderer/store';
import { useSpecialistStore } from '@renderer/store/specialist.store';
import {
  getSpriteAssignment,
  getDefaultSeatIndex,
  STATUS_BUBBLES
} from '@renderer/components/pixel-office/agentMapping';

// Forward reference to the engine interface — will be fully typed once engine is ported
export interface PixelOfficeEngine {
  addAgent(
    id: string,
    numericId: number,
    spriteIndex: number,
    hueShift: number,
    seatIndex: number
  ): void;
  removeAgent(numericId: number): void;
  setAgentActive(numericId: number, active: boolean): void;
  setAgentTool(numericId: number, toolName: string | null): void;
  showPermissionBubble(numericId: number, text: string): void;
  clearPermissionBubble(numericId: number): void;
  getTotalSeats(): number;
  getAgentNumericId(agentId: string): number | undefined;
}

/**
 * Simple hash to generate a stable numeric ID from a string agent ID.
 */
function agentIdToNumeric(agentId: string): number {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = (hash << 5) - hash + agentId.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 100000;
}

/**
 * Hook that bridges Zustand stores to the pixel office engine.
 *
 * @param engineRef - Ref to the pixel office engine instance (null when engine not ready)
 */
export function usePixelOfficeBridge(
  engineRef: RefObject<PixelOfficeEngine | null>
): void {
  const statuses = useAgentStore((s) => s.statuses);
  const toolActivities = useChatStore((s) => s.toolActivities);
  const specialists = useSpecialistStore((s) => s.specialists);

  // Track which agents we've already added to the engine
  const trackedAgents = useRef<Set<string>>(new Set());
  // Track active speech bubble timeouts
  const bubbleTimeouts = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // ── Sync agent statuses → engine ──
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;

    const currentAgentIds = new Set(statuses.map((s) => s.agentId));
    const totalSeats = engine.getTotalSeats();

    // Add new agents
    for (const status of statuses) {
      if (!trackedAgents.current.has(status.agentId)) {
        // Look up specialist metadata for color-based hue
        const specialist = specialists.find((s) => s.agentId === status.agentType);
        const { spriteIndex, hueShift } = getSpriteAssignment(
          status.agentType,
          specialist?.color
        );
        const seatIndex = getDefaultSeatIndex(status.agentType, totalSeats);
        const numericId = agentIdToNumeric(status.agentId);

        engine.addAgent(status.agentId, numericId, spriteIndex, hueShift, seatIndex);
        trackedAgents.current.add(status.agentId);
      }

      // Update animation state
      const numericId = agentIdToNumeric(status.agentId);
      const isActive = status.status === 'thinking' || status.status === 'writing' || status.status === 'reviewing';
      engine.setAgentActive(numericId, isActive);

      // Handle status-based speech bubbles (completed/failed)
      const bubbleConfig = STATUS_BUBBLES[status.status];
      if (bubbleConfig) {
        engine.showPermissionBubble(numericId, bubbleConfig.text);

        // Clear any existing timeout for this agent
        const existingTimeout = bubbleTimeouts.current.get(status.agentId);
        if (existingTimeout) clearTimeout(existingTimeout);

        // Auto-clear bubble after duration
        const timeout = setTimeout(() => {
          engine.clearPermissionBubble(numericId);
          bubbleTimeouts.current.delete(status.agentId);
        }, bubbleConfig.durationMs);
        bubbleTimeouts.current.set(status.agentId, timeout);
      }
    }

    // Remove agents that are no longer in statuses
    for (const trackedId of trackedAgents.current) {
      if (!currentAgentIds.has(trackedId)) {
        const numericId = agentIdToNumeric(trackedId);
        engine.removeAgent(numericId);
        trackedAgents.current.delete(trackedId);

        // Clean up bubble timeout
        const timeout = bubbleTimeouts.current.get(trackedId);
        if (timeout) {
          clearTimeout(timeout);
          bubbleTimeouts.current.delete(trackedId);
        }
      }
    }
  }, [statuses, specialists, engineRef]);

  // ── Sync tool activities → speech bubbles ──
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;

    for (const activity of toolActivities) {
      // Tool activities don't have an agentId directly — we match by
      // looking at active agents. For now, show tool on the first active agent.
      // TODO: When tool activities include agentId, use it directly.
      const activeAgent = statuses.find(
        (s) => s.status === 'writing' || s.status === 'thinking'
      );
      if (!activeAgent) continue;

      const numericId = agentIdToNumeric(activeAgent.agentId);

      if (activity.status === 'running') {
        engine.setAgentTool(numericId, activity.toolName);
      } else {
        engine.setAgentTool(numericId, null);
      }
    }
  }, [toolActivities, statuses, engineRef]);

  // ── Cleanup on unmount ──
  useEffect(() => {
    return () => {
      // Clear all bubble timeouts
      for (const timeout of bubbleTimeouts.current.values()) {
        clearTimeout(timeout);
      }
      bubbleTimeouts.current.clear();
      trackedAgents.current.clear();
    };
  }, []);
}
