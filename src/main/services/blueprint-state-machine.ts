/**
 * BlueprintStateMachine — explicit state machine for the Blueprint pipeline.
 *
 * Mirrors the ConversationStateMachine pattern: table-driven transitions,
 * idempotent-when-idle, forceReset() for emergency recovery, stateChange events.
 *
 * One instance per workspace, owned by BlueprintService.
 */

import { EventEmitter } from 'node:events'
import log from 'electron-log'
import type { BlueprintPhaseType } from '../../shared/blueprint-types'
import type { BlueprintMachineState } from '../../shared/blueprint-snapshot-types'

export type { BlueprintMachineState } from '../../shared/blueprint-snapshot-types'

const smLog = log.scope('blueprint-sm')

// ── Transitions (events that drive state changes) ──

export type BlueprintMachineTransition =
  | 'startPhase'
  | 'questionsParsed'
  | 'awaitingInput'
  | 'gateParsed'
  | 'answerReceived'
  | 'proceedGate'
  | 'iterate'
  | 'approvalNeeded'
  | 'approvalResponded'
  | 'phaseComplete'
  | 'cancel'
  | 'fail'
  | 'retry'

// ── Transition Table ──

const VALID_TRANSITIONS: Record<
  BlueprintMachineState,
  Partial<Record<BlueprintMachineTransition, BlueprintMachineState>>
> = {
  idle: {
    startPhase: 'phase-running'
  },
  'phase-running': {
    questionsParsed: 'awaiting-clarify-questions',
    awaitingInput: 'awaiting-clarify-input',
    gateParsed: 'awaiting-clarify-gate',
    approvalNeeded: 'awaiting-approval',
    phaseComplete: 'idle',
    cancel: 'cancelled',
    fail: 'failed'
  },
  'awaiting-clarify-questions': {
    answerReceived: 'phase-running',
    cancel: 'cancelled',
    fail: 'failed'
  },
  'awaiting-clarify-input': {
    answerReceived: 'phase-running',
    cancel: 'cancelled',
    fail: 'failed'
  },
  'awaiting-clarify-gate': {
    proceedGate: 'idle',
    iterate: 'phase-running',
    cancel: 'cancelled',
    fail: 'failed'
  },
  'awaiting-approval': {
    approvalResponded: 'idle',
    cancel: 'cancelled',
    fail: 'failed'
  },
  cancelled: {
    retry: 'idle'
  },
  failed: {
    retry: 'idle'
  }
}

// Events that are idempotent (no-op) when already in idle state.
// Prevents race conditions when multiple services finalize concurrently.
const IDEMPOTENT_WHEN_IDLE: BlueprintMachineTransition[] = [
  'phaseComplete',
  'cancel',
  'proceedGate',
  'approvalResponded'
]

// ── State Change Payload ──

export interface BlueprintStateChangePayload {
  workspaceId: string
  from: BlueprintMachineState
  to: BlueprintMachineState
  event: BlueprintMachineTransition | 'forceReset'
  blueprintId: string | null
  phase: BlueprintPhaseType | null
}

// ── Machine ──

export class BlueprintStateMachine extends EventEmitter {
  private state: BlueprintMachineState = 'idle'
  private _blueprintId: string | null = null
  private _phase: BlueprintPhaseType | null = null
  readonly workspaceId: string

  constructor(workspaceId: string) {
    super()
    this.workspaceId = workspaceId
    this.on('error', (err) => {
      smLog.error(`[SM:${workspaceId}:unhandled-error]`, err)
    })
  }

  // ── Getters ──

  get currentState(): BlueprintMachineState {
    return this.state
  }

  get blueprintId(): string | null {
    return this._blueprintId
  }

  get phase(): BlueprintPhaseType | null {
    return this._phase
  }

  // ── Transition ──

  /**
   * Attempt a state transition.
   * Returns true if transition succeeded (including idempotent no-ops).
   * Returns false if the transition is invalid from the current state.
   */
  transition(
    event: BlueprintMachineTransition,
    context?: { blueprintId?: string; phase?: BlueprintPhaseType }
  ): boolean {
    // Idempotent transitions — if already idle, treat finalizing events as no-ops.
    if (this.state === 'idle' && IDEMPOTENT_WHEN_IDLE.includes(event)) {
      smLog.info(`[SM:${this.workspaceId}] ${event} already idle — no-op`)
      return true
    }

    const nextState = VALID_TRANSITIONS[this.state]?.[event]
    if (!nextState) {
      smLog.warn(
        `[SM:${this.workspaceId}] Invalid transition: ${this.state} + ${event} ` +
          `(blueprint=${this._blueprintId}, phase=${this._phase})`
      )
      return false
    }

    const prevState = this.state
    this.state = nextState

    // Update context
    if (context?.blueprintId) this._blueprintId = context.blueprintId
    if (context?.phase) this._phase = context.phase

    // Clear context on return to idle
    if (nextState === 'idle') {
      this._blueprintId = null
      this._phase = null
    }

    smLog.info(
      `[SM:${this.workspaceId}] ${prevState} → ${nextState} (event=${event}, blueprint=${this._blueprintId})`
    )

    const payload: BlueprintStateChangePayload = {
      workspaceId: this.workspaceId,
      from: prevState,
      to: nextState,
      event,
      blueprintId: this._blueprintId,
      phase: this._phase
    }
    this.emit('stateChange', payload)

    return true
  }

  // ── Convenience Checks ──

  isIdle(): boolean {
    return this.state === 'idle'
  }

  isRunning(): boolean {
    return this.state === 'phase-running'
  }

  isAwaitingInput(): boolean {
    return (
      this.state === 'awaiting-clarify-input' ||
      this.state === 'awaiting-clarify-questions' ||
      this.state === 'awaiting-clarify-gate' ||
      this.state === 'awaiting-approval'
    )
  }

  isClarifyState(): boolean {
    return (
      this.state === 'awaiting-clarify-input' ||
      this.state === 'awaiting-clarify-questions' ||
      this.state === 'awaiting-clarify-gate'
    )
  }

  isTerminal(): boolean {
    return this.state === 'cancelled' || this.state === 'failed'
  }

  // ── Force Reset (emergency escape hatch) ──

  /**
   * Force the machine back to idle — bypasses the transition table.
   * Used when normal transition paths are broken (crash recovery, abort).
   */
  forceReset(): void {
    const prevState = this.state
    smLog.warn(`[SM:${this.workspaceId}] Force reset from ${prevState}`)
    this.state = 'idle'
    this._blueprintId = null
    this._phase = null

    const payload: BlueprintStateChangePayload = {
      workspaceId: this.workspaceId,
      from: prevState,
      to: 'idle',
      event: 'forceReset',
      blueprintId: null,
      phase: null
    }
    this.emit('stateChange', payload)
  }
}
