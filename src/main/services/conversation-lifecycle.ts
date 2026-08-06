import log from 'electron-log'
import { conversationStateMachine } from './conversation-state-machine'

/**
 * Per-stream lifecycle manager for conversation request/response cycles.
 *
 * Each instance owns one stream's full lifecycle from message send through
 * pipeline completion, providing a single abort() that cascades through all
 * layers. This eliminates the scattered cleanup problem where 7+ services
 * must independently clean up on stop/error — any miss previously resulted
 * in leaked state.
 *
 * Usage:
 *   const lifecycle = lifecycleRegistry.begin(conversationId)
 *   lifecycle.onDispose(() => { cleanupFn() })
 *   // ... when done:
 *   lifecycle.complete()
 *   // ... or on error/stop:
 *   lifecycle.abort('userStop')
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
   * Call when the full streaming pipeline completes successfully.
   */
  complete(): void {
    log.info(
      `[ConversationLifecycle] Complete: conversation=${this._conversationId} requestId=${this._requestId}`
    )
    // LIFECYCLE-BEGIN-FROM-DISPOSER-01: Snapshot current controller before
    // disposers run. If a disposer calls begin(), the controller changes.
    // Only null-out if the controller is still the one we started with.
    const controllerBeforeDispose = this.abortController
    this.runDisposers()
    if (this.abortController === controllerBeforeDispose) {
      this.abortController = null
      this._requestId = null
      this._conversationId = null
    }
    // else: a disposer called begin() — new lifecycle owns state now
  }

  /**
   * Hard abort — aborts the signal, runs all disposers, and force-resets the state machine.
   * Call on user stop, errors, or when a new message supersedes the current one.
   */
  abort(reason?: string): void {
    log.warn(
      `[ConversationLifecycle] Abort: reason=${reason ?? 'unknown'} conversation=${this._conversationId} requestId=${this._requestId}`
    )
    const convId = this._conversationId
    // LIFECYCLE-BEGIN-FROM-DISPOSER-01: Snapshot controller before disposers.
    const controllerBeforeDispose = this.abortController
    if (controllerBeforeDispose) {
      controllerBeforeDispose.abort(reason)
    }
    this.runDisposers()
    if (this.abortController === controllerBeforeDispose) {
      this.abortController = null
      this._requestId = null
      this._conversationId = null
    }
    // else: a disposer called begin() — new lifecycle owns state now

    // LIFECYCLE-ABORT-IDLE-FORCERESET-01: Only force-reset the state machine
    // if we actually had an active lifecycle to abort. If controllerBeforeDispose
    // is null, this was an idle abort — force-resetting could clobber a new
    // stream's state machine transition that just started.
    if (controllerBeforeDispose && convId) {
      conversationStateMachine.forceReset(convId)
    }
  }

  private runDisposers(): void {
    if (this.isDisposing) return // Prevent re-entrance from disposers calling abort()/complete()
    this.isDisposing = true

    const snapshot = this.disposers // Snapshot the array
    this.disposers = [] // Clear BEFORE iteration

    for (const fn of snapshot) {
      try {
        fn()
      } catch (e) {
        log.warn('[ConversationLifecycle] Disposer error:', e)
      }
    }

    // LIFECYCLE-DISPOSER-REGISTERED-DURING-DISPOSAL-01: Drain any disposers
    // added by disposers that just ran. One pass is sufficient since
    // isDisposing prevents recursive runDisposers() from executing.
    while (this.disposers.length > 0) {
      const extra = this.disposers
      this.disposers = []
      for (const fn of extra) {
        try {
          fn()
        } catch (e) {
          log.warn('[ConversationLifecycle] Late-registered disposer error:', e)
        }
      }
    }

    this.isDisposing = false
    if (snapshot.length > 0) {
      log.info(`[ConversationLifecycle] Ran ${snapshot.length} disposer(s)`)
    }
  }
}

// ── Stream Info ──

export interface StreamInfo {
  conversationId: string
  requestId: string
  state: 'streaming'
}

// ── Lifecycle Registry ──

