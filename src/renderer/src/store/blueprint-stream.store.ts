/**
 * Blueprint stream store — accumulates streaming content from the blueprint
 * pipeline phases, splitting text into segments at heading/tool boundaries.
 *
 * Thin instance of the shared `createStreamingStore` factory (same pattern as
 * grill-stream.store.ts). Only clears via explicit `reset()` — called when a
 * new phase starts or the pipeline completes.
 */

import { createStreamingStore, getFlatContent, getFlatToolActivities } from './createStreamingStore'
import type { StreamSegment } from '@renderer/utils/stream-segment-accumulator'

// Re-export shared helpers + segment type for existing consumers.
export type BlueprintStreamSegment = StreamSegment
export { getFlatContent, getFlatToolActivities }

export const useBlueprintStreamStore = createStreamingStore()
