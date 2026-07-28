/**
 * grillMessageAdapter — converts grill agent messages to the Message shape
 * that MessageBubble expects, enabling reuse of the chat rendering pipeline.
 */

import type { Message, ToolActivity } from '../../../shared/types'

let counter = 0

export function grillAgentToMessage(
  content: string,
  toolActivities: ToolActivity[],
  index?: number | string
): Message {
  return {
    id: `grill-msg-${index ?? counter++}`,
    conversationId: 'grill-session',
    role: 'specialist',
    contentMd: content,
    attachmentsJson: '[]',
    createdAt: new Date().toISOString(),
    toolActivities
  }
}
