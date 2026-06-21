/**
 * Shared helper for per-workspace listener cleanup with timer-based safety net.
 *
 * Prevents listener accumulation if a service crashes before emitting its
 * completion event. Each service wires listeners through this helper, which
 * tracks them per-workspace and auto-cleans after a configurable timeout.
 *
 * Usage:
 *   const cleanup = createTimedCleanupMap('audit')
 *   const cleanups = cleanup.prepareCleanups(workspaceId)
 *   cleanup.addListener(cleanups, emitter, 'event', handler)
 *   cleanup.scheduleAutoCleanup(workspaceId, cleanups, 90 * 60_000)
 */

import log from 'electron-log'

const cleanupLog = log.scope('listener-cleanup')

type EventEmitterLike = {
  on: (event: string, handler: (...args: unknown[]) => void) => void
  off: (event: string, handler: (...args: unknown[]) => void) => void
}

export interface TimedCleanupMap {
  /** Prepare cleanups for a workspace — clears stale listeners first. */
  prepareCleanups: (workspaceId: string) => Array<() => void>
  /** Register a listener with auto-tracked cleanup. */
  addListener: <T>(
    cleanups: Array<() => void>,
    emitter: EventEmitterLike,
    event: string,
    handler: (data: T) => void
  ) => void
  /** Schedule auto-cleanup if completion event doesn't fire within timeout. */
  scheduleAutoCleanup: (workspaceId: string, cleanups: Array<() => void>, timeoutMs: number) => void
  /** Run cleanup immediately (called on completion). */
  runCleanup: (workspaceId: string) => void
}

export function createTimedCleanupMap(label: string): TimedCleanupMap {
  const map = new Map<string, Array<() => void>>()

  return {
    prepareCleanups(workspaceId: string): Array<() => void> {
      const existing = map.get(workspaceId)
      if (existing) {
        for (const cleanup of existing) cleanup()
        cleanupLog.info(
          `[${label}:cleanup] Cleared ${existing.length} stale listeners for ${workspaceId}`
        )
      }
      const cleanups: Array<() => void> = []
      map.set(workspaceId, cleanups)
      return cleanups
    },

    addListener<T>(
      cleanups: Array<() => void>,
      emitter: EventEmitterLike,
      event: string,
      handler: (data: T) => void
    ): void {
      // LISTENER-CLEANUP-NOISOL-01: Wrap handlers in try-catch to prevent
      // listener errors from propagating through EventEmitter.emit() and
      // crashing the entire emit chain for all listeners on that event.
      const wrappedHandler = (...args: unknown[]): void => {
        try {
          ;(handler as (...a: unknown[]) => void)(...args)
        } catch (err) {
          cleanupLog.error(`[${label}:listener] Handler for '${String(event)}' threw:`, err)
        }
      }
      emitter.on(event, wrappedHandler)
      cleanups.push(() => emitter.off(event, wrappedHandler))
    },

    scheduleAutoCleanup(workspaceId: string, cleanups: Array<() => void>, timeoutMs: number): void {
      const timeoutId = setTimeout(() => {
        if (map.has(workspaceId)) {
          cleanupLog.warn(
            `[${label}:auto-cleanup] Timer fired for ${workspaceId} — cleaning ${cleanups.length} listeners`
          )
          for (const cleanup of cleanups) cleanup()
          map.delete(workspaceId)
        }
      }, timeoutMs)
      // Clear the timer when manual cleanup runs
      cleanups.push(() => clearTimeout(timeoutId))
    },

    runCleanup(workspaceId: string): void {
      const cleanups = map.get(workspaceId)
      if (cleanups) {
        for (const cleanup of cleanups) cleanup()
        map.delete(workspaceId)
      }
    }
  }
}
