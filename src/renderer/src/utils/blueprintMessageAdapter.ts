/**
 * blueprintMessageAdapter — converts blueprint agent content to the Message
 * shape that MessageBubble expects, enabling reuse of the chat rendering
 * pipeline. Same pattern as grillMessageAdapter.ts.
 */

import type { Message, ToolActivity } from '../../../shared/types'

let counter = 0

export function blueprintAgentToMessage(
  content: string,
  toolActivities: ToolActivity[],
  index?: number | string
): Message {
  return {
    id: `blueprint-msg-${index ?? counter++}`,
    conversationId: 'blueprint-session',
    role: 'da-vinci',
    contentMd: content,
    attachmentsJson: '[]',
    createdAt: new Date().toISOString(),
    toolActivities
  }
}

/** Reset the counter (useful when switching blueprints). */
export function resetBlueprintMessageCounter(): void {
  counter = 0
}
