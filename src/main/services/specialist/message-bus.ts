/**
 * Lightweight message bus for inter-agent communication.
 *
 * Enables specialist-to-specialist data sharing without routing through
 * the generalist's context window. Supports point-to-point messaging,
 * broadcast, and read-state tracking per agent.
 *
 * This complements (not replaces) the existing TaskArtifactService
 * which handles file-based artifact persistence. The MessageBus is
 * for real-time, ephemeral communication during execution.
 *
 * Usage:
 *   const bus = new MessageBus()
 *
 *   // Specialist sends a message to another specialist
 *   bus.send({ from: 'architect', to: 'developer', type: 'context', content: 'Use React Query' })
 *
 *   // Specialist broadcasts to all
 *   bus.broadcast({ from: 'reviewer', type: 'finding', content: 'Missing error handling' })
 *
 *   // Specialist reads unread messages
 *   const messages = bus.getUnread('developer')
 *
 *   // Subscribe to live messages
 *   const unsub = bus.subscribe('developer', (msg) => console.log(msg))
 */

// ── Message Types ──

export type MessageType =
  | 'context' // Contextual info (e.g., architectural decisions)
  | 'finding' // Discovery or issue found during analysis
  | 'dependency' // Output data from a dependency task
  | 'feedback' // Review feedback or suggestions
  | 'status' // Status update (started, blocked, etc.)
  | 'artifact' // Reference to an artifact (file path, URL, etc.)
  | 'custom' // Extensible — any other communication

export interface AgentMessage {
  /** Auto-generated unique ID */
  id: string
  /** Agent ID of the sender */
  from: string
  /** Agent ID of the recipient (undefined for broadcasts) */
  to?: string
  /** Message classification */
  type: MessageType
  /** The message content (text, JSON stringified, etc.) */
  content: string
  /** ISO timestamp */
  timestamp: string
  /** Optional task ID for correlation */
  taskId?: string
  /** Optional metadata */
  metadata?: Record<string, unknown>
}

type MessageSubscriber = (message: AgentMessage) => void

/**
 * Persistence adapter interface — allows MessageBus to persist messages
 * without coupling to the DB layer directly.
 */
export interface MessagePersistenceAdapter {
  persist(message: AgentMessage, context: { conversationId?: string; runId?: string }): void
}

// ── MessageBus ──

let messageIdCounter = 0

export class MessageBus {
  /** All messages, in order */
  private messages: AgentMessage[] = []
  /** Read tracking per agent: agentId → set of read message IDs */
  private readState = new Map<string, Set<string>>()
  /** Live subscribers per agent */
  private subscribers = new Map<string, MessageSubscriber[]>()
  /** Global subscribers (receive ALL messages) */
  private globalSubscribers: MessageSubscriber[] = []
  /** Optional persistence adapter for durable message storage */
  private persistenceAdapter: MessagePersistenceAdapter | null = null
  /** Current execution context for persistence correlation */
  private persistenceContext: { conversationId?: string; runId?: string } = {}

  /**
   * Send a point-to-point message to a specific agent.
   * The message is stored and delivered to any active subscriber.
   */
  send(params: {
    from: string
    to: string
    type: MessageType
    content: string
    taskId?: string
    metadata?: Record<string, unknown>
  }): AgentMessage {
    const message: AgentMessage = {
      id: `msg-${++messageIdCounter}`,
      from: params.from,
      to: params.to,
      type: params.type,
      content: params.content,
      timestamp: new Date().toISOString(),
      taskId: params.taskId,
      metadata: params.metadata
    }

    this.messages.push(message)
    this.persistMessage(message)
    this.notifySubscribers(message)
    return message
  }

  /**
   * Broadcast a message to all agents.
   * No `to` field — visible to everyone.
   */
  broadcast(params: {
    from: string
    type: MessageType
    content: string
    taskId?: string
    metadata?: Record<string, unknown>
  }): AgentMessage {
    const message: AgentMessage = {
      id: `msg-${++messageIdCounter}`,
      from: params.from,
      type: params.type,
      content: params.content,
      timestamp: new Date().toISOString(),
      taskId: params.taskId,
      metadata: params.metadata
    }

    this.messages.push(message)
    this.persistMessage(message)
    this.notifySubscribers(message)
    return message
  }

