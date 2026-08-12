/**
 * BaseRepository — DRY foundation for SQLite-backed repositories.
 *
 * Provides:
 *  - `db()` accessor (replaces 160+ inline `getDatabase()` calls)
 *  - `findOneBy()` / `findManyBy()` generic finders
 *  - `deleteBy()` generic deleter
 *  - `runTransaction()` safe transaction wrapper
 *
 * Subclasses define `tableName` and `mapRow()`. Complex repositories
 * can override or skip these helpers and call `db()` directly.
 */

import type Database from 'better-sqlite3'
import { getDatabase } from './index'

/**
 * SQL-01 / DB-02 / DB-03: Regex validators for SQL identifiers interpolated into queries.
 * Prevents SQL injection via column names and ORDER BY clauses.
 * Only allows alphanumeric + underscore identifiers, with optional ASC/DESC for orderBy.
 */
const COLUMN_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/
const ORDER_BY_RE =
  /^[a-zA-Z_][a-zA-Z0-9_]*(\s+(ASC|DESC))?(\s*,\s*[a-zA-Z_][a-zA-Z0-9_]*(\s+(ASC|DESC))?)*$/i

function validateColumnName(name: string): string {
  if (!COLUMN_NAME_RE.test(name)) {
    throw new Error(`Invalid column name: ${name}`)
  }
  return name
}

function validateOrderBy(clause: string): string {
  if (!ORDER_BY_RE.test(clause)) {
    throw new Error(`Invalid ORDER BY clause: ${clause}`)
  }
  return clause
}

function validateLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 0 || !Number.isInteger(limit)) {
    throw new Error(`Invalid LIMIT value: ${limit}`)
  }
  return limit
}

export abstract class BaseRepository<Row, Model> {
  /** Table name used by generic finders */
  protected abstract readonly tableName: string

  /** Map a raw SQLite row to the application model */
  protected abstract mapRow(row: Row): Model

  /** Get the database instance (replaces `getDatabase()` in every method) */
  protected db(): Database.Database {
    return getDatabase()
  }

  /**
   * Find a single row by column value.
   * Returns undefined when no match is found.
   */
  findOneBy(column: string, value: unknown): Model | undefined {
    const row = this.db()
      .prepare(`SELECT * FROM ${this.tableName} WHERE ${validateColumnName(column)} = ?`)
      .get(value) as Row | undefined
    return row ? this.mapRow(row) : undefined
  }

  /**
   * Find a single row by primary key (defaults to 'id' column).
   */
  findById(id: string): Model | undefined {
    return this.findOneBy('id', id)
  }

  /**
   * Find all rows matching a column value, with optional ordering and limit.
   */
  findManyBy(
    column: string,
    value: unknown,
    options?: { orderBy?: string; limit?: number }
  ): Model[] {
    let sql = `SELECT * FROM ${this.tableName} WHERE ${validateColumnName(column)} = ?`
    if (options?.orderBy) sql += ` ORDER BY ${validateOrderBy(options.orderBy)}`
    if (options?.limit) sql += ` LIMIT ${validateLimit(options.limit)}`
    const rows = this.db().prepare(sql).all(value) as Row[]
    return rows.map((r) => this.mapRow(r))
  }

  /**
   * Delete rows by column value. Returns the number of deleted rows.
   */
  deleteBy(column: string, value: unknown): number {
    return this.db()
      .prepare(`DELETE FROM ${this.tableName} WHERE ${validateColumnName(column)} = ?`)
      .run(value).changes
  }

  /**
   * Delete a row by primary key (defaults to 'id' column).
   */
  deleteById(id: string): number {
    return this.deleteBy('id', id)
  }

  /**
   * Run a function inside a SQLite transaction.
   * The transaction automatically commits on success and rolls back on error.
   */
  protected runTransaction<T>(fn: () => T): T {
    return this.db().transaction(fn)()
  }
}
