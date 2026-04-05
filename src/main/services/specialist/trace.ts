/**
 * Structured tracing system for specialist execution.
 *
 * Provides lightweight trace events with timing spans and runId correlation,
 * enabling execution timeline reconstruction. Inspired by OpenTelemetry spans
 * but zero-dependency and tailored to Agent Studio's specialist pipeline.
 *
 * Usage:
 *   const tracer = new ExecutionTracer()
 *   tracer.onTrace((event) => console.log(event))
 *
 *   const runId = tracer.startRun('parallel-execution')
 *   const span = tracer.startSpan(runId, 'specialist', { agentId: 'frontend-architect', taskId: 'task-1' })
 *   // ... work ...
 *   tracer.endSpan(span, { tokenUsage: { input: 1000, output: 500 } })
 *   tracer.endRun(runId)
 */
import { randomUUID } from 'node:crypto'

// ── Trace Event Types ──

export type TraceEventType =
  | 'run_start'
  | 'run_end'
  | 'specialist_start'
  | 'specialist_end'
  | 'llm_call_start'
  | 'llm_call_end'
  | 'tool_call_start'
  | 'tool_call_end'
  | 'task_retry'
  | 'gate_evaluation'
  | 'dependency_resolved'
  | 'error'

export interface TraceTokenUsage {
  input: number
  output: number
  cacheRead?: number
  cacheCreation?: number
}

export interface TraceEvent {
  /** Unique ID for this trace event */
  id: string
  /** Correlation ID — all events in the same execution share this */
  runId: string
  /** Event type for filtering and grouping */
  type: TraceEventType
  /** ISO timestamp when the event occurred */
  timestamp: string
  /** Duration in ms (only set on *_end events) */
  durationMs?: number
  /** Specialist agent ID (if applicable) */
  agentId?: string
  /** Task ID (if applicable) */
  taskId?: string
  /** Human-readable description of the event */
  message?: string
  /** Token usage data (if applicable) */
  tokenUsage?: TraceTokenUsage
  /** Arbitrary metadata for specific event types */
  metadata?: Record<string, unknown>
}

export interface TraceSpan {
  id: string
  runId: string
  type: TraceEventType
  startTime: number
  agentId?: string
  taskId?: string
  metadata?: Record<string, unknown>
}

export type TraceListener = (event: TraceEvent) => void

/** Valid end types for paired span events — guards against incorrect type derivation */
const VALID_TRACE_END_TYPES = new Set<TraceEventType>([
  'run_end', 'specialist_end', 'llm_call_end', 'tool_call_end'
])

// ── Execution Tracer ──

export class ExecutionTracer {
  private listeners: TraceListener[] = []
  private activeSpans = new Map<string, TraceSpan>()
  private activeRuns = new Map<string, { startTime: number; events: TraceEvent[] }>()

  /**
   * Subscribe to trace events. Returns an unsubscribe function.
   * Zero overhead when no listeners are attached — emit() is a no-op.
   */
  onTrace(listener: TraceListener): () => void {
    this.listeners.push(listener)
    return (): void => {
      const idx = this.listeners.indexOf(listener)
      if (idx >= 0) this.listeners.splice(idx, 1)
    }
  }

  /** Start a new execution run. Returns the runId for correlation. */
  startRun(
    description: string,
    metadata?: Record<string, unknown>
  ): string {
    const runId = randomUUID()
    this.activeRuns.set(runId, { startTime: Date.now(), events: [] })

    this.emit({
      id: randomUUID(),
      runId,
      type: 'run_start',
      timestamp: new Date().toISOString(),
      message: description,
      metadata
    })

    return runId
  }

  /** End an execution run. Emits summary with total duration. */
  endRun(
    runId: string,
    metadata?: Record<string, unknown>
  ): void {
    const run = this.activeRuns.get(runId)
    const durationMs = run ? Date.now() - run.startTime : undefined

    this.emit({
      id: randomUUID(),
      runId,
      type: 'run_end',
      timestamp: new Date().toISOString(),
      durationMs,
      metadata: {
        ...metadata,
        eventCount: run?.events.length ?? 0
      }
    })

    this.activeRuns.delete(runId)
  }

