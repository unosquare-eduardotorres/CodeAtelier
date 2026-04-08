/**
 * Bridge hook that syncs Agent Studio Zustand stores → Pixel Office engine state.
 *
 * Thin orchestrator that composes focused sync hooks:
 * - useAgentSync: agent add/remove, status mapping, display names, placeholders
 * - useToolActivitySync: tool activity → thought bubbles + tool state
 *
 * Re-exports the PixelOfficeEngine interface for consumers.
 */

import type { RefObject } from 'react'
import { useAgentSync, useToolActivitySync } from './bridge'
import type { PixelOfficeEngine } from './bridge'

// Re-export the engine interface and helpers
export type { PixelOfficeEngine } from './bridge'
export {
  agentIdToNumeric,
  resolveDisplayName,
  findAgentTypeForId,
  KNOWN_AGENT_TYPES
} from './bridge'

/**
 * Hook that bridges Zustand stores to the pixel office engine.
 *
 * @param engineRef - Ref to the pixel office engine instance (null when engine not ready)
 * @param engineReady - Whether the engine has finished initialising (triggers re-render for sync hooks)
 */
export function usePixelOfficeBridge(
  engineRef: RefObject<PixelOfficeEngine | null>,
  engineReady: boolean
): void {
  useAgentSync(engineRef, engineReady)
  useToolActivitySync(engineRef, engineReady)
}
