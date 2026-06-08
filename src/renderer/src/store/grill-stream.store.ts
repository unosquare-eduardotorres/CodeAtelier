/**
 * Grill stream store — accumulates streaming content from the dedicated
 * GrillAgentService, splitting text into segments at tool-activity boundaries.
 *
 * This is now a thin instance of the shared `createStreamingStore` factory so
 * grill, chat, and council all share one accumulator wrapper. Only clears via
 * explicit `reset()` (called when the evaluation result is captured or a new
 * evaluation starts).
 */

import { createStreamingStore, getFlatContent, getFlatToolActivities } from './createStreamingStore'
import type { StreamSegment } from '@renderer/utils/stream-segment-accumulator'

// Re-export shared helpers + segment type for existing consumers.
export type GrillStreamSegment = StreamSegment
export { getFlatContent, getFlatToolActivities }

export const useGrillStreamStore = createStreamingStore()