  /**
   * Start a traced span (specialist execution, LLM call, tool call, etc.).
   * Returns a TraceSpan handle — pass to endSpan() when complete.
   */
  startSpan(
    runId: string,
    type: TraceEventType,
    options: {
      agentId?: string
      taskId?: string
      message?: string
      metadata?: Record<string, unknown>
    } = {}
  ): TraceSpan {
    const span: TraceSpan = {
      id: randomUUID(),
      runId,
      type,
      startTime: Date.now(),
      agentId: options.agentId,
      taskId: options.taskId,
      metadata: options.metadata
    }

    this.activeSpans.set(span.id, span)

    this.emit({
      id: span.id,
      runId,
      type,
      timestamp: new Date().toISOString(),
      agentId: options.agentId,
      taskId: options.taskId,
      message: options.message,
      metadata: options.metadata
    })

    return span
  }

  /**
   * End a traced span. Calculates duration and emits the end event.
   * Returns the computed durationMs for callers that need it (e.g. afterRun hooks).
   */
  endSpan(
    span: TraceSpan,
    result?: {
      tokenUsage?: TraceTokenUsage
      message?: string
      metadata?: Record<string, unknown>
      error?: string
    }
  ): number {
    this.activeSpans.delete(span.id)
    const durationMs = Date.now() - span.startTime

    // Derive the end type from the start type — only valid for paired *_start/*_end types
    const derivedType = span.type.replace('_start', '_end')
    const endType: TraceEventType = VALID_TRACE_END_TYPES.has(derivedType as TraceEventType)
      ? (derivedType as TraceEventType)
      : 'error' // Fallback — non-paired event types produce 'error' to surface the issue

    this.emit({
      id: randomUUID(),
      runId: span.runId,
      type: endType,
      timestamp: new Date().toISOString(),
      durationMs,
      agentId: span.agentId,
      taskId: span.taskId,
      tokenUsage: result?.tokenUsage,
      message: result?.message ?? (result?.error ? `Error: ${result.error}` : undefined),
      metadata: {
        ...span.metadata,
        ...result?.metadata,
        ...(result?.error ? { error: result.error } : {})
      }
    })

    return durationMs
  }

  /**
   * Emit a one-shot trace event (not a span — no start/end pair).
   * Used for retries, gate evaluations, dependency resolutions, etc.
   */
  traceEvent(
    runId: string,
    type: TraceEventType,
    options: {
      agentId?: string
      taskId?: string
      message?: string
      tokenUsage?: TraceTokenUsage
      metadata?: Record<string, unknown>
    } = {}
  ): void {
    this.emit({
      id: randomUUID(),
      runId,
      type,
      timestamp: new Date().toISOString(),
      agentId: options.agentId,
      taskId: options.taskId,
      message: options.message,
      tokenUsage: options.tokenUsage,
      metadata: options.metadata
    })
  }

  /** Get all events for a run (for post-hoc analysis). Returns empty array if run is unknown. */
  getRunEvents(runId: string): readonly TraceEvent[] {
    return this.activeRuns.get(runId)?.events ?? []
  }

  /** Check if any listeners are attached (for zero-overhead guard). */
  get hasListeners(): boolean {
    return this.listeners.length > 0
  }

  /** Clean up all active spans and runs (for reset/abort). */
  reset(): void {
    this.activeSpans.clear()
    this.activeRuns.clear()
  }

  private emit(event: TraceEvent): void {
    // Record in run history
    const run = this.activeRuns.get(event.runId)
    if (run) run.events.push(event)

    // Notify listeners (zero overhead when none attached)
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // Never let a listener crash the pipeline
      }
    }
  }
}

/** Singleton tracer instance for the specialist pipeline */
export const executionTracer = new ExecutionTracer()
