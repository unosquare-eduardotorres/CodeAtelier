import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import log from 'electron-log'
import { IPC_CHANNELS } from '../../shared/constants'

// SM-DEAD-CODE-01: The state machine only uses 'idle' and 'chat-agent-streaming'.
// All error/stop paths use conversationLifecycle.abort() → forceReset() which bypasses
// the transition table entirely. The 'error' and 'stopped' states are retained in the
// type for backward compatibility but are unreachable in production.
export type ConversationState = 'idle' | 'chat-agent-streaming' | 'error' | 'stopped'

export type ConversationTransition =
  | 'sendMessage'
  | 'chatAgentComplete'
  | 'messageFinalised'
  | 'streamError'
  | 'userStop'
  | 'cleanupComplete'
  | 'errorHandled'

const VALID_TRANSITIONS: Record<
  ConversationState,
  Partial<Record<ConversationTransition, ConversationState>>
> = {
  idle: {
    sendMessage: 'chat-agent-streaming'
  },
  'chat-agent-streaming': {
    chatAgentComplete: 'idle',
    messageFinalised: 'idle',
    // SM-DEAD-CODE-01: streamError and userStop transitions exist for completeness
    // but are unreachable — all abort paths use conversationLifecycle.abort() →
    // forceReset(), bypassing the transition table. If the state machine is
    // ever used directly (without lifecycle), these provide a valid path.
    streamError: 'error',
    userStop: 'stopped'
  },
  error: {
    errorHandled: 'idle',
    userStop: 'stopped'
  },
  stopped: {
    cleanupComplete: 'idle'
  }
}

export class ConversationStateMachine extends EventEmitter {
  /** Per-conversation state — absent means 'idle'. */
  private states = new Map<string, ConversationState>()
  private mainWindow: BrowserWindow | null = null

  constructor() {
    super()
    this.on('error', (err) => {
      log.error('[StateMachine:unhandled-error]', err)
    })
  }

  /** Set the main window for IPC state forwarding to the renderer */
  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win
  }

  /** Get state for a specific conversation. Defaults to 'idle' if not tracked. */
  getState(conversationId: string): ConversationState {
    return this.states.get(conversationId) ?? 'idle'
  }

  /**
   * @deprecated Use getState(conversationId) instead.
   * Returns the state of the first streaming conversation, or 'idle'.
   * Kept for backward compatibility during migration.
   */
  get currentState(): ConversationState {
    for (const state of this.states.values()) {
      if (state !== 'idle') return state
    }
    return 'idle'
  }

  /**
   * @deprecated Use activeStreamingIds() instead.
   * Returns the first streaming conversation ID.
   */
  get activeConversationId(): string | null {
    for (const [id, state] of this.states) {
      if (state !== 'idle') return id
    }
    return null
  }

  transition(event: ConversationTransition, conversationId?: string): boolean {
    const convId = conversationId ?? this.activeConversationId ?? '__unknown__'
    const currentState = this.getState(convId)

    // Idempotent transitions — if already idle, treat finalizing events as no-ops.
    // Prevents race conditions when multiple services finalize concurrently.
    const IDEMPOTENT_WHEN_IDLE: ConversationTransition[] = [
      'messageFinalised',
      'errorHandled',
      'cleanupComplete',
      'chatAgentComplete'
    ]
    if (currentState === 'idle' && IDEMPOTENT_WHEN_IDLE.includes(event)) {
      log.info(`[StateMachine] ${event} already idle for ${convId} — no-op`)
      return true
    }

    const nextState = VALID_TRANSITIONS[currentState]?.[event]
    if (!nextState) {
      log.warn(
        `[StateMachine] Invalid transition: ${currentState} + ${event} ` +
          `(conversation=${convId})`
      )
      return false
    }

    const prevState = currentState
    if (nextState === 'idle') {
      this.states.delete(convId)
    } else {
      this.states.set(convId, nextState)
    }

    log.info(`[StateMachine] ${prevState} → ${nextState} (event=${event} conversation=${convId})`)
    const statePayload = {
      from: prevState,
      to: nextState,
      event,
      conversationId: nextState === 'idle' ? null : convId
    }
    this.emit('stateChange', statePayload)

    // Forward state transitions to renderer for state mirror
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      try {
        this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_STATE_CHANGE, statePayload)
      } catch {
        // Window destroyed between check and send — harmless
      }
    }
    return true
  }

  /** Check if a specific conversation is idle (not streaming). */
  isIdle(conversationId?: string): boolean {
    if (conversationId) {
      return this.getState(conversationId) === 'idle'
    }
    // Global idle — no conversations are streaming
    return this.states.size === 0
  }

  /** Check if a specific conversation is streaming. */
  isStreaming(conversationId?: string): boolean {
    if (conversationId) {
      return this.getState(conversationId) === 'chat-agent-streaming'
    }
    // Global — any conversation is streaming
    for (const state of this.states.values()) {
      if (state === 'chat-agent-streaming') return true
    }
    return false
  }

  /** Get all conversation IDs currently in a streaming state. */
  activeStreamingIds(): string[] {
    const ids: string[] = []
    for (const [id, state] of this.states) {
      if (state === 'chat-agent-streaming') ids.push(id)
    }
    return ids
  }

  /**
   * Force reset a specific conversation to idle — emergency escape hatch.
   * If no conversationId provided, resets ALL conversations (backward compat).
   */
  forceReset(conversationId?: string): void {
    if (conversationId) {
      const prevState = this.getState(conversationId)
      log.warn(`[StateMachine] Force reset conversation=${conversationId} from ${prevState}`)
      this.states.delete(conversationId)
      const statePayload = {
        from: prevState,
        to: 'idle' as const,
        event: 'forceReset',
        conversationId: null
      }
      this.emit('stateChange', statePayload)

      // Forward force reset to renderer
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        try {
          this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_STATE_CHANGE, statePayload)
        } catch {
          // Window destroyed between check and send — harmless
        }
      }
    } else {
      // Global force reset — clear all states
      const prevIds = [...this.states.keys()]
      log.warn(`[StateMachine] Force reset ALL (${prevIds.length} conversations)`)
      this.states.clear()
      const statePayload = {
        from: 'unknown' as const,
        to: 'idle' as const,
        event: 'forceReset',
        conversationId: null
      }
      this.emit('stateChange', statePayload)

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        try {
          this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_STATE_CHANGE, statePayload)
        } catch {
          // Window destroyed between check and send — harmless
        }
      }
    }
  }
}

export const conversationStateMachine = new ConversationStateMachine()
