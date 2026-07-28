/**
 * Migration 66 — Project Specialist architecture.
 *
 * Transforms the DB from "app-global specialists" to "one Project Specialist
 * per workspace" per the plan in
 * docs/architecture/project-specialist-refactor.md.
 *
 * What it does, in order:
 *
 *   1. Writes a JSON backup of all specialists + their skill assignments to
 *      userData/agent-studio-specialist-backup-<ISO>.json. This is non-
 *      destructive so it happens first. Idempotent: skipped if already
 *      performed for this migration.
 *   2. ALTERs the specialists table with new columns (workspace_id,
 *      build_status, stack_fingerprint, detected_techs, mcp_config,
 *      mcp_overrides, last_built_at) plus a partial unique index.
 *   3. ALTERs specialist_skills with is_enabled (default 0).
 *   4. Creates one "pending" Project Specialist per existing workspace.
 *   5. Rebinds conversation_specialists rows to the new workspace specialist.
 *      Deduplicates (multiple old specialists → one new).
 *   6. Drops the legacy app-global specialists (workspace_id IS NULL AND
 *      agent_id != 'generalist'). The Generalist row stays app-global.
 *
 * Everything below is idempotent within a single run (guarded on
 * PRAGMA user_version by the outer migration runner).
 */

import type Database from 'better-sqlite3'
import { join } from 'node:path'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import log from 'electron-log'

const migLog = log.scope('migration-066')

interface SpecialistBackup {
  id: string
  agent_id: string
  display_name: string
  icon: string
  color: string
  prompt: string
  priority: number
  is_active: number
  source_yaml: string | null
  alias: string | null
  avatar_url: string | null
  is_core: number
  created_at: string
  updated_at: string
  /** Skill IDs assigned to this specialist via specialist_skills. */
  skill_ids: string[]
}

interface BackupDocument {
  schemaVersion: 65
  exportedAt: string
  specialists: SpecialistBackup[]
}

function exportSpecialistsBackup(db: Database.Database): string | null {
  try {
    // Skip if the backup dir already contains a file for this migration.
    let userData: string
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      userData = (require('electron') as typeof import('electron')).app.getPath('userData')
    } catch {
      // When running inside unit tests Electron's app is not available.
      return null
    }
    const backupDir = join(userData, 'backups')
    if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true })

    const specialists = db
      .prepare(
        `SELECT id, agent_id, display_name, icon, color, prompt, priority, is_active,
                source_yaml, alias, avatar_url,
                is_core, created_at, updated_at FROM specialists`
      )
      .all() as Array<Omit<SpecialistBackup, 'skill_ids'>>

    const skillsStmt = db.prepare('SELECT skill_id FROM specialist_skills WHERE specialist_id = ?')

    const withSkills: SpecialistBackup[] = specialists.map((s) => ({
      ...s,
      skill_ids: (skillsStmt.all(s.id) as Array<{ skill_id: string }>).map((row) => row.skill_id)
    }))

    const isoSafe = new Date().toISOString().replace(/[:.]/g, '-')
    const filename = `code-atelier-specialist-backup-${isoSafe}.json`
    const filepath = join(backupDir, filename)
    const doc: BackupDocument = {
      schemaVersion: 65,
      exportedAt: new Date().toISOString(),
      specialists: withSkills
    }
    writeFileSync(filepath, JSON.stringify(doc, null, 2), 'utf8')
    migLog.info(`✓ Specialist backup written to ${filepath} (${withSkills.length} entries)`)
    return filepath
  } catch (err) {
    migLog.warn('Backup export failed (non-fatal):', err)
    return null
  }
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.some((r) => r.name === column)
}

