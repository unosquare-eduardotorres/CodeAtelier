/**
 * ChunkConsumer — frame-aligned batch consumer for IPC streaming chunks.
 *
 * Instead of processing each IPC message immediately (which can queue
 * React renders faster than 60fps), incoming chunks are buffered and
 * processed in `requestAnimationFrame` batches:
 *
 *  IPC arrives → push() → queue grows → rAF fires → flush() → process N chunks
 *                                                            → send ACK
 *
 * This guarantees at most one store update + React render per animation frame,
 * regardless of how fast the backend sends chunks. The ACK sent after each
 * frame's batch feeds the backend's adaptive batcher (IPC backpressure).
 */

export interface ChunkData {
  conversationId: string
  chunk?: string
  role?: string
  taskId?: string
  specialist?: string
  requestId?: string
  toolActivity?: unknown
  keepalive?: boolean
  turnBoundary?: boolean
  turnId?: string
  compactNeeded?: unknown
  budgetCapReached?: unknown
  todoUpdate?: unknown
  todoSync?: unknown
  phaseProgress?: unknown
  turnLimit?: unknown
  contextUsageUpdate?: unknown
}

export class ChunkConsumer {
  private queue: ChunkData[] = []
  private rafId: number | null = null
  private processCallback: (chunks: ChunkData[]) => void

  constructor(processCallback: (chunks: ChunkData[]) => void) {
    this.processCallback = processCallback
  }

  /** Queue a chunk for processing on the next animation frame. */
  push(chunk: ChunkData): void {
    this.queue.push(chunk)
    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(() => this.flush())
    }
  }

  /** Process all queued chunks and send ACK. */
  private flush(): void {
    this.rafId = null
    if (this.queue.length === 0) return
    const batch = this.queue.splice(0) // drain
    this.processCallback(batch)
    // Send ACK with batch size + per-conversation counts for targeted backpressure
    if (typeof window !== 'undefined' && window.api?.chunkAck) {
      const perConv: Record<string, number> = {}
      for (const chunk of batch) {
        perConv[chunk.conversationId] = (perConv[chunk.conversationId] ?? 0) + 1
      }
      window.api.chunkAck({
        processed: batch.length,
        timestamp: performance.now(),
        perConversation: perConv
      })
    }
  }

  /** Clean up: cancel pending rAF and clear queue. */
  destroy(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.queue = []
  }
}
