/**
 * Registry of in-flight `ask_user` requests for the control-actions MCP server.
 *
 * Each `ask_user` tool call blocks the agent turn on a promise until the user
 * answers. This registry tracks those pending resolvers so:
 *   - a matching `askUserResponse` from Electron resolves the right promise, and
 *   - a socket teardown (close/error) resolves EVERY pending promise so the turn
 *     unwinds cleanly instead of hanging forever (no auto-timeout exists).
 *
 * Extracted from control-actions-server.ts purely so the logic is unit-testable
 * without executing the server's `main()` bootstrap on import.
 */
export interface AskUserRegistry {
  /** Register a pending request; `resolve` fires when the user answers. */
  register(requestId: string, resolve: (response: string) => void): void
  /** Resolve a single pending request by id. Returns true if one was waiting. */
  resolve(requestId: string, response: string): boolean
  /** Resolve every pending request with `message`, then clear the registry. */
  resolveAll(message: string): void
  /** Number of currently-pending requests (diagnostics / tests). */
  readonly size: number
}

export function createAskUserRegistry(): AskUserRegistry {
  const pending = new Map<string, (response: string) => void>()

  return {
    register(requestId, resolve) {
      pending.set(requestId, resolve)
    },
    resolve(requestId, response) {
      const resolver = pending.get(requestId)
      if (!resolver) return false
      resolver(response)
      pending.delete(requestId)
      return true
    },
    resolveAll(message) {
      for (const resolve of pending.values()) {
        resolve(message)
      }
      pending.clear()
    },
    get size() {
      return pending.size
    }
  }
}
