/**
 * Migration 72 — Drop `specialists.mcp_config` and `specialists.mcp_overrides`.
 *
 * The per-specialist MCP toggle story has been replaced by workspace-level
 * MCP feature flags (workspace.settingsJson.repomapEnabled / semanticSearchEnabled /
 * etc.). Runtime MCP composition now happens in `buildWorkspaceMcpConfig`
 * directly against the workspace's feature flags, so the persisted
 * mcp_config / mcp_overrides columns are obsolete.
 *
 * This migration rebuilds the `specialists` table sans those two columns
 * (SQLite table-rebuild pattern — safer than ALTER TABLE DROP COLUMN across
 * SQLite versions). All other columns and rows are preserved, and the
 * partial unique index on workspace_id is recreated.
 */

import type Database from 'better-sqlite3'
import log from 'electron-log'

const migLog = log.scope('migration-072')

export function runDropSpecialistMcpColumnsMigration(db: Database.Database): void {
  migLog.info('Rebuilding specialists table without mcp_config / mcp_overrides …')

  db.exec(`
    CREATE TABLE IF NOT EXISTS specialists_new (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      agent_id TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '🔧',
      color TEXT NOT NULL DEFAULT '#6366F1',
      prompt TEXT DEFAULT '',
      priority INTEGER NOT NULL DEFAULT 100,
      is_active INTEGER NOT NULL DEFAULT 1,
      source_yaml TEXT DEFAULT NULL,
      alias TEXT DEFAULT NULL,
      avatar_url TEXT DEFAULT NULL,
      is_core INTEGER NOT NULL DEFAULT 0,
      description TEXT DEFAULT NULL,
      workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
      build_status TEXT NOT NULL DEFAULT 'ready' CHECK (build_status IN ('pending', 'building', 'ready', 'failed')),
      stack_fingerprint TEXT,
      detected_techs TEXT DEFAULT '[]' CHECK (json_valid(detected_techs)),
      last_built_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  db.exec(`
    INSERT INTO specialists_new (
      id, agent_id, display_name, icon, color, prompt, priority, is_active,
      source_yaml, alias, avatar_url, is_core, description,
      workspace_id, build_status, stack_fingerprint, detected_techs, last_built_at,
      created_at, updated_at
    )
    SELECT
      id, agent_id, display_name, icon, color, prompt, priority, is_active,
      source_yaml, alias, avatar_url, is_core, description,
      workspace_id, build_status, stack_fingerprint, detected_techs, last_built_at,
      created_at, updated_at
    FROM specialists;
  `)

  db.exec(`DROP TABLE specialists;`)
  db.exec(`ALTER TABLE specialists_new RENAME TO specialists;`)

  // Recreate the partial unique index: one Project Specialist per workspace.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_specialists_workspace_unique
      ON specialists(workspace_id) WHERE workspace_id IS NOT NULL;
  `)

  migLog.info('✓ specialists table rebuilt without mcp_config / mcp_overrides')
}
