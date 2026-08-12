/**
 * stream-routing.ts — the pure routing rules behind useAppIpcListeners'
 * message-chunk and message-complete handlers.
 *
 * A chat streaming in workspace A must survive a switch to workspace B (the
 * backend keeps sending its chunks, exactly like a running blueprint). Both
 * rules below decide where a stream event lands once the conversation that owns
 * it is no longer the one on screen, so they are extracted from the hook to be
 * testable without a renderer.
 */

/** Whether a stream event belongs to the conversation currently on screen. */
export function isActiveConversationEvent(
  eventConversationId: string,
  activeConversationId: string | null | undefined
): boolean {
  return eventConversationId === activeConversationId
}

/**
 * BACKGROUND-CHAT-02: resolve the workspace that owns a completing stream.
 *
 * A background stream can complete long after the user switched workspaces, so
 * the active workspace is not a safe source of truth. Prefer the workspace the
 * backend stamped on the completion; fall back to the active one only when this
 * IS the active conversation. Returns undefined when neither applies — the
 * caller must then skip workspace-scoped work rather than guess.
 */
export function resolveCompletionWorkspace<W extends { id: string }>(
  completionWorkspaceId: string | undefined,
  isActive: boolean,
  workspaces: { all: W[]; active: W | null | undefined }
): W | undefined {
  if (completionWorkspaceId) {
    return workspaces.all.find((w) => w.id === completionWorkspaceId)
  }
  return isActive ? (workspaces.active ?? undefined) : undefined
}