/**
 * Registry of per-conversation lifecycle instances.
 *
 * Replaces the old singleton `conversationLifecycle` to enable concurrent
 * multi-chat streaming. Each conversation gets its own `ConversationLifecycle`
 * instance with independent AbortController, disposers, and request ID.
 *
 * API:
 *   lifecycleRegistry.begin(convId) → lifecycle instance
 *   lifecycleRegistry.get(convId) → lifecycle | undefined
 *   lifecycleRegistry.abort(convId, reason) → void
 *   lifecycleRegistry.abortAll(reason) → void
 *   lifecycleRegistry.active() → StreamInfo[]
 */
export class LifecycleRegistry {
  private readonly lifecycles = new Map<string, ConversationLifecycle>()

  /**
   * Start a new lifecycle for a conversation. If one already exists for this
   * conversation, auto-aborts it first (same-conversation supersede).
   * Returns the lifecycle instance (caller accesses signal, requestId, etc.).
   */
  begin(conversationId: string): ConversationLifecycle {
    // Auto-abort existing lifecycle for same conversation (supersede)
    const existing = this.lifecycles.get(conversationId)
    if (existing?.isActive) {
      log.warn(
        `[LifecycleRegistry] Superseding existing lifecycle for conversation=${conversationId}`
      )
      existing.abort('superseded')
      this.lifecycles.delete(conversationId)
    }

    const lifecycle = new ConversationLifecycle()
    lifecycle.begin(conversationId)

    // Auto-remove from registry when lifecycle completes or is aborted.
    // A4-FIX: Check both the removed flag AND that the map entry is still
    // this lifecycle instance. If begin(sameConvId) was called from a
    // disposer, the map entry is a fresh lifecycle — don't delete it.
    let removed = false
    lifecycle.onDispose(() => {
      if (!removed && this.lifecycles.get(conversationId) === lifecycle) {
        removed = true
        this.lifecycles.delete(conversationId)
      }
    })

    this.lifecycles.set(conversationId, lifecycle)
    return lifecycle
  }

  /** Get the active lifecycle for a conversation, if any. */
  get(conversationId: string): ConversationLifecycle | undefined {
    const lc = this.lifecycles.get(conversationId)
    // Clean up stale entries — lifecycle completed but disposer didn't fire
    if (lc && !lc.isActive) {
      this.lifecycles.delete(conversationId)
      return undefined
    }
    return lc
  }

  /** Abort a specific conversation's lifecycle. No-op if not active. */
  abort(conversationId: string, reason?: string): void {
    const lc = this.lifecycles.get(conversationId)
    if (lc?.isActive) {
      lc.abort(reason)
    }
    // A4-FIX: Only delete if the map entry is still the same instance.
    // A disposer inside lc.abort() may call registry.begin(sameConvId),
    // replacing the map entry with a fresh lifecycle. Unconditionally
    // deleting here would orphan that new lifecycle.
    if (this.lifecycles.get(conversationId) === lc) {
      this.lifecycles.delete(conversationId)
    }
  }

  /** Abort all active lifecycles. Used on workspace switch / force reset. */
  abortAll(reason?: string): void {
    // Snapshot keys — abort() modifies the map via disposers
    const keys = [...this.lifecycles.keys()]
    for (const convId of keys) {
      this.abort(convId, reason)
    }
  }

  /** List all active streams. */
  active(): StreamInfo[] {
    const result: StreamInfo[] = []
    for (const [conversationId, lc] of this.lifecycles) {
      if (lc.isActive && lc.requestId) {
        result.push({
          conversationId,
          requestId: lc.requestId,
          state: 'streaming'
        })
      }
    }
    return result
  }

  /** Check if a specific conversation is currently streaming. */
  isStreaming(conversationId: string): boolean {
    return this.get(conversationId)?.isActive === true
  }

  /** Number of active streams. */
  get size(): number {
    // Clean stale entries during count
    for (const [k, lc] of this.lifecycles) {
      if (!lc.isActive) this.lifecycles.delete(k)
    }
    return this.lifecycles.size
  }
}

export const lifecycleRegistry = new LifecycleRegistry()

// A12-FIX: Removed deprecated `conversationLifecycle` singleton export.
// It was a detached ConversationLifecycle instance that silently no-oped
// for any code importing it — only the rewritten tests referenced it
// (in a catch comment). All live code uses `lifecycleRegistry`.
