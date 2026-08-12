/**
 * Mode-change broadcast resolution for the control-actions MCP server.
 *
 * The server's conversation mode is frozen at spawn time (CONVERSATION_MODE env
 * var), but the CLI child that owns it outlives a Plan → Build switch. The main
 * process pushes a `modeChange` message over the IPC bridge to correct that;
 * this module decides what such a message should do.
 *
 * Extracted as a pure function — mirroring tool-auto-approve.ts — so the guard
 * rules are testable without a socket.
 */

export type ServerMode = 'plan' | 'build' | 'danger'

const VALID: readonly string[] = ['plan', 'build', 'danger']

/**
 * The mode a `modeChange` broadcast should leave this server in.
 *
 * Returns `currentMode` untouched when the message is malformed or addressed to
 * a different conversation — one bridge serves every conversation in a
 * workspace, so cross-applying would hand one chat another chat's permissions.
 */
export function resolveBroadcastMode(
  event: { type?: unknown; payload?: unknown },
  ownConversationId: string | undefined,
  currentMode: string
): string {
  if (event.type !== 'modeChange') return currentMode

  const payload = event.payload as Record<string, unknown> | undefined | null
  if (!payload || typeof payload !== 'object') return currentMode

  const mode = payload.mode
  if (typeof mode !== 'string' || !VALID.includes(mode)) return currentMode

  // One bridge, many conversations: only apply a broadcast addressed to this
  // server's own conversation. Both sides missing an id counts as a match —
  // sessions without a conversation id still need to track the switch.
  const targetConversationId = payload.conversationId
  const target = typeof targetConversationId === 'string' ? targetConversationId : undefined
  if (target !== ownConversationId) return currentMode

  return mode
}
