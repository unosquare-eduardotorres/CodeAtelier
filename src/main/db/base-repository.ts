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
      .prepare(`SELECT * FROM ${this.tableName} WHERE ${column} = ?`)
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
    let sql = `SELECT * FROM ${this.tableName} WHERE ${column} = ?`
    if (options?.orderBy) sql += ` ORDER BY ${options.orderBy}`
    if (options?.limit) sql += ` LIMIT ${options.limit}`
    const rows = this.db().prepare(sql).all(value) as Row[]
    return rows.map((r) => this.mapRow(r))
  }

  /**
   * Delete rows by column value. Returns the number of deleted rows.
   */
  deleteBy(column: string, value: unknown): number {
    return this.db()
      .prepare(`DELETE FROM ${this.tableName} WHERE ${column} = ?`)
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
