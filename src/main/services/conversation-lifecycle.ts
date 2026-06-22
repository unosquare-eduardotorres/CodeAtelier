import log from 'electron-log'
import { conversationStateMachine } from './conversation-state-machine'

/**
 * Centralized lifecycle manager for conversation request/response cycles.
 *
 * Owns the full lifecycle from message send through pipeline completion,
 * providing a single abort() that cascades through all layers. This eliminates
 * the scattered cleanup problem where 7+ services must independently clean up
 * on stop/error — any miss previously resulted in leaked state.
 *
 * Usage:
 *   const signal = conversationLifecycle.begin(conversationId)
 *   conversationLifecycle.onDispose(() => { cleanupFn() })
 *   // ... when done:
 *   conversationLifecycle.complete()
 *   // ... or on error/stop:
 *   conversationLifecycle.abort('userStop')
 */
export class ConversationLifecycle {
  private abortController: AbortController | null = null
  private disposers: Array<() => void> = []
  private _requestId: string | null = null
  private _conversationId: string | null = null
  private isDisposing = false

  /** Current request ID for this lifecycle (null when idle) */
  get requestId(): string | null {
    return this._requestId
  }

  /** Current conversation ID for this lifecycle (null when idle) */
  get conversationId(): string | null {
    return this._conversationId
  }

  /** AbortSignal for cooperative cancellation (null when idle) */
  get signal(): AbortSignal | null {
    return this.abortController?.signal ?? null
  }

  /** Whether a lifecycle is currently active */
  get isActive(): boolean {
    return this.abortController !== null
  }

  /**
   * Start a new lifecycle. Auto-aborts previous lifecycle if still active.
   * Returns AbortSignal for all sub-operations to use for cooperative cancellation.
   */
  begin(conversationId: string): AbortSignal {
    // Auto-abort previous lifecycle if still active
    if (this.abortController) {
      log.warn(
        `[ConversationLifecycle] Auto-aborting previous lifecycle (conversation=${this._conversationId}) — superseded by ${conversationId}`
      )
      this.abort('superseded')
    }

    this.abortController = new AbortController()
    this._requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    this._conversationId = conversationId

    log.info(
      `[ConversationLifecycle] Begin: conversation=${conversationId} requestId=${this._requestId}`
    )
    return this.abortController.signal
  }

  /**
   * Register a cleanup function that will run on abort/complete.
   * Disposers run in registration order. Each is wrapped in try/catch
   * so one failing disposer doesn't prevent others from running.
   */
  onDispose(fn: () => void): void {
    this.disposers.push(fn)
  }

  /**
   * Clean shutdown — runs all disposers in order, then resets state.
   * Call when the full pipeline (generalist + specialists) completes successfully.
   */
  complete(): void {
    log.info(
      `[ConversationLifecycle] Complete: conversation=${this._conversationId} requestId=${this._requestId}`
    )
    this.runDisposers()
    this.abortController = null
    this._requestId = null
    this._conversationId = null
  }

  /**
   * Hard abort — aborts the signal, runs all disposers, and force-resets the state machine.
   * Call on user stop, errors, or when a new message supersedes the current one.
   */
  abort(reason?: string): void {
    log.warn(
      `[ConversationLifecycle] Abort: reason=${reason ?? 'unknown'} conversation=${this._conversationId} requestId=${this._requestId}`
    )
    if (this.abortController) {
      this.abortController.abort(reason)
    }
    this.runDisposers()
    this.abortController = null
    this._requestId = null
    this._conversationId = null
    conversationStateMachine.forceReset()
  }

  private runDisposers(): void {
    if (this.isDisposing) return // Prevent re-entrance from disposers calling abort()/complete()
    this.isDisposing = true

    const snapshot = this.disposers // Snapshot the array
    this.disposers = []              // Clear BEFORE iteration

    for (const fn of snapshot) {
      try {
        fn()
      } catch (e) {
        log.warn('[ConversationLifecycle] Disposer error:', e)
      }
    }

    this.isDisposing = false
    if (snapshot.length > 0) {
      log.info(`[ConversationLifecycle] Ran ${snapshot.length} disposer(s)`)
    }
  }
}

export const conversationLifecycle = new ConversationLifecycle()
