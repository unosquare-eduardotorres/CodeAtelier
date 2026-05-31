import type { TokenUsage } from './token-accountant'
import { executorLog } from './index'

let requestCounter = 0

/** Internal telemetry tracking for executor request lifecycle logging */
export interface TelemetryEntry {
  requestId: string
  startedAt: number
  completedAt?: number
  durationMs?: number
  model: string
  status: 'started' | 'succeeded' | 'failed'
  error?: string
  tokenUsage?: TokenUsage
}

/**
 * Records telemetry for an executor query lifecycle.
 * Tracks start/success/failure with timing and token usage.
 */
export class TelemetryRecorder {
  private entry: TelemetryEntry

  /** The telemetry request ID */
  get requestId(): string {
    return this.entry.requestId
  }

  constructor(model: string) {
    const id = `exec-${++requestCounter}-${Date.now()}`
    this.entry = {
      requestId: id,
      startedAt: Date.now(),
      model,
      status: 'started'
    }
    executorLog.info(`[TELEMETRY:request-started] id=${id} model=${model}`)
  }

  /**
   * Record a failure. Should be called in the catch block.
   */
  recordFailure(error: Error): void {
    this.entry.status = 'failed'
    this.entry.completedAt = Date.now()
    this.entry.durationMs = this.entry.completedAt - this.entry.startedAt
    this.entry.error = error.message
    executorLog.info(
      `[TELEMETRY:request-failed] id=${this.entry.requestId} duration=${this.entry.durationMs}ms error=${this.entry.error}`
    )
  }

  /**
   * Finalize telemetry with success. Returns the completed entry.
   * Should be called after the message loop completes successfully.
   */
  finalize(tokens: TokenUsage): TelemetryEntry {
    if (this.entry.status === 'started') {
      this.entry.status = 'succeeded'
      this.entry.completedAt = Date.now()
      this.entry.durationMs = this.entry.completedAt - this.entry.startedAt
      this.entry.tokenUsage = { ...tokens }
      executorLog.info(
        `[TELEMETRY:request-succeeded] id=${this.entry.requestId} duration=${this.entry.durationMs}ms input=${tokens.input} output=${tokens.output}`
      )
    }
    return { ...this.entry }
  }
}
