import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { app } from 'electron'
import log from 'electron-log/main'
import { eventRepository } from '../db/repositories/event.repository'
import { turnUsageRepository } from '../db/repositories/turn-usage.repository'
import { agentSessionRepository } from '../db/repositories/agent-session.repository'
import type { TelemetrySink, TelemetryEvent } from './telemetry-sink.service'

const exportLog = log.scope('JsonlExport')

/**
 * JSONL line format — each line is a self-contained JSON object.
 */
interface JsonlLine {
  /** ISO timestamp */
  ts: string
  /** Event type (e.g. 'session.started', 'agent.tool_call') */
  type: string
  /** Event category */
  cat: string
  /** Human-readable message */
  msg: string
  /** Sequence number within session (for total ordering) */
  seq?: number
  /** Structured data payload */
  data?: Record<string, unknown>
  /** Agent ID */
  agent?: string
  /** Model used */
  model?: string
  /** Session ID */
  sid?: string
  /** Conversation ID */
  cid?: string
}

/**
 * JSONL telemetry sink — writes events to append-only JSONL files.
 * Implements the TelemetrySink interface for composable telemetry recording.
 *
 * File structure:
 *   {userData}/telemetry/session-{sessionId}.jsonl  (per-session)
 *   {userData}/telemetry/all-events.jsonl           (global, rotated at 256KB)
 */
export class JsonlTelemetrySink implements TelemetrySink {
  private readonly telemetryDir: string
  private readonly globalLogPath: string
  private static readonly MAX_FILE_SIZE = 256 * 1024 // 256KB
  private static readonly MAX_ARCHIVES = 3

  constructor(telemetryDir?: string) {
    this.telemetryDir = telemetryDir ?? join(app.getPath('userData'), 'telemetry')
    this.globalLogPath = join(this.telemetryDir, 'all-events.jsonl')
    this.ensureDir()
  }

  private ensureDir(): void {
    if (!existsSync(this.telemetryDir)) {
      mkdirSync(this.telemetryDir, { recursive: true })
    }
  }

  record(event: TelemetryEvent): void {
    const line: JsonlLine = {
      ts: event.timestamp ?? new Date().toISOString(),
      type: event.eventType,
      cat: event.category,
      msg: event.message,
      seq: event.sequenceNumber,
      data: event.data,
      agent: event.agentId,
      model: event.model,
      sid: event.sessionId,
      cid: event.conversationId
    }
    const jsonLine = JSON.stringify(line) + '\n'

    try {
      // Append to global log (with rotation)
      this.appendWithRotation(this.globalLogPath, jsonLine)

      // Append to session-specific log if session ID is present
      if (event.sessionId) {
        const sessionPath = join(this.telemetryDir, `session-${event.sessionId}.jsonl`)
        appendFileSync(sessionPath, jsonLine)
      }
    } catch (err) {
      exportLog.error('JSONL write failed:', err)
    }
  }

  flush(): void {
    // No-op — writes are synchronous and unbuffered
  }

  getRecent(_limit: number = 100): TelemetryEvent[] {
    // JSONL sink is write-only — return empty for consistency
    return []
  }

  /**
   * Append a line to a file, rotating if it exceeds the size limit.
   * Rotation: all-events.jsonl → all-events.1.jsonl → all-events.2.jsonl → all-events.3.jsonl
   */
  private appendWithRotation(filePath: string, data: string): void {
    if (existsSync(filePath)) {
      const { statSync } = require('node:fs') as typeof import('node:fs')
      const stats = statSync(filePath)
      if (stats.size >= JsonlTelemetrySink.MAX_FILE_SIZE) {
        this.rotateFile(filePath)
      }
    }
    appendFileSync(filePath, data)
  }