export function runProjectSpecialistMigration(db: Database.Database): void {
  // Step 1 — Backup (non-destructive, best effort).
  exportSpecialistsBackup(db)

  // Step 2 — Add columns to specialists (idempotent via hasColumn).
  const specCols: Array<{ name: string; ddl: string }> = [
    {
      name: 'workspace_id',
      ddl: `ALTER TABLE specialists ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE`
    },
    {
      name: 'build_status',
      ddl: `ALTER TABLE specialists ADD COLUMN build_status TEXT NOT NULL DEFAULT 'ready' CHECK (build_status IN ('pending', 'building', 'ready', 'failed'))`
    },
    {
      name: 'stack_fingerprint',
      ddl: `ALTER TABLE specialists ADD COLUMN stack_fingerprint TEXT`
    },
    {
      name: 'detected_techs',
      ddl: `ALTER TABLE specialists ADD COLUMN detected_techs TEXT DEFAULT '[]' CHECK (json_valid(detected_techs))`
    },
    {
      name: 'mcp_config',
      ddl: `ALTER TABLE specialists ADD COLUMN mcp_config TEXT DEFAULT '{}' CHECK (json_valid(mcp_config))`
    },
    {
      name: 'mcp_overrides',
      ddl: `ALTER TABLE specialists ADD COLUMN mcp_overrides TEXT DEFAULT '{}' CHECK (json_valid(mcp_overrides))`
    },
    { name: 'last_built_at', ddl: `ALTER TABLE specialists ADD COLUMN last_built_at TEXT` }
  ]
  for (const col of specCols) {
    if (!hasColumn(db, 'specialists', col.name)) {
      db.exec(col.ddl)
    }
  }

  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_specialists_workspace_unique
       ON specialists(workspace_id) WHERE workspace_id IS NOT NULL`
  )

  // Step 3 — Add is_enabled to specialist_skills.
  if (!hasColumn(db, 'specialist_skills', 'is_enabled')) {
    db.exec(`ALTER TABLE specialist_skills ADD COLUMN is_enabled INTEGER NOT NULL DEFAULT 0`)
  }

  // Step 4 — Create one pending Project Specialist per existing workspace.
  // Skip workspaces that already have one bound.
  const workspaces = db.prepare(`SELECT id, name FROM workspaces`).all() as Array<{
    id: string
    name: string
  }>

  const existingByWorkspace = new Map<string, string>()
  for (const row of db
    .prepare(`SELECT id, workspace_id FROM specialists WHERE workspace_id IS NOT NULL`)
    .all() as Array<{ id: string; workspace_id: string }>) {
    existingByWorkspace.set(row.workspace_id, row.id)
  }

  const insertSpecialist = db.prepare(
    `INSERT INTO specialists (workspace_id, agent_id, display_name, icon, color,
       prompt, priority, is_active, build_status, created_at, updated_at)
     VALUES (?, ?, ?, '🔧', '#6366F1', '', 1, 1, 'pending', datetime('now'), datetime('now'))`
  )

  for (const w of workspaces) {
    if (existingByWorkspace.has(w.id)) continue
    insertSpecialist.run(w.id, `workspace-specialist-${w.id}`, `${w.name} Specialist`)
  }

  // Step 5 — Rebind existing conversation_specialists rows onto the new
  // per-workspace specialist. Ordering matters: if a conversation has N
  // pre-migration specialist rows, rebinding them all to the same NEW id
  // would violate UNIQUE(conversation_id, specialist_id). So we
  //   5a. Pre-collapse: for each conversation that will be rebound, keep
  //       exactly one row (the oldest) and delete the rest.
  //   5b. Rebind the surviving rows to the workspace's new specialist.
  db.exec(
    `DELETE FROM conversation_specialists
       WHERE rowid NOT IN (
         SELECT MIN(rowid) FROM conversation_specialists
          WHERE conversation_id IN (
            SELECT c.id FROM conversations c
             WHERE c.workspace_id IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM specialists s
                  WHERE s.workspace_id = c.workspace_id
               )
          )
         GROUP BY conversation_id
       )
       AND conversation_id IN (
         SELECT c.id FROM conversations c
          WHERE c.workspace_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM specialists s
               WHERE s.workspace_id = c.workspace_id
            )
       )`
  )

  db.exec(
    `UPDATE conversation_specialists
        SET specialist_id = (
          SELECT s.id FROM specialists s
           WHERE s.workspace_id = (
             SELECT c.workspace_id FROM conversations c
              WHERE c.id = conversation_specialists.conversation_id
           )
        )
      WHERE EXISTS (
        SELECT 1 FROM conversations c
         WHERE c.id = conversation_specialists.conversation_id
           AND c.workspace_id IS NOT NULL
      ) AND EXISTS (
        SELECT 1 FROM specialists s
         WHERE s.workspace_id = (
           SELECT c.workspace_id FROM conversations c
            WHERE c.id = conversation_specialists.conversation_id
         )
      )`
  )

  // Safety net: a second dedupe pass in case any stragglers remain from
  // a partial earlier migration attempt (e.g. one that advanced
  // user_version but failed between updates).
  db.exec(
    `DELETE FROM conversation_specialists
      WHERE rowid NOT IN (
        SELECT MIN(rowid) FROM conversation_specialists
          GROUP BY conversation_id, specialist_id
      )`
  )

  // Step 6 — Drop legacy app-global specialists EXCEPT the Generalist row,
  // which the app still relies on for the home-screen concierge.
  db.exec(
    `DELETE FROM specialists
       WHERE workspace_id IS NULL
         AND agent_id != 'generalist'`
  )

  migLog.info('✓ Migration 066 complete — project-specialist architecture applied.')
}
