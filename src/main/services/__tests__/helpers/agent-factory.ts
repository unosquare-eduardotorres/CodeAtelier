/**
 * Agent Factory — Builds service instances with injected dependencies for testing.
 *
 * All services in Code Atelier use module-level singletons. For unit tests,
 * we need to construct fresh instances with mocked dependencies. This factory
 * provides builder functions that wire up services with controllable fakes.
 *
 * Usage:
 *   const { stateMachine } = createConversationStateMachine()
 *   const { detector } = createIntentDetector()
 *   const { router, sentMessages } = createIntentRouter()
 */

// ── Mock BrowserWindow ──

export interface MockWebContents {
  send: (channel: string, ...args: unknown[]) => void
}

export interface MockBrowserWindow {
  webContents: MockWebContents
  isDestroyed: () => boolean
}

export interface SentMessage {
  channel: string
  payload: unknown
}

/**
 * Creates a mock BrowserWindow that captures all IPC sends.
 */
export function createMockBrowserWindow(opts?: { destroyed?: boolean }): {
  window: MockBrowserWindow
  sentMessages: SentMessage[]
} {
  const sentMessages: SentMessage[] = []
  const window: MockBrowserWindow = {
    webContents: {
      send: (channel: string, ...args: unknown[]) => {
        sentMessages.push({ channel, payload: args[0] })
      }
    },
    isDestroyed: () => opts?.destroyed ?? false
  }
  return { window, sentMessages }
}

// ── Mock Logger ──

export interface MockLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
  calls: Array<{ level: string; args: unknown[] }>
}

export function createMockLogger(): MockLogger {
  const calls: Array<{ level: string; args: unknown[] }> = []
  return {
    info: (...args: unknown[]) => calls.push({ level: 'info', args }),
    warn: (...args: unknown[]) => calls.push({ level: 'warn', args }),
    error: (...args: unknown[]) => calls.push({ level: 'error', args }),
    debug: (...args: unknown[]) => calls.push({ level: 'debug', args }),
    calls
  }
}

// ── Mock EventLoggerService ──

export interface MockEventLoggerService {
  logPlanDetected: (...args: unknown[]) => void
  logAgentToolCall: (...args: unknown[]) => void
  loggedEvents: Array<{ method: string; args: unknown[] }>
}

export function createMockEventLoggerService(): MockEventLoggerService {
  const loggedEvents: Array<{ method: string; args: unknown[] }> = []
  return {
    logPlanDetected: (...args: unknown[]) => loggedEvents.push({ method: 'logPlanDetected', args }),
    logAgentToolCall: (...args: unknown[]) =>
      loggedEvents.push({ method: 'logAgentToolCall', args }),
    loggedEvents
  }
}

// ── ConversationStateMachine Factory ──

/**
 * Creates a fresh ConversationStateMachine with an optional mock window.
 * Returns the instance and captured state change events.
 */
export function createConversationStateMachine() {
  // We import the class constructor rather than the singleton to get fresh state
  // Dynamic import avoids module-level side-effects
  const { ConversationStateMachine } = require('../../conversation-state-machine') as {
    ConversationStateMachine: new () => InstanceType<
      typeof import('../../conversation-state-machine').ConversationStateMachine
    >
  }

  const sm = new ConversationStateMachine()
  const stateChanges: Array<{ from: string; to: string; event: string }> = []

  sm.on('stateChange', (payload: { from: string; to: string; event: string }) => {
    stateChanges.push(payload)
  })

  const { window, sentMessages } = createMockBrowserWindow()
  sm.setMainWindow(window as unknown as import('electron').BrowserWindow)

  return { stateMachine: sm, stateChanges, sentMessages, window }
}

// ── IntentDetector Factory ──

export function createIntentDetector() {
  const { IntentDetector } = require('../../intent-detector') as {
    IntentDetector: new () => InstanceType<typeof import('../../intent-detector').IntentDetector>
  }

  return { detector: new IntentDetector() }
}

// ── IntentRouter Factory ──

export function createIntentRouter() {
  const { window, sentMessages } = createMockBrowserWindow()

  const { IntentRouter } = require('../../intent-router') as {
    IntentRouter: new (
      win: unknown
    ) => InstanceType<typeof import('../../intent-router').IntentRouter>
  }

  const router = new IntentRouter(window)
  return { router, sentMessages, window }
}

// ── AgentCircuitBreaker Factory ──

export function createCircuitBreaker() {
  const { AgentCircuitBreaker } = require('../../agent-circuit-breaker') as {
    AgentCircuitBreaker: new () => InstanceType<
      typeof import('../../agent-circuit-breaker').AgentCircuitBreaker
    >
  }

  return { breaker: new AgentCircuitBreaker() }
}



// ── AgentTokenTracker Factory ──

export function createTokenTracker() {
  const { AgentTokenTracker } = require('../../agent-token-tracker') as {
    AgentTokenTracker: new () => InstanceType<
      typeof import('../../agent-token-tracker').AgentTokenTracker
    >
  }
  return { tracker: new AgentTokenTracker() }
}

// ── ElicitationService Factory ──

export function createElicitationService() {
  const { ElicitationService } = require('../../elicitation.service') as {
    ElicitationService: new () => InstanceType<
      typeof import('../../elicitation.service').ElicitationService
    >
  }
  return { service: new ElicitationService() }
}

// ── Mock Repository Factories ──

export function createMockConversationRepo() {
  const conversations = new Map<string, { id: string; mode: string; workspaceId: string }>()
  return {
    findById: (id: string) => conversations.get(id) ?? null,
    create: (id: string, mode: string, workspaceId: string) => {
      const conv = { id, mode, workspaceId }
      conversations.set(id, conv)
      return conv
    },
    updateMode: (id: string, mode: string) => {
      const conv = conversations.get(id)
      if (conv) conv.mode = mode
    },
    _store: conversations
  }
}

export function createMockMessageRepo() {
  const messages: Array<{ id: string; conversationId: string; role: string; content: string }> = []
  let counter = 0
  return {
    create: (conversationId: string, role: string, content: string) => {
      const msg = { id: `msg-${++counter}`, conversationId, role, content }
      messages.push(msg)
      return msg
    },
    findByConversation: (convId: string) => messages.filter((m) => m.conversationId === convId),
    _store: messages
  }
}

// ── Utility: Fake Timers ──

/**
 * Simple timer control for testing timeout-based logic.
 * Not a full fake timer — just captures setTimeout calls for manual advancement.
 */
export class FakeTimerControl {
  private timers: Array<{ fn: () => void; delay: number; id: number }> = []
  private nextId = 1

  capture(): (fn: () => void, delay: number) => number {
    return (fn: () => void, delay: number): number => {
      const id = this.nextId++
      this.timers.push({ fn, delay, id })
      return id as unknown as number
    }
  }

  /** Advance time, firing all timers with delay <= ms */
  advance(ms: number): void {
    const ready = this.timers.filter((t) => t.delay <= ms)
    this.timers = this.timers.filter((t) => t.delay > ms)
    for (const timer of ready) {
      timer.fn()
    }
  }

  get pending(): number {
    return this.timers.length
  }
}
