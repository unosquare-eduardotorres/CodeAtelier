/**
 * Whether a permission should ALSO be recorded inline in the transcript.
 *
 * The modal owns every decision — it queues, has no accidental-dismiss path and
 * cannot be scrolled past. The card is a receipt: an approval that fails to
 * resume the turn must leave a trace instead of looking like the agent went quiet.
 */
export function shouldRecordInline(
  p: { type: string; conversationId?: string },
  activeConversationId: string | null
): boolean {
  return (
    p.type === 'toolPermission' && !!p.conversationId && p.conversationId === activeConversationId
  )
}
