import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import log from 'electron-log'
import { IPC_CHANNELS } from '../../shared/constants'
import { safeWindowSend } from '../ipc/safe-send'

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
    streamError: 'error',
    userStop: 'stopped'
  },
  error: {
    errorHandled: 'idle'
  },
  stopped: {
    cleanupComplete: 'idle'
  }
}

export class ConversationStateMachine extends EventEmitter {
  private state: ConversationState = 'idle'
  private conversationId: string | null = null
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

  get currentState(): ConversationState {
    return this.state
  }
  get activeConversationId(): string | null {
    return this.conversationId
  }

  transition(event: ConversationTransition, conversationId?: string): boolean {
    // Idempotent transitions — if already idle, treat finalizing events as no-ops.
    // Prevents race conditions when multiple services finalize concurrently.
    const IDEMPOTENT_WHEN_IDLE: ConversationTransition[] = [
      'messageFinalised',
      'errorHandled',
      'cleanupComplete',
      'chatAgentComplete'
    ]
    if (this.state === 'idle' && IDEMPOTENT_WHEN_IDLE.includes(event)) {
      log.info(`[StateMachine] ${event} already idle — no-op`)
      return true
    }

    const nextState = VALID_TRANSITIONS[this.state]?.[event]
    if (!nextState) {
      log.warn(
        `[StateMachine] Invalid transition: ${this.state} + ${event} ` +
          `(conversation=${this.conversationId})`
      )
      return false
    }

    const prevState = this.state
    this.state = nextState
    if (conversationId) this.conversationId = conversationId
    if (nextState === 'idle') this.conversationId = null

    log.info(`[StateMachine] ${prevState} → ${nextState} (event=${event})`)
    const statePayload = {
      from: prevState,
      to: nextState,
      event,
      conversationId: this.conversationId
    }
    this.emit('stateChange', statePayload)

    // Forward state transitions to renderer for state mirror
    if (this.mainWindow) {
      safeWindowSend(this.mainWindow, IPC_CHANNELS.CHAT_STATE_CHANGE, statePayload)
    }
    return true
  }

  isIdle(): boolean {
    return this.state === 'idle'
  }
  isStreaming(): boolean {
    return this.state === 'chat-agent-streaming'
  }

  /** Force reset to idle — emergency escape hatch */
  forceReset(): void {
    const prevState = this.state
    log.warn(`[StateMachine] Force reset from ${prevState}`)
    this.state = 'idle'
    this.conversationId = null
    const statePayload = {
      from: prevState,
      to: 'idle' as const,
      event: 'forceReset',
      conversationId: null
    }
    this.emit('stateChange', statePayload)

    // Forward force reset to renderer
    if (this.mainWindow) {
      safeWindowSend(this.mainWindow, IPC_CHANNELS.CHAT_STATE_CHANGE, statePayload)
    }
  }
}

export const conversationStateMachine = new ConversationStateMachine()
