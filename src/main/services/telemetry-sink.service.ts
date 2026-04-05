import log from 'electron-log/main'
import { eventRepository } from '../db/repositories/event.repository'
import type { EventCategory, EventRecord } from '../db/repositories/event.repository'

const telemetryLog = log.scope('TelemetrySink')

/**
 * Telemetry event — the unit of data recorded by all sinks.
 */
export interface TelemetryEvent {
  eventType: string
  category: EventCategory
  message: string
  sessionId?: string
  conversationId?: string
  workspaceId?: string
  data?: Record<string, unknown>
  agentId?: string
  model?: string
  sequenceNumber?: number
  timestamp?: string
}

/**
 * TelemetrySink interface — swappable backend for event recording.
 *
 * Inspired by Claw Code's Rust TelemetrySink trait. Implementations:
 * - SqliteTelemetrySink: production (EventRepository)
 * - MemoryTelemetrySink: tests (in-memory buffer)
 * - JsonlTelemetrySink: export/debug (append-only file)
 */
export interface TelemetrySink {
  /** Record a single telemetry event */
  record(event: TelemetryEvent): void
  /** Flush any buffered events (no-op for synchronous sinks) */
  flush(): void
  /** Get recent events (for testing/debugging) */
  getRecent(limit?: number): TelemetryEvent[]
}

/**
 * SQLite-backed telemetry sink — production default.
 * Delegates to the existing EventRepository.
 */
export class SqliteTelemetrySink implements TelemetrySink {
  record(event: TelemetryEvent): void {
    try {
      eventRepository.create({
        eventType: event.eventType,
        category: event.category,
        message: event.message,
        sessionId: event.sessionId,
        conversationId: event.conversationId,
        workspaceId: event.workspaceId,
        data: event.data,
        agentId: event.agentId,
        model: event.model,
        sequenceNumber: event.sequenceNumber
      })
    } catch (err) {
      telemetryLog.error(`SQLite sink failed for [${event.eventType}]:`, err)
    }
  }

  flush(): void {
    // No-op — SQLite writes are synchronous
  }

  getRecent(limit: number = 100): TelemetryEvent[] {
    const records = eventRepository.getRecent(limit)
    return records.map(this.recordToEvent)
  }

  private recordToEvent(record: EventRecord): TelemetryEvent {
    return {
      eventType: record.eventType,
      category: record.category,
      message: record.message,
      sessionId: record.sessionId ?? undefined,
      conversationId: record.conversationId ?? undefined,
      workspaceId: record.workspaceId ?? undefined,
      data: record.dataJson ? JSON.parse(record.dataJson) : undefined,
      agentId: record.agentId ?? undefined,
      model: record.model ?? undefined,
      sequenceNumber: record.sequenceNumber ?? undefined,
      timestamp: record.createdAt
    }
  }
}

/**
 * In-memory telemetry sink — for testing.
 * Events are stored in a buffer that can be inspected by tests.
 */
export class MemoryTelemetrySink implements TelemetrySink {
  readonly events: TelemetryEvent[] = []

  record(event: TelemetryEvent): void {
    this.events.push({
      ...event,
      timestamp: event.timestamp ?? new Date().toISOString()
    })
  }

  flush(): void {
    // No-op — in-memory
  }

  getRecent(limit: number = 100): TelemetryEvent[] {
    return this.events.slice(-limit)
  }

  /** Clear all events (for test reset) */
  clear(): void {
    this.events.length = 0
  }

  /** Find events by type (test helper) */
  findByType(eventType: string): TelemetryEvent[] {
    return this.events.filter((e) => e.eventType === eventType)
  }

  /** Find events by category (test helper) */
  findByCategory(category: EventCategory): TelemetryEvent[] {
    return this.events.filter((e) => e.category === category)
  }
}

/**
 * Composite telemetry sink — fans out to multiple sinks.
 * Useful for recording to both SQLite and JSONL simultaneously.
 */
export class CompositeTelemetrySink implements TelemetrySink {
  private readonly sinks: TelemetrySink[]

  constructor(...sinks: TelemetrySink[]) {
    this.sinks = sinks
  }

  record(event: TelemetryEvent): void {
    for (const sink of this.sinks) {
      try {
        sink.record(event)
      } catch (err) {
        telemetryLog.error(`Composite sink failed for [${event.eventType}]:`, err)
      }
    }
  }

  flush(): void {
    for (const sink of this.sinks) {
      sink.flush()
    }
  }

  getRecent(limit: number = 100): TelemetryEvent[] {
    // Return from the first sink that has events
    for (const sink of this.sinks) {
      const events = sink.getRecent(limit)
      if (events.length > 0) return events
    }
    return []
  }
}

/** Default singleton — SQLite in production */
export const defaultTelemetrySink: TelemetrySink = new SqliteTelemetrySink()
