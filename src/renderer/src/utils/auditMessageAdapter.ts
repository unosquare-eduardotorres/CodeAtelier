/**
 * auditMessageAdapter — converts audit stream segments to the Message shape
 * that MessageBubble expects, enabling reuse of the chat rendering pipeline.
 *
 * Mirrors grillMessageAdapter so the audit stream gets the same natural,
 * chat-like rendering instead of the bespoke per-segment bubble.
 */

import type { Message, ToolActivity } from '../../../shared/types'

let counter = 0

export function auditSegmentToMessage(
  content: string,
  toolActivities: ToolActivity[],
  index?: number
): Message {
  return {
    id: `audit-msg-${index ?? counter++}`,
    conversationId: 'audit-session',
    role: 'specialist',
    contentMd: content,
    attachmentsJson: '[]',
    createdAt: new Date().toISOString(),
    toolActivities
  }
}
