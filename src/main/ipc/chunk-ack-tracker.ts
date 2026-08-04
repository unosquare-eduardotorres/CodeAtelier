/**
 * ChunkAckTracker — adaptive interval tracker for IPC backpressure.
 *
 * Monitors how quickly the renderer processes IPC chunks by tracking
 * pending (sent but un-ACKed) chunk counts per conversation. When the
 * pending count exceeds HIGH_WATER_MARK, recommends a slower batch
 * interval to give the renderer breathing room.
 *
 * Used by TextDeltaBatcher via chunk-router to dynamically adjust the
 * IPC send cadence based on renderer feedback.
 */

import { chatIpcLogger } from '../logger'

export class ChunkAckTracker {
  private pendingCounts = new Map<string, number>()
  private lastAckTimestamps = new Map<string, number>()
  private isBackpressured = new Map<string, boolean>()

  // ── Backpressure metrics ──────────────────────────────────
  private _backpressureActivations = new Map<string, number>()
  private _ackLatencies = new Map<string, number[]>()
  private _maxPendingChunks = new Map<string, number>()

  /** Chunks pending before slowdown triggers (~5 frames at 60fps = ~80ms buffer) */
  static readonly HIGH_WATER_MARK = 15
  /** Chunks pending to return to normal speed */
  static readonly LOW_WATER_MARK = 5
  /** Normal batch interval (~30fps) */
  static readonly NORMAL_INTERVAL_MS = 33
  /** Slow batch interval (~10fps, backpressure active) */
  static readonly SLOW_INTERVAL_MS = 100

  /** Record that we sent a batch to the renderer. */
  recordSend(conversationId: string): void {
    const current = this.pendingCounts.get(conversationId) ?? 0
    const next = current + 1
    this.pendingCounts.set(conversationId, next)

    // Track peak pending count
    const maxPending = this._maxPendingChunks.get(conversationId) ?? 0
    if (next > maxPending) {
      this._maxPendingChunks.set(conversationId, next)
    }

    // Track backpressure activations
    if (next === ChunkAckTracker.HIGH_WATER_MARK) {
      const activations = this._backpressureActivations.get(conversationId) ?? 0
      this._backpressureActivations.set(conversationId, activations + 1)
      chatIpcLogger.debug(
        `[ChunkAckTracker] Backpressure activated: pending=${next} conv=${conversationId.slice(0, 8)}`
      )
    }
  }

  /** Record renderer ACK — reduces pending count. */
  recordAck(conversationId: string, batchSize: number): void {
    const pending = this.pendingCounts.get(conversationId) ?? 0
    this.pendingCounts.set(conversationId, Math.max(0, pending - batchSize))

    const now = Date.now()
    const lastAck = this.lastAckTimestamps.get(conversationId)
    this.lastAckTimestamps.set(conversationId, now)

    // Track ACK latency (time between consecutive ACKs)
    if (lastAck) {
      const latency = now - lastAck
      const latencies = this._ackLatencies.get(conversationId) ?? []
      latencies.push(latency)
      // Keep last 50 latencies
      if (latencies.length > 50) latencies.shift()
      this._ackLatencies.set(conversationId, latencies)
    }
  }

  /** Get recommended batch interval based on backpressure state with hysteresis. */
  getRecommendedInterval(conversationId: string): number {
    const pending = this.pendingCounts.get(conversationId) ?? 0
    const wasBackpressured = this.isBackpressured.get(conversationId) ?? false

    if (pending >= ChunkAckTracker.HIGH_WATER_MARK) {
      this.isBackpressured.set(conversationId, true)
      return ChunkAckTracker.SLOW_INTERVAL_MS
    }
    if (wasBackpressured && pending > ChunkAckTracker.LOW_WATER_MARK) {
      return ChunkAckTracker.SLOW_INTERVAL_MS  // Stay slow until below LWM
    }
    this.isBackpressured.set(conversationId, false)
    return ChunkAckTracker.NORMAL_INTERVAL_MS
  }

  /** Clean up tracking state for a completed conversation. */
  cleanup(conversationId: string): void {
    this.pendingCounts.delete(conversationId)
    this.lastAckTimestamps.delete(conversationId)
    this.isBackpressured.delete(conversationId)
  }

  /** Get metrics for a conversation's stream (for logging on stream complete). */
  getMetrics(conversationId: string): {
    backpressureActivations: number
    avgAckLatency: number | null
    maxPendingChunks: number
  } {
    const activations = this._backpressureActivations.get(conversationId) ?? 0
    const latencies = this._ackLatencies.get(conversationId) ?? []
    const avgAckLatency = latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : null
    const maxPending = this._maxPendingChunks.get(conversationId) ?? 0

    return { backpressureActivations: activations, avgAckLatency, maxPendingChunks: maxPending }
  }

  /** Clear metrics for a conversation (call after logging on stream complete). */
  clearMetrics(conversationId: string): void {
    this._backpressureActivations.delete(conversationId)
    this._ackLatencies.delete(conversationId)
    this._maxPendingChunks.delete(conversationId)
  }
}

/** Singleton instance shared by chunk-router and ACK handler. */
export const chunkAckTracker = new ChunkAckTracker()
