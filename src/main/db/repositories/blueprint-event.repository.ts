/**
 * BlueprintEventRepository — append-only journal for blueprint pipeline events.
 *
 * Stores transcript entries (system messages, agent turns, user answers,
 * findings, Q&A records, plan/tasks artifacts, wave markers) as an ordered
 * sequence per blueprint.
 *
 * Uses safeParseJSON for the payload_json column per repo convention.
 */

import { getDatabase } from '../index'
import { safeParseJSON } from '../json-utils'
import type Database from 'better-sqlite3'

// ── Types ──

export type BlueprintEventType = 'system' | 'agent' | 'user' | 'findings' | 'qa' | 'plan' | 'tasks'

export interface BlueprintEvent {
  id: string
  blueprintId: string
  seq: number
  type: BlueprintEventType
  payload: Record<string, unknown>
  createdAt: string
}

interface BlueprintEventRow {
  id: string
  blueprint_id: string
  seq: number
  type: string
  payload_json: string
  created_at: string
}

// ── Repository ──

export class BlueprintEventRepository {
  private db(): Database.Database {
    return getDatabase()
  }

  /** Get the next sequence number for a blueprint's event journal. */
  private nextSeq(blueprintId: string): number {
    const row = this.db()
      .prepare('SELECT MAX(seq) as max_seq FROM blueprint_events WHERE blueprint_id = ?')
      .get(blueprintId) as { max_seq: number | null } | undefined
    return (row?.max_seq ?? 0) + 1
  }

  /**
   * Append an event to the journal.
   * Automatically assigns the next sequence number.
   */
  append(
    blueprintId: string,
    type: BlueprintEventType,
    payload: Record<string, unknown> = {}
  ): BlueprintEvent {
    const seq = this.nextSeq(blueprintId)
    const payloadJson = JSON.stringify(payload)

    const row = this.db()
      .prepare(
        `INSERT INTO blueprint_events (blueprint_id, seq, type, payload_json)
         VALUES (?, ?, ?, ?)
         RETURNING *`
      )
      .get(blueprintId, seq, type, payloadJson) as BlueprintEventRow

    return this.mapRow(row)
  }

  /**
   * Find all events for a blueprint, ordered by sequence number.
   */
  findByBlueprint(blueprintId: string): BlueprintEvent[] {
    const rows = this.db()
      .prepare('SELECT * FROM blueprint_events WHERE blueprint_id = ? ORDER BY seq ASC')
      .all(blueprintId) as BlueprintEventRow[]

    return rows.map((row) => this.mapRow(row))
  }

  /**
   * Find events for a blueprint after a given sequence number.
   * Useful for incremental transcript loading.
   */
  findByBlueprintAfterSeq(blueprintId: string, afterSeq: number): BlueprintEvent[] {
    const rows = this.db()
      .prepare('SELECT * FROM blueprint_events WHERE blueprint_id = ? AND seq > ? ORDER BY seq ASC')
      .all(blueprintId, afterSeq) as BlueprintEventRow[]

    return rows.map((row) => this.mapRow(row))
  }

  /**
   * Count events for a blueprint.
   */
  countByBlueprint(blueprintId: string): number {
    const row = this.db()
      .prepare('SELECT COUNT(*) as count FROM blueprint_events WHERE blueprint_id = ?')
      .get(blueprintId) as { count: number }
    return row.count
  }

  /**
   * Delete all events for a blueprint (used when re-running from scratch).
   */
  deleteByBlueprint(blueprintId: string): number {
    const result = this.db()
      .prepare('DELETE FROM blueprint_events WHERE blueprint_id = ?')
      .run(blueprintId)
    return result.changes
  }

  // ── Row Mapping ──

  private mapRow(row: BlueprintEventRow): BlueprintEvent {
    return {
      id: row.id,
      blueprintId: row.blueprint_id,
      seq: row.seq,
      type: row.type as BlueprintEventType,
      payload: safeParseJSON(row.payload_json, {}),
      createdAt: row.created_at
    }
  }
}

// ── Singleton Export ──

export const blueprintEventRepository = new BlueprintEventRepository()