  /**
   * Get all unread messages for an agent (both direct and broadcast).
   * Marks them as read.
   */
  getUnread(agentId: string): AgentMessage[] {
    const readSet = this.readState.get(agentId) ?? new Set()
    const unread = this.messages.filter(
      (msg) =>
        !readSet.has(msg.id) &&
        msg.from !== agentId && // Don't include own messages
        (msg.to === agentId || msg.to === undefined) // Direct or broadcast
    )

    // Mark as read
    for (const msg of unread) {
      readSet.add(msg.id)
    }
    this.readState.set(agentId, readSet)

    return unread
  }

  /**
   * Get the full conversation history between two agents.
   * Returns messages in chronological order.
   */
  getConversation(agent1: string, agent2: string): AgentMessage[] {
    return this.messages.filter(
      (msg) =>
        (msg.from === agent1 && msg.to === agent2) || (msg.from === agent2 && msg.to === agent1)
    )
  }

  /**
   * Subscribe to messages for a specific agent (direct + broadcast).
   * Returns an unsubscribe function.
   */
  subscribe(agentId: string, callback: MessageSubscriber): () => void {
    const subs = this.subscribers.get(agentId) ?? []
    subs.push(callback)
    this.subscribers.set(agentId, subs)

    return (): void => {
      const arr = this.subscribers.get(agentId)
      if (arr) {
        const idx = arr.indexOf(callback)
        if (idx >= 0) arr.splice(idx, 1)
      }
    }
  }

  /**
   * Subscribe to ALL messages (for logging, tracing, etc.).
   * Returns an unsubscribe function.
   */
  subscribeAll(callback: MessageSubscriber): () => void {
    this.globalSubscribers.push(callback)
    return (): void => {
      const idx = this.globalSubscribers.indexOf(callback)
      if (idx >= 0) this.globalSubscribers.splice(idx, 1)
    }
  }

  /**
   * Enable durable persistence for all messages.
   * Messages are written to the adapter synchronously on send/broadcast.
   * Call once at startup with a DB-backed adapter.
   */
  enablePersistence(adapter: MessagePersistenceAdapter): void {
    this.persistenceAdapter = adapter
  }

  /**
   * Set the current execution context for persistence correlation.
   * Call before each execution run.
   */
  setPersistenceContext(context: { conversationId?: string; runId?: string }): void {
    this.persistenceContext = context
  }

  /** Reset all state (between execution runs). */
  reset(): void {
    this.messages.length = 0
    this.readState.clear()
    this.persistenceContext = {}
    // Keep subscribers — they're registered at setup time
    messageIdCounter = 0
  }

  /** Full reset including subscribers (for testing). */
  destroy(): void {
    this.reset()
    this.subscribers.clear()
    this.globalSubscribers.length = 0
  }

  /** Persist a message via the adapter (if enabled). Errors are swallowed to avoid crashing the bus. */
  private persistMessage(message: AgentMessage): void {
    if (!this.persistenceAdapter) return
    try {
      this.persistenceAdapter.persist(message, this.persistenceContext)
    } catch {
      /* never crash the bus — persistence is best-effort */
    }
  }

  private notifySubscribers(message: AgentMessage): void {
    // Global subscribers
    for (const cb of this.globalSubscribers) {
      try {
        cb(message)
      } catch {
        /* never crash the bus */
      }
    }

    // Direct recipient subscribers
    if (message.to) {
      const subs = this.subscribers.get(message.to)
      if (subs) {
        for (const cb of subs) {
          try {
            cb(message)
          } catch {
            /* never crash the bus */
          }
        }
      }
    } else {
      // Broadcast — notify all subscribers except the sender
      for (const [agentId, subs] of this.subscribers) {
        if (agentId === message.from) continue
        for (const cb of subs) {
          try {
            cb(message)
          } catch {
            /* never crash the bus */
          }
        }
      }
    }
  }
}

/** Singleton message bus for the specialist pipeline */
export const messageBus = new MessageBus()