  private rotateFile(filePath: string): void {
    const { renameSync, unlinkSync } = require('node:fs') as typeof import('node:fs')
    const base = filePath.replace('.jsonl', '')

    // Shift archives: 2→3, 1→2, current→1 (delete oldest)
    for (let i = JsonlTelemetrySink.MAX_ARCHIVES; i >= 1; i--) {
      const src = i === 1 ? filePath : `${base}.${i - 1}.jsonl`
      const dst = `${base}.${i}.jsonl`
      if (existsSync(src)) {
        if (i === JsonlTelemetrySink.MAX_ARCHIVES && existsSync(dst)) {
          unlinkSync(dst)
        }
        try {
          renameSync(src, dst)
        } catch {
          // Race condition — ignore
        }
      }
    }
  }
}

/**
 * Export service — generates JSONL exports from the database for debugging/sharing.
 */
class JsonlExportService {
  /**
   * Export all events for a conversation to a JSONL file.
   * Returns the path to the exported file.
   */
  exportConversation(conversationId: string, outputPath?: string): string {
    const events = eventRepository.findByConversation(conversationId, 10000)
    const turns = turnUsageRepository.findByConversation(conversationId)

    const exportDir = outputPath
      ? dirname(outputPath)
      : join(app.getPath('userData'), 'exports')
    if (!existsSync(exportDir)) {
      mkdirSync(exportDir, { recursive: true })
    }

    const filePath =
      outputPath ?? join(exportDir, `conversation-${conversationId}-${Date.now()}.jsonl`)

    // Write events
    const lines: string[] = []
    for (const event of events) {
      const line: JsonlLine = {
        ts: event.createdAt,
        type: event.eventType,
        cat: event.category as string,
        msg: event.message,
        seq: event.sequenceNumber ?? undefined,
        data: event.dataJson ? JSON.parse(event.dataJson) : undefined,
        agent: event.agentId ?? undefined,
        model: event.model ?? undefined,
        sid: event.sessionId ?? undefined,
        cid: event.conversationId ?? undefined
      }
      lines.push(JSON.stringify(line))
    }

    // Append turn usage as special events
    for (const turn of turns) {
      const line: JsonlLine = {
        ts: turn.createdAt,
        type: 'turn.usage',
        cat: 'session',
        msg: `Turn ${turn.turnNumber}: in=${turn.inputTokens} out=${turn.outputTokens} cache_read=${turn.cacheReadTokens}`,
        data: {
          turnNumber: turn.turnNumber,
          inputTokens: turn.inputTokens,
          outputTokens: turn.outputTokens,
          cacheReadTokens: turn.cacheReadTokens,
          cacheCreationTokens: turn.cacheCreationTokens,
          model: turn.model
        },
        sid: turn.sessionId,
        cid: turn.conversationId
      }
      lines.push(JSON.stringify(line))
    }

    writeFileSync(filePath, lines.join('\n') + '\n')
    exportLog.info(`Exported ${lines.length} events to ${filePath}`)
    return filePath
  }

  /**
   * Export all sessions for a workspace to JSONL.
   */
  exportWorkspaceSessions(workspaceId: string, outputPath?: string): string {
    const sessions = agentSessionRepository.findByWorkspace(workspaceId)

    const exportDir = outputPath
      ? dirname(outputPath)
      : join(app.getPath('userData'), 'exports')
    if (!existsSync(exportDir)) {
      mkdirSync(exportDir, { recursive: true })
    }

    const filePath =
      outputPath ?? join(exportDir, `workspace-${workspaceId}-sessions-${Date.now()}.jsonl`)

    const lines: string[] = sessions.map((session) =>
      JSON.stringify({
        ts: session.startedAt,
        type: 'session',
        agent: session.agentType,
        status: session.status,
        tokens: session.tokenUsage,
        input_tokens: session.inputTokens,
        output_tokens: session.outputTokens,
        cache_read: session.cacheReadTokens,
        cache_creation: session.cacheCreationTokens,
        model: session.modelUsed,
        complexity: session.complexityTier,
        duration_ms: session.endedAt
          ? new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()
          : null,
        cid: session.conversationId
      })
    )

    writeFileSync(filePath, lines.join('\n') + '\n')
    exportLog.info(`Exported ${sessions.length} sessions to ${filePath}`)
    return filePath
  }
}

export const jsonlExportService = new JsonlExportService()
