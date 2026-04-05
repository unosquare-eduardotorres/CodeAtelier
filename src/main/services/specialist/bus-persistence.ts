/**
 * Bridges the in-memory MessageBus to persistent DB storage.
 *
 * Call once at app startup. After this, every send() and broadcast()
 * on the MessageBus is automatically persisted to the agent_messages table.
 * Persistence is best-effort — DB errors are swallowed to never crash the bus.
 */
import { messageBus } from './message-bus'
import type { AgentMessage, MessagePersistenceAdapter } from './message-bus'
import { agentMessageRepository } from '../../db/repositories/agent-message.repository'

/**
 * DB-backed persistence adapter for the MessageBus.
 * Writes each message to the agent_messages table immediately.
 */
class DbMessagePersistenceAdapter implements MessagePersistenceAdapter {
  persist(message: AgentMessage, context: { conversationId?: string; runId?: string }): void {
    agentMessageRepository.create(message, {
      conversationId: context.conversationId,
      runId: context.runId
    })
  }
}

/**
 * Wire MessageBus persistence to the DB.
 * Call once at startup — no cleanup needed (adapter is lightweight).
 */
export function bridgeBusToPersistence(): void {
  messageBus.enablePersistence(new DbMessagePersistenceAdapter())
}
