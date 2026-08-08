/**
 * Where a permission request should surface.
 *
 * A tool permission for the conversation the user is looking at belongs in the
 * transcript — a toast that vanishes leaves no evidence when an approval fails
 * to resume the turn. Everything else is a cross-workspace interrupt: toast.
 */
export function routePermission(
  p: { type: string; conversationId?: string },
  activeConversationId: string | null
): 'inline' | 'toast' {
  if (p.type !== 'toolPermission') return 'toast'
  // No conversation to anchor the card to — fall back to the toast rather than
  // dropping the prompt on the floor.
  if (!p.conversationId || p.conversationId !== activeConversationId) return 'toast'
  return 'inline'
}
