/**
 * Blueprint stream store — accumulates streaming content from the blueprint
 * pipeline phases, splitting text into segments at heading/tool boundaries.
 *
 * Thin instance of the shared `createStreamingStore` factory (same pattern as
 * grill-stream.store.ts). Only clears via explicit `reset()` — called when a
 * new phase starts or the pipeline completes.
 *
 * Lane stores: during parallel build, each task gets its own streaming store
 * keyed by taskId. Non-build phases use the un-keyed `useBlueprintStreamStore`.
 */

import { create } from 'zustand'
import {
  createStreamingStore,
  getFlatContent,
  getFlatToolActivities,
  type StreamingStoreState
} from './createStreamingStore'
import type { StreamSegment } from '@renderer/utils/stream-segment-accumulator'
import type { StoreApi, UseBoundStore } from 'zustand'

// Re-export shared helpers + segment type for existing consumers.
export type BlueprintStreamSegment = StreamSegment
export { getFlatContent, getFlatToolActivities }

/** Un-keyed store for non-build phases (specify, clarify, plan, tasks, review, verify). */
export const useBlueprintStreamStore = createStreamingStore()

// ── Keyed Lane Stores (Build Phase Parallel Tasks) ──

interface BlueprintLaneStoreState {
  /** Per-task streaming stores keyed by taskId. */
  lanes: Record<string, UseBoundStore<StoreApi<StreamingStoreState>>>
  /** Get or create a lane store for a task. */
  getOrCreateLane: (taskId: string) => UseBoundStore<StoreApi<StreamingStoreState>>
  /** Remove a lane store. */
  removeLane: (taskId: string) => void
  /** Reset all lanes (e.g. on wave start). */
  resetAll: () => void
}

export const useBlueprintLaneStore = create<BlueprintLaneStoreState>((set, get) => ({
  lanes: {},

  getOrCreateLane: (taskId: string) => {
    const existing = get().lanes[taskId]
    if (existing) return existing
    const lane = createStreamingStore()
    set((state) => ({ lanes: { ...state.lanes, [taskId]: lane } }))
    return lane
  },

  removeLane: (taskId: string) => {
    const lane = get().lanes[taskId]
    if (lane) {
      lane.getState().reset()
      set((state) => {
        const next = { ...state.lanes }
        delete next[taskId]
        return { lanes: next }
      })
    }
  },

  resetAll: () => {
    for (const lane of Object.values(get().lanes)) {
      lane.getState().reset()
    }
    set({ lanes: {} })
  }
}))
