import log from 'electron-log'

interface PendingElicitation {
  resolve: (result: {
    action: 'accept' | 'decline' | 'cancel'
    content?: Record<string, unknown>
  }) => void
  serverName: string
  mode?: string
}

export class ElicitationService {
  private pendingElicitations = new Map<string, PendingElicitation>()

  /** Register a pending elicitation; `resolve` fires when the user responds. */
  register(
    requestId: string,
    resolve: PendingElicitation['resolve'],
    serverName: string,
    mode?: string
  ): void {
    this.pendingElicitations.set(requestId, { resolve, serverName, mode })
    log.debug(`[ElicitationService] Registered elicitation requestId=${requestId} server=${serverName}`)
  }

  resolveElicitation(
    requestId: string,
    result: {
      action: 'accept' | 'decline' | 'cancel'
      content?: Record<string, unknown>
    }
  ): void {
    const pending = this.pendingElicitations.get(requestId)
    if (!pending) {
      log.debug(`[ElicitationService] resolveElicitation called for unknown requestId=${requestId}`)
      return
    }
    this.pendingElicitations.delete(requestId)
    log.debug(`[ElicitationService] Resolved elicitation requestId=${requestId}`)
    pending.resolve(result)
  }

  /**
   * ELICIT-NOCLEANUP-01: Resolve all pending elicitations with 'cancel' action.
   * Called on session stop to prevent promise leaks (analogous to AskUserRegistry.resolveAll).
   */
  resolveAll(): void {
    if (this.pendingElicitations.size === 0) return
    log.debug(`[ElicitationService] resolveAll — cancelling ${this.pendingElicitations.size} pending elicitation(s)`)
    for (const pending of this.pendingElicitations.values()) {
      pending.resolve({ action: 'cancel' })
    }
    this.pendingElicitations.clear()
  }

  /** Number of currently-pending elicitations (diagnostics / tests). */
  get size(): number {
    return this.pendingElicitations.size
  }
}

export const elicitationService = new ElicitationService()
