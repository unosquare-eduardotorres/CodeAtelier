/**
 * Migration 92 — Expand mode CHECK constraint to include 'danger'.
 *
 * Affected tables:
 *   - `conversations` — mode column CHECK (plan, build) → CHECK (plan, build, danger)
 *   - `core_agent_prompts` — mode column CHECK (plan, build) → CHECK (plan, build, danger)
 *
 * Uses the SQLite table-rebuild pattern (create new → copy → drop old → rename)
 * since ALTER TABLE cannot modify CHECK constraints.
 */

import type Database from 'better-sqlite3'
import log from 'electron-log'

const migLog = log.scope('migration-092')

export function runAddDangerModeMigration(db: Database.Database): void {
  migLog.info('Expanding mode CHECK constraint to include "danger" …')

  // ── 1. Rebuild conversations table ──
  migLog.info('Rebuilding conversations table …')

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations_new (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT 'New Conversation',
      mode TEXT NOT NULL DEFAULT 'plan' CHECK (mode IN ('plan', 'build', 'danger')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      summary TEXT,
      claude_session_id TEXT,
      pr_number INTEGER,
      pr_url TEXT,
      branch_name TEXT,
      sort_order INTEGER DEFAULT 0,
      persona_specialist_id TEXT DEFAULT NULL
        REFERENCES specialists(id) ON DELETE SET NULL,
      llm_provider TEXT NOT NULL DEFAULT 'claude' CHECK (llm_provider IN ('claude', 'local-llm')),
      mcp_overrides_json TEXT DEFAULT '{}',
      communication_tone TEXT DEFAULT NULL,
      effort TEXT NOT NULL DEFAULT 'high' CHECK (effort IN ('low', 'medium', 'high'))
    );
  `)

  db.exec(`
    INSERT INTO conversations_new (
      id, workspace_id, title, mode, created_at, status, summary, claude_session_id,
      pr_number, pr_url, branch_name, sort_order, persona_specialist_id, llm_provider,
      mcp_overrides_json, communication_tone, effort
    )
    SELECT
      id, workspace_id, title, mode, created_at, status, summary, claude_session_id,
      pr_number, pr_url, branch_name, sort_order, persona_specialist_id, llm_provider,
      mcp_overrides_json, communication_tone, effort
    FROM conversations;
  `)

  db.exec(`DROP TABLE conversations;`)
  db.exec(`ALTER TABLE conversations_new RENAME TO conversations;`)

  migLog.info('✓ conversations table rebuilt with danger mode')

  // ── 2. Rebuild core_agent_prompts table ──
  migLog.info('Rebuilding core_agent_prompts table …')

  db.exec(`
    CREATE TABLE IF NOT EXISTS core_agent_prompts_new (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      agent_role TEXT NOT NULL CHECK (agent_role IN ('da-vinci', 'generalist')),
      mode TEXT NOT NULL CHECK (mode IN ('plan', 'build', 'danger')),
      prompt_text TEXT NOT NULL,
      default_prompt_text TEXT NOT NULL,
      is_custom INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(agent_role, mode)
    );
  `)

  db.exec(`
    INSERT INTO core_agent_prompts_new (
      id, agent_role, mode, prompt_text, default_prompt_text, is_custom, updated_at
    )
    SELECT
      id, agent_role, mode, prompt_text, default_prompt_text, is_custom, updated_at
    FROM core_agent_prompts;
  `)

  db.exec(`DROP TABLE core_agent_prompts;`)
  db.exec(`ALTER TABLE core_agent_prompts_new RENAME TO core_agent_prompts;`)

  migLog.info('✓ core_agent_prompts table rebuilt with danger mode')
  migLog.info('✓ Migration 92 complete — danger mode enabled in DB')
}
