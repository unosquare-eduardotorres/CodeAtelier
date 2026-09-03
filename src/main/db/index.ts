import Database from 'better-sqlite3'
// Lazy Electron import — standalone MCP server processes run as plain Node.js
// where `electron` is not available. The `app` object is only needed when
// DB_PATH is not set (i.e., inside the Electron main process).
function getElectronApp(): typeof import('electron').app {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy so this module loads without Electron (unit tests)
  return require('electron').app
}
import { join } from 'node:path'
import { existsSync, renameSync, statSync } from 'node:fs'
import { dbLogger } from '../logger'
import SCHEMA_SQL from './schema.sql?raw'
export { SCHEMA_SQL }
import { DEFAULT_PROMPTS } from '../services/default-prompts'
import { runProjectSpecialistMigration } from './migrations/project-specialist-migration'
import { runDropSpecialistMcpColumnsMigration } from './migrations/drop-specialist-mcp-columns-migration'
import { runAddDangerModeMigration } from './migrations/add-danger-mode-migration'
import { maybeVacuumInBackground } from './maintenance'
import { resolveAssignment } from '../services/model-config.service'
import type { LLMProvider, LocalLLMBackend, ModelRoleMap, ModelOverrides } from '../../shared/types'

let db: Database.Database | null = null

// ── Versioned Migration System ──────────────────────────────────────────────
// Each migration runs in a transaction and atomically updates PRAGMA user_version.
// Only migrations with version > current user_version are executed.
// Failed migrations throw (surfacing real errors) instead of being silently swallowed.

export const CURRENT_SCHEMA_VERSION = 156

export interface Migration {
  version: number
  name: string
  up: (db: Database.Database) => void
  /** Set true for migrations that DROP parent tables (e.g. conversations rebuild).
   *  The runner will disable PRAGMA foreign_keys before the transaction and
   *  re-enable + verify integrity after. */
  disableForeignKeys?: boolean
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'add-mode-column-to-conversations',
    up: (db) => {
      db.exec(
        `ALTER TABLE conversations ADD COLUMN mode TEXT NOT NULL DEFAULT 'plan' CHECK (mode IN ('plan', 'build'))`
      )
    }
  },
  {
    version: 2,
    name: 'update-messages-check-constraint-generalist',
    up: (db) => {
      const tableInfo = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'")
        .get() as { sql: string } | undefined

      if (tableInfo && !tableInfo.sql.includes("'generalist'")) {
        db.exec(`
          ALTER TABLE messages RENAME TO messages_old;

          CREATE TABLE messages (
            id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK (role IN ('user', 'coordinator', 'specialist', 'generalist')),
            agent_id TEXT,
            content_md TEXT NOT NULL,
            attachments_json TEXT DEFAULT '[]',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          );

          INSERT INTO messages SELECT * FROM messages_old;

          DROP TABLE messages_old;

          CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
        `)
      }
    }
  },
  {
    version: 3,
    name: 'ensure-generalist-specialist',
    up: (db) => {
      const generalistExists = db
        .prepare("SELECT 1 FROM specialists WHERE agent_id = 'generalist'")
        .get()
      if (!generalistExists) {
        db.prepare(
          'INSERT INTO specialists (agent_id, display_name, icon, color, priority) VALUES (?, ?, ?, ?, ?)'
        ).run('generalist', 'Generalist', '💬', '#6366F1', 0)
      }
    }
  },
  {
    version: 4,
    name: 'rename-postgres-to-db-architect',
    up: (db) => {
      db.prepare(
        "UPDATE specialists SET agent_id = 'db-architect', display_name = 'DB Architect', icon = '🗄️' WHERE agent_id = 'postgres-architect'"
      ).run()
    }
  },
  {
    version: 5,
    name: 'add-electron-architect',
    up: (db) => {
      const electronExists = db
        .prepare("SELECT 1 FROM specialists WHERE agent_id = 'electron-architect'")
        .get()
      if (!electronExists) {
        db.prepare(
          'INSERT INTO specialists (agent_id, display_name, icon, color, priority) VALUES (?, ?, ?, ?, ?)'
        ).run('electron-architect', 'Electron Architect', '⚡', '#47848F', 4)
      }
    }
  },
  {
    version: 6,
    name: 'add-source-yaml-column',
    up: (db) => {
      db.exec('ALTER TABLE specialists ADD COLUMN source_yaml TEXT DEFAULT NULL')
    }
  },
  {
    version: 7,
    name: 'add-claude-session-id',
    up: (db) => {
      db.exec('ALTER TABLE conversations ADD COLUMN claude_session_id TEXT DEFAULT NULL')
    }
  },
  {
    version: 8,
    name: 'create-conversation-file-changes',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS conversation_file_changes (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          file_path TEXT NOT NULL,
          change_type TEXT NOT NULL DEFAULT 'modified' CHECK (change_type IN ('created', 'modified', 'deleted')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(conversation_id, file_path)
        );
        CREATE INDEX IF NOT EXISTS idx_file_changes_conversation ON conversation_file_changes(conversation_id);
      `)
    }
  },
  {
    version: 9,
    name: 'create-agent-worktrees',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_worktrees (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          worktree_path TEXT NOT NULL,
          branch_name TEXT NOT NULL,
          base_branch TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'merging', 'merged', 'conflict', 'abandoned', 'pruned')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          merged_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_worktrees_conversation ON agent_worktrees(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_worktrees_status ON agent_worktrees(status);
      `)
    }
  },
  {
    version: 10,
    name: 'add-session-workspace-columns',
    up: (db) => {
      db.exec(
        'ALTER TABLE agent_sessions ADD COLUMN conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL'
      )
      db.exec(
        'ALTER TABLE agent_sessions ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE'
      )
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_agent_sessions_workspace ON agent_sessions(workspace_id)'
      )
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_agent_sessions_conversation ON agent_sessions(conversation_id)'
      )
    }
  },
  {
    version: 11,
    name: 'add-complexity-scoring-columns',
    up: (db) => {
      db.exec('ALTER TABLE agent_sessions ADD COLUMN complexity_score INTEGER')
      db.exec('ALTER TABLE agent_sessions ADD COLUMN model_used TEXT')
      db.exec('ALTER TABLE agent_sessions ADD COLUMN complexity_tier TEXT')
    }
  },
  {
    version: 12,
    name: 'create-ideas-table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ideas (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          description TEXT DEFAULT '',
          status TEXT NOT NULL DEFAULT 'draft'
            CHECK (status IN ('draft', 'grilling', 'completed')),
          grill_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
          grill_summary TEXT,
          converted_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_ideas_workspace ON ideas(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(status);
      `)
    }
  },
  {
    version: 13,
    name: 'create-memories-table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
          type TEXT NOT NULL CHECK (type IN ('user', 'feedback', 'project', 'reference')),
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          tags TEXT DEFAULT '[]' CHECK (json_valid(tags)),
          source_conversation_id TEXT,
          source_agent_id TEXT,
          importance INTEGER NOT NULL DEFAULT 5,
          last_accessed_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_memories_workspace ON memories(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
        CREATE INDEX IF NOT EXISTS idx_memories_context ON memories(workspace_id, type, importance DESC);
      `)
    }
  },
  {
    version: 14,
    name: 'create-dream-runs-table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS dream_runs (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'running'
            CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
          trigger_type TEXT NOT NULL CHECK (trigger_type IN ('startup', 'idle', 'manual')),
          memories_created INTEGER DEFAULT 0,
          memories_merged INTEGER DEFAULT 0,
          memories_pruned INTEGER DEFAULT 0,
          token_usage INTEGER DEFAULT 0,
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          ended_at TEXT,
          error_message TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_dream_runs_workspace ON dream_runs(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_dream_runs_status ON dream_runs(status);
      `)
    }
  },
  {
    version: 15,
    name: 'add-pr-tracking-columns',
    up: (db) => {
      db.exec('ALTER TABLE conversations ADD COLUMN pr_number INTEGER')
      db.exec('ALTER TABLE conversations ADD COLUMN pr_url TEXT')
      db.exec('ALTER TABLE conversations ADD COLUMN branch_name TEXT')
    }
  },
  {
    version: 16,
    name: 'add-is-git-repo-flag',
    up: (db) => {
      db.exec('ALTER TABLE workspaces ADD COLUMN is_git_repo INTEGER DEFAULT 1')
    }
  },
  {
    version: 17,
    name: 'add-specialist-alias-columns',
    up: (db) => {
      db.exec('ALTER TABLE specialists ADD COLUMN alias TEXT DEFAULT NULL')
      db.exec('ALTER TABLE specialists ADD COLUMN avatar_url TEXT DEFAULT NULL')
    }
  },
  {
    version: 18,
    name: 'create-user-profile-table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_profile (
          id TEXT PRIMARY KEY DEFAULT 'default',
          display_name TEXT NOT NULL DEFAULT 'Developer',
          avatar_key TEXT NOT NULL DEFAULT 'renaissance-scholar',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
    }
  },
  {
    version: 19,
    name: 'create-core-agent-aliases-table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS core_agent_aliases (
          agent_role TEXT PRIMARY KEY CHECK (agent_role IN ('generalist', 'coordinator')),
          alias TEXT DEFAULT NULL,
          avatar_key TEXT DEFAULT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
    }
  },
  {
    version: 20,
    name: 'wal-checkpoint',
    up: (db) => {
      // Reclaim WAL file space on upgrade
      db.pragma('wal_checkpoint(TRUNCATE)')
    }
  },
  {
    version: 21,
    name: 'add_grill_decisions_to_ideas',
    up: (db) => {
      db.exec(`ALTER TABLE ideas ADD COLUMN grill_decisions TEXT DEFAULT NULL`)
    }
  },
  {
    version: 22,
    name: 'create_events_table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          session_id TEXT,
          conversation_id TEXT,
          workspace_id TEXT,
          event_type TEXT NOT NULL,
          category TEXT NOT NULL CHECK (category IN (
            'session', 'agent', 'escalation', 'gate', 'abandonment',
            'checkpoint', 'hook', 'budget', 'error'
          )),
          message TEXT NOT NULL,
          data_json TEXT DEFAULT '{}',
          agent_id TEXT,
          model TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_events_category ON events(category)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_events_conversation ON events(conversation_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC)`)
    }
  },
  {
    version: 23,
    name: 'create_checkpoints_table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS checkpoints (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          conversation_id TEXT NOT NULL,
          workspace_id TEXT,
          label TEXT NOT NULL,
          state_json TEXT NOT NULL DEFAULT '{}',
          git_branch TEXT,
          git_commit_sha TEXT,
          active_task_ids TEXT DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_checkpoints_conversation ON checkpoints(conversation_id)`
      )
    }
  },
  {
    version: 24,
    name: 'add_cost_tracking_to_sessions',
    up: (db) => {
      db.exec(`ALTER TABLE agent_sessions ADD COLUMN estimated_cost_cents REAL DEFAULT 0`)
      db.exec(`ALTER TABLE agent_sessions ADD COLUMN input_tokens INTEGER DEFAULT 0`)
      db.exec(`ALTER TABLE agent_sessions ADD COLUMN output_tokens INTEGER DEFAULT 0`)
    }
  },
  {
    version: 25,
    name: 'create_gate_results_table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS gate_results (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          session_id TEXT,
          conversation_id TEXT,
          task_id TEXT,
          agent_id TEXT,
          gate_type TEXT NOT NULL CHECK (gate_type IN ('test', 'lint', 'typecheck', 'build')),
          passed INTEGER NOT NULL DEFAULT 0,
          summary TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_gate_results_conversation ON gate_results(conversation_id)`
      )
      db.exec(`CREATE INDEX IF NOT EXISTS idx_gate_results_task ON gate_results(task_id)`)
    }
  },
  {
    version: 26,
    name: 'reconceive-agent-roster-16-to-8',
    up: (db) => {
      // Deactivate archived agent IDs
      const archivedIds = [
        'electron-architect',
        'agentic-architect',
        'code-planner',
        'execution-planner',
        'requirements-specialist',
        'cicd-devops',
        'cloud-infrastructure',
        'git-github-specialist',
        'docs-diagrams-specialist'
      ]
      const deactivateStmt = db.prepare(`UPDATE specialists SET is_active = 0 WHERE agent_id = ?`)
      for (const id of archivedIds) {
        deactivateStmt.run(id)
      }

      // Rename existing agents
      db.prepare(
        `UPDATE specialists SET agent_id = 'frontend-architect', display_name = 'Frontend Architect' WHERE agent_id = 'react-architect'`
      ).run()
      db.prepare(
        `UPDATE specialists SET agent_id = 'data-architect', display_name = 'Data Architect' WHERE agent_id = 'db-architect'`
      ).run()
      db.prepare(
        `UPDATE specialists SET agent_id = 'design-specialist', display_name = 'Design Specialist' WHERE agent_id = 'ux-ui-specialist'`
      ).run()

      // Note: New agents (platform-architect, planner, platform-engineer, dx-specialist)
      // will be inserted by agent-sync.service on next workspace open when it discovers the new YAMLs.
      // No manual INSERT needed — the sync service handles YAML→DB bridging.
    }
  },
  {
    version: 27,
    name: 'migrate-avatar-keys-to-renaissance',
    up: (db) => {
      // Remap old cartoon avatar keys to new Renaissance portrait keys
      const avatarMap: Record<string, string> = {
        'business-man': 'renaissance-merchant',
        'business-woman': 'renaissance-diplomat',
        'hoodie-dev': 'renaissance-scribe',
        'glasses-guy': 'renaissance-scholar',
        'woman-curly': 'renaissance-herbalist',
        'bearded-man': 'renaissance-blacksmith',
        'ponytail-girl': 'renaissance-noblewoman',
        'cap-guy': 'renaissance-explorer',
        'da-vinci': 'renaissance-painter',
        stravinsky: 'renaissance-astronomer',
        robot: 'renaissance-alchemist',
        ninja: 'renaissance-knight',
        superhero: 'renaissance-knight',
        pirate: 'renaissance-navigator',
        scientist: 'renaissance-alchemist',
        chef: 'renaissance-jester'
      }
      const updateProfile = db.prepare(
        `UPDATE user_profile SET avatar_key = ? WHERE avatar_key = ?`
      )
      for (const [oldKey, newKey] of Object.entries(avatarMap)) {
        updateProfile.run(newKey, oldKey)
      }
    }
  },
  {
    version: 28,
    name: 'add-specialist-pixel-sprite-id',
    up: (db) => {
      db.exec('ALTER TABLE specialists ADD COLUMN pixel_sprite_id TEXT DEFAULT NULL')
    }
  },
  {
    version: 29,
    name: 'seed-specialist-pixel-sprite-ids',
    up: (db) => {
      const assignments: Record<string, string> = {
        generalist: 'male-07-1',
        'electron-architect': 'other-pipo-charachip-soldier01',
        'react-architect': 'enemy-02-1',
        'dotnet-architect': 'male-09-1',
        'ux-ui-specialist': 'male-02-2',
        'cloud-infrastructure': 'male-16-2',
        'agentic-architect': 'female-03-1',
        'db-architect': 'male-04-1',
        'git-github-specialist': 'male-14-1',
        'requirements-specialist': 'female-12-1',
        'code-planner': 'male-11-1',
        'execution-planner': 'male-13-1',
        'cicd-devops': 'soldier-03-1'
      }
      const update = db.prepare(
        'UPDATE specialists SET pixel_sprite_id = ? WHERE agent_id = ? AND pixel_sprite_id IS NULL'
      )
      for (const [agentId, spriteId] of Object.entries(assignments)) {
        update.run(spriteId, agentId)
      }
    }
  },
  {
    version: 30,
    name: 'add-specialist-use-pixel-for-chat',
    up: (db) => {
      db.exec('ALTER TABLE specialists ADD COLUMN use_pixel_for_chat INTEGER NOT NULL DEFAULT 0')
    }
  },
  {
    version: 31,
    name: 'add-core-agent-prompts-and-is-core',
    up: (db) => {
      // 1. Create core_agent_prompts table
      db.exec(`
        CREATE TABLE IF NOT EXISTS core_agent_prompts (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          agent_role TEXT NOT NULL CHECK (agent_role IN ('generalist')),
          mode TEXT NOT NULL CHECK (mode IN ('plan', 'build')),
          prompt_text TEXT NOT NULL,
          default_prompt_text TEXT NOT NULL,
          is_custom INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(agent_role, mode)
        )
      `)

      // 2. Seed rows from DEFAULT_PROMPTS
      const insert = db.prepare(`
        INSERT OR IGNORE INTO core_agent_prompts (agent_role, mode, prompt_text, default_prompt_text, is_custom)
        VALUES (?, ?, ?, ?, 0)
      `)
      for (const [role, modes] of Object.entries(DEFAULT_PROMPTS)) {
        for (const [mode, promptText] of Object.entries(modes)) {
          insert.run(role, mode, promptText, promptText)
        }
      }

      // 3. Add is_core column to specialists
      db.exec('ALTER TABLE specialists ADD COLUMN is_core INTEGER NOT NULL DEFAULT 0')

      // 4. Mark core agents
      db.exec(`
        UPDATE specialists SET is_core = 1
        WHERE agent_id IN ('generalist', 'generalist-agent')
      `)
    }
  },
  {
    version: 32,
    name: 'remove-orchestrator-core-prompts',
    up: (db) => {
      db.exec(`DELETE FROM core_agent_prompts WHERE agent_role = 'orchestrator'`)
    }
  },
  {
    version: 33,
    name: 'create-user-specialist-from-profile',
    up: (db) => {
      // Read existing profile (if any)
      const profile = db
        .prepare("SELECT display_name, avatar_key FROM user_profile WHERE id = 'default'")
        .get() as { display_name: string; avatar_key: string } | undefined
      const displayName = profile?.display_name ?? 'Developer'
      const avatarKey = profile?.avatar_key ?? 'user'

      // Insert user specialist (idempotent)
      const exists = db.prepare("SELECT 1 FROM specialists WHERE agent_id = 'user'").get()
      if (!exists) {
        db.prepare(
          `INSERT INTO specialists (agent_id, display_name, icon, color, prompt, priority, is_core, avatar_url)
           VALUES ('user', ?, '👤', '#6366F1', '', -1, 1, ?)`
        ).run(displayName, avatarKey)
      }
    }
  },
  {
    version: 34,
    name: 'remove-orchestrator-specialist',
    up: (db) => {
      db.exec(`DELETE FROM specialists WHERE agent_id = 'orchestrator'`)
      // Clean up any lingering generalist-agent alias (old naming)
      db.exec(
        `DELETE FROM specialists WHERE agent_id = 'generalist-agent' AND EXISTS (SELECT 1 FROM specialists WHERE agent_id = 'generalist')`
      )
    }
  },
  {
    version: 35,
    name: 'create-conversation-specialist-activation-tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS conversation_specialists (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          specialist_id TEXT NOT NULL REFERENCES specialists(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(conversation_id, specialist_id)
        );

        CREATE TABLE IF NOT EXISTS specialist_conversation_history (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          specialist_id TEXT NOT NULL REFERENCES specialists(id) ON DELETE CASCADE,
          action TEXT NOT NULL CHECK (action IN ('activated', 'deactivated')),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_conversation_specialists_conversation
          ON conversation_specialists(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_conversation_specialists_specialist
          ON conversation_specialists(specialist_id);
        CREATE INDEX IF NOT EXISTS idx_specialist_history_conversation
          ON specialist_conversation_history(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_specialist_history_specialist
          ON specialist_conversation_history(specialist_id);
        CREATE INDEX IF NOT EXISTS idx_specialist_history_conversation_created
          ON specialist_conversation_history(conversation_id, created_at DESC);
      `)
    }
  },
  {
    version: 36,
    name: 'add-skill-gating-and-app-preferences',
    up: (db) => {
      // Add skill-gating columns to conversation_specialists
      db.exec(
        `ALTER TABLE conversation_specialists ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1`
      )
      db.exec(
        `ALTER TABLE conversation_specialists ADD COLUMN skills_enabled INTEGER NOT NULL DEFAULT 1`
      )
      db.exec(`ALTER TABLE conversation_specialists ADD COLUMN skill_overrides TEXT DEFAULT NULL`)
      db.exec(
        `ALTER TABLE conversation_specialists ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))`
      )

      // App-level key-value preferences
      db.exec(`
        CREATE TABLE IF NOT EXISTS app_preferences (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
      // Seed default preferences
      db.exec(`
        INSERT OR IGNORE INTO app_preferences (key, value) VALUES
          ('specialist_warning_build', 'true'),
          ('specialist_warning_plan', 'true'),
          ('specialist_warning_always', 'false')
      `)
    }
  },
  {
    version: 37,
    name: 'add-granular-token-columns',
    up: (db) => {
      db.exec(`ALTER TABLE agent_sessions ADD COLUMN input_tokens INTEGER DEFAULT 0`)
      db.exec(`ALTER TABLE agent_sessions ADD COLUMN output_tokens INTEGER DEFAULT 0`)
      db.exec(`ALTER TABLE agent_sessions ADD COLUMN cache_read_tokens INTEGER DEFAULT 0`)
      db.exec(`ALTER TABLE agent_sessions ADD COLUMN cache_creation_tokens INTEGER DEFAULT 0`)
    }
  },
  {
    version: 38,
    name: 'add-skill-semantic-summaries',
    up: (db) => {
      db.exec(`ALTER TABLE skills ADD COLUMN summary_full TEXT DEFAULT NULL`)
      db.exec(`ALTER TABLE skills ADD COLUMN summary_standard TEXT DEFAULT NULL`)
      db.exec(`ALTER TABLE skills ADD COLUMN summary_minimal TEXT DEFAULT NULL`)
      db.exec(`ALTER TABLE skills ADD COLUMN summary_hash TEXT DEFAULT NULL`)
    }
  },
  {
    version: 39,
    name: 'create-unified-storage-tables',
    up: (db) => {
      // code_chunks — preprocessed code units for semantic search
      db.exec(`
        CREATE TABLE IF NOT EXISTS code_chunks (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          file_path TEXT NOT NULL,
          file_name TEXT NOT NULL,
          directory TEXT NOT NULL,
          symbol_name TEXT NOT NULL,
          symbol_kind TEXT NOT NULL,
          class_name TEXT,
          signature TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          language TEXT NOT NULL,
          body TEXT NOT NULL,
          embed_text TEXT NOT NULL,
          is_public INTEGER NOT NULL DEFAULT 1,
          is_async INTEGER NOT NULL DEFAULT 0,
          has_docstring INTEGER NOT NULL DEFAULT 0,
          line_count INTEGER NOT NULL,
          file_mtime REAL NOT NULL,
          indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(workspace_id, file_path, symbol_name, start_line)
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_workspace ON code_chunks(workspace_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_file ON code_chunks(workspace_id, file_path)`)
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_chunks_symbol ON code_chunks(workspace_id, symbol_name)`
      )
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_chunks_kind ON code_chunks(workspace_id, symbol_kind)`
      )
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_chunks_language ON code_chunks(workspace_id, language)`
      )

      // chunk_embeddings — vector storage as BLOBs
      db.exec(`
        CREATE TABLE IF NOT EXISTS chunk_embeddings (
          chunk_id TEXT PRIMARY KEY REFERENCES code_chunks(id) ON DELETE CASCADE,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          embedding BLOB NOT NULL,
          model TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_embeddings_workspace ON chunk_embeddings(workspace_id)`
      )

      // chunk_descriptions — AI-generated descriptions (replaces description-cache.db)
      db.exec(`
        CREATE TABLE IF NOT EXISTS chunk_descriptions (
          key TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          description TEXT NOT NULL,
          model TEXT NOT NULL,
          file_path TEXT NOT NULL,
          symbol_name TEXT NOT NULL,
          generated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_descriptions_workspace ON chunk_descriptions(workspace_id)`
      )
      db.exec(`CREATE INDEX IF NOT EXISTS idx_descriptions_file ON chunk_descriptions(file_path)`)

      // code_graph_edges — cached symbol relationships
      db.exec(`
        CREATE TABLE IF NOT EXISTS code_graph_edges (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          source_file TEXT NOT NULL,
          source_symbol TEXT NOT NULL,
          target_file TEXT NOT NULL,
          target_symbol TEXT NOT NULL,
          edge_type TEXT NOT NULL CHECK (edge_type IN ('calls', 'imports', 'extends', 'implements', 'references')),
          page_rank REAL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_workspace ON code_graph_edges(workspace_id)`)
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_graph_source ON code_graph_edges(workspace_id, source_file, source_symbol)`
      )
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_graph_target ON code_graph_edges(workspace_id, target_file, target_symbol)`
      )

      // indexing_state — persistent indexing progress per workspace
      db.exec(`
        CREATE TABLE IF NOT EXISTS indexing_state (
          workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'idle',
          total_files INTEGER NOT NULL DEFAULT 0,
          processed_files INTEGER NOT NULL DEFAULT 0,
          total_chunks INTEGER NOT NULL DEFAULT 0,
          processed_chunks INTEGER NOT NULL DEFAULT 0,
          embedding_model TEXT,
          last_completed_at TEXT,
          last_error TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
    }
  },
  {
    version: 40,
    name: 'migrate-description-cache-db',
    up: (db) => {
      // Migrate data from the separate description-cache.db into chunk_descriptions
      try {
        const userDataPath = getElectronApp().getPath('userData')
        const oldDbPath = join(userDataPath, 'description-cache.db')
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic native module import in migration
        const { existsSync } = require('node:fs') as typeof import('node:fs')

        if (existsSync(oldDbPath)) {
          // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic native module import in migration
          const OldDatabase = require('better-sqlite3') as typeof Database
          const oldDb = new OldDatabase(oldDbPath, { readonly: true })

          try {
            // Check if the old table exists
            const tableExists = oldDb
              .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='descriptions'`)
              .get()

            if (tableExists) {
              const rows = oldDb
                .prepare('SELECT key, description, model, file_path, symbol_name FROM descriptions')
                .all() as Array<{
                key: string
                description: string
                model: string
                file_path: string
                symbol_name: string
              }>

              if (rows.length > 0) {
                const insertStmt = db.prepare(`
                  INSERT OR IGNORE INTO chunk_descriptions (key, workspace_id, description, model, file_path, symbol_name)
                  VALUES (?, 'default', ?, ?, ?, ?)
                `)

                for (const row of rows) {
                  insertStmt.run(
                    row.key,
                    row.description,
                    row.model,
                    row.file_path,
                    row.symbol_name
                  )
                }

                dbLogger.info(`✓ Migrated ${rows.length} descriptions from description-cache.db`)
              }
            }
          } finally {
            oldDb.close()
          }

          dbLogger.info(
            `ℹ Old description-cache.db preserved at ${oldDbPath} — safe to delete manually`
          )
        }
      } catch (error) {
        // Non-fatal: log warning but don't block the migration
        dbLogger.warn('⚠ Could not migrate description-cache.db:', error)
      }
    }
  },
  {
    version: 41,
    name: 'create-agent-messages-table',
    up: (db) => {
      // agent_messages — persistent inter-agent communication log
      // Mirrors the in-memory MessageBus for crash recovery and audit
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT,
          run_id TEXT,
          from_agent TEXT NOT NULL,
          to_agent TEXT,
          type TEXT NOT NULL CHECK (type IN ('context', 'finding', 'dependency', 'feedback', 'status', 'artifact', 'custom')),
          content TEXT NOT NULL,
          task_id TEXT,
          metadata_json TEXT DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_agent_messages_conversation ON agent_messages(conversation_id)`
      )
      db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_messages_run ON agent_messages(run_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_messages_task ON agent_messages(task_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_messages_from ON agent_messages(from_agent)`)
    }
  },
  {
    version: 42,
    name: 'update-build-prompt-always-report-outcomes',
    up: (db) => {
      const newBuildPrompt = DEFAULT_PROMPTS['da-vinci'].build

      // Update default_prompt_text always.
      // Update prompt_text ONLY if user hasn't customized it (is_custom = 0).
      db.prepare(
        `
        UPDATE core_agent_prompts
        SET default_prompt_text = ?,
            prompt_text = CASE WHEN is_custom = 0 THEN ? ELSE prompt_text END,
            updated_at = datetime('now')
        WHERE agent_role = 'generalist' AND mode = 'build'
      `
      ).run(newBuildPrompt, newBuildPrompt)
    }
  },
  {
    version: 43,
    name: 'randomize-specialist-pixel-sprites',
    up: (db) => {
      const assignments: Record<string, string> = {
        'electron-architect': 'male-18-1',
        'react-architect': 'female-07-1',
        'dotnet-architect': 'male-03-2',
        'ux-ui-specialist': 'female-15-1',
        'cloud-infrastructure': 'male-10-3',
        'agentic-architect': 'female-05-2',
        'db-architect': 'male-15-1',
        'git-github-specialist': 'male-01-3',
        'requirements-specialist': 'female-09-2',
        'code-planner': 'male-05-4',
        'execution-planner': 'female-02-3',
        'cicd-devops': 'male-12-1'
      }
      const update = db.prepare('UPDATE specialists SET pixel_sprite_id = ? WHERE agent_id = ?')
      for (const [agentId, spriteId] of Object.entries(assignments)) {
        update.run(spriteId, agentId)
      }
    }
  },
  {
    version: 44,
    name: 'add-turn-usage-table-and-event-sequence-numbers',
    up: (db) => {
      // Per-turn token breakdown for cost debugging and cache rate trends
      db.exec(`
        CREATE TABLE IF NOT EXISTS turn_usage (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          session_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          turn_number INTEGER NOT NULL,
          input_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          cache_read_tokens INTEGER DEFAULT 0,
          cache_creation_tokens INTEGER DEFAULT 0,
          model TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_turn_usage_session ON turn_usage(session_id)`)
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_turn_usage_conversation ON turn_usage(conversation_id)`
      )

      // Event sequence numbering for total ordering within a session
      db.exec(`ALTER TABLE events ADD COLUMN sequence_number INTEGER`)

      // Expand category CHECK to include 'telemetry' for HTTP/API lifecycle events.
      // SQLite doesn't support ALTER CHECK — but newly inserted rows with 'telemetry'
      // will work if the table was created with the updated schema.sql. Existing DBs
      // created before this migration have the old CHECK; we recreate the events table
      // only if the CHECK doesn't already include 'telemetry'.
      // For simplicity, we skip CHECK migration (SQLite limitation) — the schema.sql
      // already has the updated CHECK for fresh installs. Existing installs will
      // fail on 'telemetry' category insertion, but the event logger catches that.
    }
  },
  {
    version: 45,
    name: 'create-code-graph-tags-ranks-state',
    up: (db) => {
      // Tree-sitter tags (def + ref) per workspace — enables incremental re-indexing via mtime
      db.exec(`
        CREATE TABLE IF NOT EXISTS code_graph_tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          rel_fname TEXT NOT NULL,
          fname TEXT NOT NULL,
          line INTEGER NOT NULL,
          name TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('def', 'ref')),
          file_mtime REAL NOT NULL,
          indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(workspace_id, rel_fname, line, name, kind)
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_cg_tags_workspace ON code_graph_tags(workspace_id)`)
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_cg_tags_file ON code_graph_tags(workspace_id, rel_fname)`
      )
      db.exec(`CREATE INDEX IF NOT EXISTS idx_cg_tags_name ON code_graph_tags(workspace_id, name)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_cg_tags_kind ON code_graph_tags(workspace_id, kind)`)

      // Per-file PageRank scores — pre-computed during indexing for instant lookups
      db.exec(`
        CREATE TABLE IF NOT EXISTS code_graph_ranks (
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          rel_fname TEXT NOT NULL,
          page_rank REAL NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (workspace_id, rel_fname)
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_cg_ranks_workspace ON code_graph_ranks(workspace_id)`)

      // Indexing state for code graph (separate from semantic search indexing_state)
      db.exec(`
        CREATE TABLE IF NOT EXISTS code_graph_state (
          workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'idle',
          total_files INTEGER NOT NULL DEFAULT 0,
          processed_files INTEGER NOT NULL DEFAULT 0,
          total_tags INTEGER NOT NULL DEFAULT 0,
          total_edges INTEGER NOT NULL DEFAULT 0,
          last_completed_at TEXT,
          last_error TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
    }
  },
  {
    version: 46,
    name: 'add-specialist-description-column',
    up: (db) => {
      db.exec('ALTER TABLE specialists ADD COLUMN description TEXT DEFAULT NULL')
    }
  },
  {
    version: 47,
    name: 'create-agent-context-table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_context (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          conversation_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          task_id TEXT,
          context_type TEXT NOT NULL CHECK (context_type IN ('finding', 'decision', 'artifact', 'summary')),
          content TEXT NOT NULL,
          token_estimate INTEGER DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_agent_context_conversation ON agent_context(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_agent_context_agent ON agent_context(conversation_id, agent_id);
        CREATE INDEX IF NOT EXISTS idx_agent_context_type ON agent_context(conversation_id, context_type);
      `)
    }
  },
  {
    version: 48,
    name: 'cleanup-noise-memories',
    up: (db) => {
      // Remove auto-generated noise memories that are redundant with system prompt
      // or too low-value to justify injection token cost:
      // - conversation-close summaries (importance 3, noise)
      // - task-execution logs (importance 4, noise)
      // - git-commit completion memories (importance <= 6, available via git log)
      // - CLAUDE.md/codebase feed memories (redundant with system prompt Layer 4)
      db.exec(`
        DELETE FROM memories
        WHERE tags LIKE '%conversation-close%'
           OR tags LIKE '%task-execution%'
           OR (tags LIKE '%completion%' AND tags LIKE '%git-commit%' AND importance <= 6)
           OR (source_agent_id IN ('memory-feed-claude-md', 'memory-feed-codebase')
               AND importance <= 5);
      `)
    }
  },
  {
    version: 49,
    name: 'update-plan-prompt-no-write-tool',
    up: (db) => {
      const newPlanPrompt = DEFAULT_PROMPTS['da-vinci'].plan

      // Update default_prompt_text always.
      // Update prompt_text ONLY if user hasn't customized it (is_custom = 0).
      db.prepare(
        `
        UPDATE core_agent_prompts
        SET default_prompt_text = ?,
            prompt_text = CASE WHEN is_custom = 0 THEN ? ELSE prompt_text END,
            updated_at = datetime('now')
        WHERE agent_role = 'generalist' AND mode = 'plan'
      `
      ).run(newPlanPrompt, newPlanPrompt)
    }
  },
  {
    version: 50,
    name: 'specialist-overhaul-v2',
    up: (db) => {
      // 1. Remove "Agent Studio" references from specialist prompts (project-agnostic)
      db.exec(`
        UPDATE specialists
        SET prompt = REPLACE(prompt, 'for Agent Studio', 'for the current project')
        WHERE prompt LIKE '%for Agent Studio%'
      `)
      db.exec(`
        UPDATE specialists
        SET prompt = REPLACE(prompt, 'Agent Studio', 'the current project')
        WHERE prompt LIKE '%Agent Studio%'
      `)

      // 2. Mark docs-diagrams-specialist as core (internal utility, not user-facing)
      db.exec("UPDATE specialists SET is_core = 1 WHERE agent_id = 'docs-diagrams-specialist'")

      // 3. Fix user specialist: display_name → "User", description → helpful text, preserve alias
      const userSpec = db
        .prepare("SELECT id, display_name FROM specialists WHERE agent_id = 'user'")
        .get() as { id: string; display_name: string } | undefined

      if (userSpec) {
        const currentName = userSpec.display_name
        const alias =
          currentName && currentName !== 'Developer' && currentName !== 'User' ? currentName : null

        db.prepare(
          `
          UPDATE specialists
          SET display_name = 'User',
              description = 'This is the user interacting in the chat',
              alias = COALESCE(?, alias)
          WHERE agent_id = 'user'
        `
        ).run(alias)
      }
    }
  },
  {
    version: 51,
    name: 'add-conversation-sort-order',
    up: (db) => {
      db.exec(`ALTER TABLE conversations ADD COLUMN sort_order INTEGER DEFAULT 0`)
      // Initialize sort_order based on created_at (newest = lowest number = top)
      db.exec(`
        UPDATE conversations SET sort_order = (
          SELECT COUNT(*) FROM conversations c2
          WHERE c2.workspace_id = conversations.workspace_id
          AND c2.created_at > conversations.created_at
        )
      `)
    }
  },
  {
    version: 52,
    name: 'sync-prompts-build-mode-fix',
    up: (db) => {
      // Sync updated prompts after build-mode fix:
      // - Handoff rules are now mode-aware (plan/build) instead of hardcoded plan
      // - Shared sections (Step Narration, Final Summary, Plan Generation, Code Exploration)
      //   extracted into base prompt to eliminate ~800 tokens of duplication
      // - Plan block format now includes a concrete example
      // - MCP tool names use full mcp__code-graph__* format for consistency
      const newPlanPrompt = DEFAULT_PROMPTS['da-vinci'].plan
      const newBuildPrompt = DEFAULT_PROMPTS['da-vinci'].build

      // Update plan prompt
      db.prepare(
        `
        UPDATE core_agent_prompts
        SET default_prompt_text = ?,
            prompt_text = CASE WHEN is_custom = 0 THEN ? ELSE prompt_text END,
            updated_at = datetime('now')
        WHERE agent_role = 'generalist' AND mode = 'plan'
      `
      ).run(newPlanPrompt, newPlanPrompt)

      // Update build prompt
      db.prepare(
        `
        UPDATE core_agent_prompts
        SET default_prompt_text = ?,
            prompt_text = CASE WHEN is_custom = 0 THEN ? ELSE prompt_text END,
            updated_at = datetime('now')
        WHERE agent_role = 'generalist' AND mode = 'build'
      `
      ).run(newBuildPrompt, newBuildPrompt)
    }
  },
  {
    version: 53,
    name: 'update-plan-mode-prompt-v2',
    up: (db) => {
      // Sync updated plan-mode prompt with strengthened plan quality requirements,
      // depth expectations, and unified card button labels (Build Now / Orchestrated Build / etc.)
      const newPlanPrompt = DEFAULT_PROMPTS['da-vinci'].plan

      db.prepare(
        `
        UPDATE core_agent_prompts
        SET default_prompt_text = ?,
            prompt_text = CASE WHEN is_custom = 0 THEN ? ELSE prompt_text END,
            updated_at = datetime('now')
        WHERE agent_role = 'generalist' AND mode = 'plan'
      `
      ).run(newPlanPrompt, newPlanPrompt)
    }
  },
  {
    version: 54,
    name: 'reinforce-plan-block-format-v3',
    up: (db) => {
      // Sync updated plan-mode prompt with reinforced plan-block format instructions:
      // - Reordered base prompt (plan format at end for recency bias)
      // - Added FINAL RULE closing reinforcement to plan-mode section
      const newPlanPrompt = DEFAULT_PROMPTS['da-vinci'].plan

      db.prepare(
        `
        UPDATE core_agent_prompts
        SET default_prompt_text = ?,
            prompt_text = CASE WHEN is_custom = 0 THEN ? ELSE prompt_text END,
            updated_at = datetime('now')
        WHERE agent_role = 'generalist' AND mode = 'plan'
      `
      ).run(newPlanPrompt, newPlanPrompt)
    }
  },
  {
    version: 55,
    name: 'generalist-only-plan-generation',
    up: (db) => {
      // Enforce generalist-only plan generation: plan-mode handoffs are now blocked,
      // plan-mode prompt explicitly forbids handoff, build-mode prompt adds plan-generation rule,
      // specialist prompts no longer have plan-card instructions.
      const newPlanPrompt = DEFAULT_PROMPTS['da-vinci'].plan
      const newBuildPrompt = DEFAULT_PROMPTS['da-vinci'].build

      // Update plan mode prompt
      db.prepare(
        `
        UPDATE core_agent_prompts
        SET default_prompt_text = ?,
            prompt_text = CASE WHEN is_custom = 0 THEN ? ELSE prompt_text END,
            updated_at = datetime('now')
        WHERE agent_role = 'generalist' AND mode = 'plan'
      `
      ).run(newPlanPrompt, newPlanPrompt)

      // Update build mode prompt
      db.prepare(
        `
        UPDATE core_agent_prompts
        SET default_prompt_text = ?,
            prompt_text = CASE WHEN is_custom = 0 THEN ? ELSE prompt_text END,
            updated_at = datetime('now')
        WHERE agent_role = 'generalist' AND mode = 'build'
      `
      ).run(newBuildPrompt, newBuildPrompt)
    }
  },
  {
    version: 56,
    name: 'simplify-plan-build-prompts',
    up: (db) => {
      // Deduplicate plan enforcement: trimmed GENERALIST_PLAN_MODE_SECTION,
      // removed redundant anti-handoff line from base prompt. ~295 tokens saved per turn.
      const newPlanPrompt = DEFAULT_PROMPTS['da-vinci'].plan

      db.prepare(
        `
        UPDATE core_agent_prompts
        SET default_prompt_text = ?,
            prompt_text = CASE WHEN is_custom = 0 THEN ? ELSE prompt_text END,
            updated_at = datetime('now')
        WHERE agent_role = 'generalist' AND mode = 'plan'
      `
      ).run(newPlanPrompt, newPlanPrompt)
    }
  },
  {
    version: 57,
    name: 'control-tools-prompt-update',
    up: (db) => {
      // Updated prompts: plan format instructions replaced with control tool guidance,
      // anti-handoff prompts removed (tool availability enforces mode constraints).
      const newPlanPrompt = DEFAULT_PROMPTS['da-vinci'].plan
      const newBuildPrompt = DEFAULT_PROMPTS['da-vinci'].build

      db.prepare(
        `
        UPDATE core_agent_prompts
        SET default_prompt_text = ?,
            prompt_text = CASE WHEN is_custom = 0 THEN ? ELSE prompt_text END,
            updated_at = datetime('now')
        WHERE agent_role = 'generalist' AND mode = 'plan'
      `
      ).run(newPlanPrompt, newPlanPrompt)

      db.prepare(
        `
        UPDATE core_agent_prompts
        SET default_prompt_text = ?,
            prompt_text = CASE WHEN is_custom = 0 THEN ? ELSE prompt_text END,
            updated_at = datetime('now')
        WHERE agent_role = 'generalist' AND mode = 'build'
      `
      ).run(newBuildPrompt, newBuildPrompt)
    }
  },
  {
    version: 58,
    name: 'add-parent-message-id-for-turn-bubbles',
    up: (db) => {
      db.exec(`
        ALTER TABLE messages ADD COLUMN parent_message_id TEXT REFERENCES messages(id);
        CREATE INDEX idx_messages_parent ON messages(parent_message_id);
      `)
    }
  },
  {
    version: 59,
    name: 'add-skill-tier-columns',
    up: (db) => {
      db.exec(`
        ALTER TABLE skills ADD COLUMN tier1_json TEXT;
        ALTER TABLE skills ADD COLUMN tier2_instructions TEXT;
      `)
    }
  },
  {
    version: 60,
    name: 'backfill-skill-tiers',
    up: (db) => {
      // Backfill tier1_json and tier2_instructions for existing skills
      // tier1_json: JSON with name, description, and activation keywords
      // tier2_instructions: extracted from summaries or description
      const rows = db
        .prepare('SELECT id, name, description, summary_standard, summary_minimal FROM skills')
        .all() as Array<{
        id: string
        name: string
        description: string | null
        summary_standard: string | null
        summary_minimal: string | null
      }>

      const updateStmt = db.prepare(
        'UPDATE skills SET tier1_json = ?, tier2_instructions = ? WHERE id = ?'
      )

      for (const row of rows) {
        // Derive keywords from name: split on spaces/hyphens, filter short words
        const keywords = (row.name || '')
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, '')
          .split(/[\s-]+/)
          .filter((w: string) => w.length > 2)

        const tier1 = JSON.stringify({
          name: row.name,
          description: (row.description || '').substring(0, 200),
          keywords
        })

        // Prefer summary_standard as tier2, fallback to summary_minimal or description
        const tier2 = row.summary_standard || row.summary_minimal || row.description || ''

        updateStmt.run(tier1, tier2, row.id)
      }
    }
  },
  {
    version: 61,
    name: 'add-bug-council-sessions-table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS bug_council_sessions (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          task_description TEXT NOT NULL,
          failure_history_json TEXT NOT NULL DEFAULT '[]',
          perspectives_json TEXT NOT NULL DEFAULT '[]',
          synthesized_solution TEXT,
          risk_assessment TEXT,
          final_attempt_succeeded INTEGER,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'analyzing', 'synthesizing', 'complete', 'failed')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_bug_council_conversation ON bug_council_sessions(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_bug_council_task ON bug_council_sessions(task_id);
      `)
    }
  },
  {
    version: 62,
    name: 'add-persona-specialist-id-to-conversations',
    up: (db) => {
      db.exec(`
        ALTER TABLE conversations
        ADD COLUMN persona_specialist_id TEXT DEFAULT NULL
        REFERENCES specialists(id) ON DELETE SET NULL
      `)
    }
  },
  {
    version: 63,
    name: 'remove-lingering-orchestrator-specialist',
    up: (db) => {
      db.exec(`DELETE FROM specialists WHERE agent_id = 'orchestrator'`)
    }
  },
  {
    version: 64,
    name: 'ensure-agent-session-token-columns',
    up: (db) => {
      // Safety net: re-add granular token columns if migration v37 was skipped or partially applied.
      // Each ALTER is wrapped individually so "duplicate column" errors are caught per-column.
      const columns = [
        'input_tokens',
        'output_tokens',
        'cache_read_tokens',
        'cache_creation_tokens'
      ]
      for (const col of columns) {
        try {
          db.exec(`ALTER TABLE agent_sessions ADD COLUMN ${col} INTEGER DEFAULT 0`)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (!msg.includes('duplicate column name')) throw e
          // Column already exists — safe to skip
        }
      }
    }
  },
  {
    version: 65,
    name: 'create-bugs-table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS bugs (
          id TEXT PRIMARY KEY,
          fingerprint TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          process TEXT NOT NULL CHECK(process IN ('main', 'renderer', 'preload')),
          severity TEXT NOT NULL DEFAULT 'error' CHECK(severity IN ('error', 'fatal')),
          error_message TEXT NOT NULL,
          stack_trace TEXT,
          source_file TEXT,
          source_line INTEGER,
          source_column INTEGER,
          component_name TEXT,
          active_view TEXT,
          workspace_id TEXT,
          agent_id TEXT,
          app_version TEXT NOT NULL,
          os_info TEXT,
          is_resolved INTEGER NOT NULL DEFAULT 0,
          occurrence_count INTEGER NOT NULL DEFAULT 1,
          note TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_bugs_fingerprint ON bugs(fingerprint);
        CREATE INDEX IF NOT EXISTS idx_bugs_is_resolved ON bugs(is_resolved);
        CREATE INDEX IF NOT EXISTS idx_bugs_process ON bugs(process);
        CREATE INDEX IF NOT EXISTS idx_bugs_workspace_id ON bugs(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_bugs_last_seen_at ON bugs(last_seen_at);
      `)
    }
  },
  {
    version: 66,
    name: 'project-specialist-architecture',
    up: (db) => {
      runProjectSpecialistMigration(db)
    }
  },
  {
    version: 67,
    name: 'drop-specialist-pixel-columns',
    up: (db) => {
      // SQLite ≥3.35 supports ALTER TABLE … DROP COLUMN (bundled with better-sqlite3).
      // Uses try/catch guards so re-running on schemas where the columns are
      // already missing (e.g. dev databases predating this code) stays idempotent.
      try {
        db.exec('ALTER TABLE specialists DROP COLUMN pixel_sprite_id')
      } catch (err) {
        dbLogger.warn(`Skipping DROP COLUMN pixel_sprite_id: ${(err as Error).message}`)
      }
      try {
        db.exec('ALTER TABLE specialists DROP COLUMN use_pixel_for_chat')
      } catch (err) {
        dbLogger.warn(`Skipping DROP COLUMN use_pixel_for_chat: ${(err as Error).message}`)
      }
    }
  },
  {
    version: 68,
    name: 'drop-orphan-tables-from-removed-specialist-pool',
    up: (db) => {
      // Drop tables backing services deleted in the Phase 4 cleanup:
      //   - agent_messages — inter-agent message bus (deleted)
      //   - agent_context — per-conversation agent context cache (deleted)
      //   - gate_results — quality gate outcomes (deleted)
      //   - specialist_conversation_history — activation timeline (deleted)
      //   - agent_worktrees — per-specialist git worktrees (deleted)
      //
      // Also drop two conversation_specialists columns no longer referenced:
      //   - skill_overrides — per-conversation skill override list
      //   - skills_enabled — boolean gate for conversation-level skill gating
      //
      // All drops are guarded so re-runs or partial states don't fail.
      const dropTable = (name: string): void => {
        try {
          db.exec(`DROP TABLE IF EXISTS ${name}`)
          dbLogger.info(`✓ Dropped table ${name}`)
        } catch (err) {
          dbLogger.warn(`Skipping DROP TABLE ${name}: ${(err as Error).message}`)
        }
      }

      dropTable('agent_messages')
      dropTable('agent_context')
      dropTable('gate_results')
      dropTable('specialist_conversation_history')
      dropTable('agent_worktrees')

      const dropColumn = (table: string, column: string): void => {
        try {
          db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
          dbLogger.info(`✓ Dropped column ${table}.${column}`)
        } catch (err) {
          dbLogger.warn(`Skipping DROP COLUMN ${table}.${column}: ${(err as Error).message}`)
        }
      }

      dropColumn('conversation_specialists', 'skill_overrides')
      dropColumn('conversation_specialists', 'skills_enabled')
    }
  },
  {
    version: 69,
    name: 'layer-2-rename-generalist-to-da-vinci',
    up: (db) => {
      // Layer 2 DB rename (see Phase 4d in docs/architecture/project-specialist-refactor.md).
      //
      // Renames every persisted occurrence of `'generalist'` to `'da-vinci'`:
      //   1. messages.role: rebuild the table with the new CHECK constraint
      //      (SQLite can't ALTER a CHECK in place) and rewrite rows.
      //   2. specialists.agent_id = 'generalist' → 'da-vinci' (single row).
      //   3. core_agent_aliases.agent_role: rebuild with new CHECK, drop
      //      'coordinator' (dead role), rename 'generalist' → 'da-vinci'.
      //   4. core_agent_prompts.agent_role: same pattern.
      //   5. ModelAction keys in workspace settings JSON (modelOverrides):
      //      rename keys 'generalist*' → 'da-vinci*' for every workspace.
      //
      // All steps are idempotent — re-running on already-migrated rows is a no-op.
      dbLogger.info('[migration-69] Starting Layer 2 rename generalist → da-vinci')

      // ── 1. messages.role ──
      // Rebuild the table first with a permissive CHECK that accepts BOTH old + new
      // values, THEN rewrite rows. Otherwise the UPDATE would trip the old CHECK
      // that doesn't yet include 'da-vinci'.
      const messageRoleCheck = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'`)
        .get() as { sql: string } | undefined
      if (messageRoleCheck && !messageRoleCheck.sql.includes("'da-vinci'")) {
        // Transitional CHECK includes all legacy values so existing rows copy in.
        db.exec(`
          CREATE TABLE messages_new (
            id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK (role IN ('user', 'specialist', 'da-vinci', 'generalist', 'coordinator')),
            agent_id TEXT,
            content_md TEXT NOT NULL,
            attachments_json TEXT DEFAULT '[]',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            parent_message_id TEXT REFERENCES messages_new(id)
          );
          INSERT INTO messages_new SELECT * FROM messages;
          DROP TABLE messages;
          ALTER TABLE messages_new RENAME TO messages;
          CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
          CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_message_id);
        `)
        dbLogger.info('[migration-69] ✓ messages.role CHECK rebuilt (transitional)')
      }
      // Now rewrite rows under the transitional CHECK.
      db.exec(`UPDATE messages SET role = 'da-vinci' WHERE role = 'generalist'`)
      db.exec(`UPDATE messages SET role = 'specialist' WHERE role = 'coordinator'`)

      // ── 2. specialists.agent_id ──
      db.exec(`UPDATE specialists SET agent_id = 'da-vinci' WHERE agent_id = 'generalist'`)
      dbLogger.info('[migration-69] ✓ specialists.agent_id renamed')

      // ── 3. core_agent_aliases.agent_role ──
      // Same pattern: rebuild with permissive CHECK accepting both values, delete
      // dead 'coordinator' rows, then rewrite 'generalist' → 'da-vinci'.
      const aliasCheck = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='core_agent_aliases'`)
        .get() as { sql: string } | undefined
      if (aliasCheck && !aliasCheck.sql.includes("'da-vinci'")) {
        db.exec(`
          CREATE TABLE core_agent_aliases_new (
            agent_role TEXT PRIMARY KEY CHECK (agent_role IN ('da-vinci', 'generalist')),
            alias TEXT,
            avatar_key TEXT,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO core_agent_aliases_new
            SELECT agent_role, alias, avatar_key, updated_at
              FROM core_agent_aliases
             WHERE agent_role != 'coordinator';
          DROP TABLE core_agent_aliases;
          ALTER TABLE core_agent_aliases_new RENAME TO core_agent_aliases;
        `)
        dbLogger.info('[migration-69] ✓ core_agent_aliases CHECK rebuilt (permissive)')
      }
      db.exec(
        `UPDATE core_agent_aliases SET agent_role = 'da-vinci' WHERE agent_role = 'generalist'`
      )

      // ── 4. core_agent_prompts.agent_role ──
      // Same permissive-rebuild-first pattern.
      const promptCheck = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='core_agent_prompts'`)
        .get() as { sql: string } | undefined
      if (promptCheck && !promptCheck.sql.includes("'da-vinci'")) {
        // Preserve existing columns (some older schemas may or may not have default_prompt_text).
        const existingCols = (
          db.prepare(`PRAGMA table_info(core_agent_prompts)`).all() as Array<{
            name: string
          }>
        ).map((c) => c.name)
        const hasDefault = existingCols.includes('default_prompt_text')

        db.exec(
          `CREATE TABLE core_agent_prompts_new (
            id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
            agent_role TEXT NOT NULL CHECK (agent_role IN ('da-vinci', 'generalist')),
            mode TEXT NOT NULL CHECK (mode IN ('plan', 'build')),
            prompt_text TEXT NOT NULL,
            ${hasDefault ? 'default_prompt_text TEXT NOT NULL,' : ''}
            is_custom INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(agent_role, mode)
          )`
        )
        const cols = existingCols.join(', ')
        db.exec(
          `INSERT INTO core_agent_prompts_new (${cols}) SELECT ${cols} FROM core_agent_prompts;`
        )
        db.exec(`DROP TABLE core_agent_prompts`)
        db.exec(`ALTER TABLE core_agent_prompts_new RENAME TO core_agent_prompts`)
        dbLogger.info('[migration-69] ✓ core_agent_prompts CHECK rebuilt (permissive)')
      }
      db.exec(
        `UPDATE core_agent_prompts SET agent_role = 'da-vinci' WHERE agent_role = 'generalist'`
      )

      // ── 5. ModelAction keys in workspace settings JSON ──
      const workspaces = db.prepare(`SELECT id, settings_json FROM workspaces`).all() as Array<{
        id: string
        settings_json: string
      }>

      const updateSettings = db.prepare(`UPDATE workspaces SET settings_json = ? WHERE id = ?`)
      for (const ws of workspaces) {
        try {
          const parsed = JSON.parse(ws.settings_json || '{}') as {
            modelOverrides?: Record<string, string>
          }
          if (!parsed.modelOverrides) continue

          let changed = false
          const next: Record<string, string> = {}
          for (const [key, val] of Object.entries(parsed.modelOverrides)) {
            if (key === 'generalist') {
              next['da-vinci'] = val
              changed = true
            } else if (key.startsWith('generalist:')) {
              next[`da-vinci:${key.slice('generalist:'.length)}`] = val
              changed = true
            } else {
              next[key] = val
            }
          }
          if (changed) {
            parsed.modelOverrides = next
            updateSettings.run(JSON.stringify(parsed), ws.id)
          }
        } catch (err) {
          dbLogger.warn(
            `[migration-69] Could not migrate workspace ${ws.id} modelOverrides: ${(err as Error).message}`
          )
        }
      }
      dbLogger.info(
        `[migration-69] ✓ Walked ${workspaces.length} workspaces for modelOverrides rename`
      )

      dbLogger.info('[migration-69] ✓ Layer 2 rename complete')
    }
  },
  {
    version: 70,
    name: 'tighten-check-constraints-post-rename',
    up: (db) => {
      // Phase 5c — now that migration 69 has moved all rows to 'da-vinci',
      // tighten every CHECK constraint that still admits the transitional
      // legacy values. Uses the same rebuild-and-copy pattern as migration 69
      // because SQLite can't ALTER an existing CHECK in place.
      dbLogger.info('[migration-70] Tightening CHECK constraints post Layer 2 rename')

      // Defensive second pass — if anything slipped through migration 69 we
      // still want the INSERT into the new table to succeed.
      db.exec(`UPDATE messages SET role = 'da-vinci' WHERE role IN ('generalist', 'coordinator')`)
      db.exec(
        `UPDATE core_agent_aliases SET agent_role = 'da-vinci' WHERE agent_role IN ('generalist', 'coordinator')`
      )
      db.exec(
        `UPDATE core_agent_prompts SET agent_role = 'da-vinci' WHERE agent_role IN ('generalist', 'coordinator')`
      )

      // ── 1. messages.role → tight CHECK (user | specialist | da-vinci) ──
      const messagesCheck = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'`)
        .get() as { sql: string } | undefined
      if (messagesCheck && messagesCheck.sql.includes("'generalist'")) {
        db.exec(`
          CREATE TABLE messages_new (
            id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK (role IN ('user', 'specialist', 'da-vinci')),
            agent_id TEXT,
            content_md TEXT NOT NULL,
            attachments_json TEXT DEFAULT '[]',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            parent_message_id TEXT REFERENCES messages_new(id),
            tool_activities_json TEXT DEFAULT NULL
          );
          INSERT INTO messages_new SELECT * FROM messages;
          DROP TABLE messages;
          ALTER TABLE messages_new RENAME TO messages;
          CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
          CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_message_id);
        `)
        dbLogger.info('[migration-70] ✓ messages.role CHECK tightened')
      }

      // ── 2. core_agent_aliases.agent_role → tight CHECK (da-vinci only) ──
      const aliasCheck = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='core_agent_aliases'`)
        .get() as { sql: string } | undefined
      if (aliasCheck && aliasCheck.sql.includes("'generalist'")) {
        db.exec(`
          CREATE TABLE core_agent_aliases_new (
            agent_role TEXT PRIMARY KEY CHECK (agent_role IN ('da-vinci')),
            alias TEXT,
            avatar_key TEXT,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO core_agent_aliases_new SELECT * FROM core_agent_aliases;
          DROP TABLE core_agent_aliases;
          ALTER TABLE core_agent_aliases_new RENAME TO core_agent_aliases;
        `)
        dbLogger.info('[migration-70] ✓ core_agent_aliases.agent_role CHECK tightened')
      }

      // ── 3. core_agent_prompts.agent_role → tight CHECK (da-vinci only) ──
      const promptCheck = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='core_agent_prompts'`)
        .get() as { sql: string } | undefined
      if (promptCheck && promptCheck.sql.includes("'generalist'")) {
        const existingCols = (
          db.prepare(`PRAGMA table_info(core_agent_prompts)`).all() as Array<{ name: string }>
        ).map((c) => c.name)
        const hasDefault = existingCols.includes('default_prompt_text')

        db.exec(
          `CREATE TABLE core_agent_prompts_new (
            id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
            agent_role TEXT NOT NULL CHECK (agent_role IN ('da-vinci')),
            mode TEXT NOT NULL CHECK (mode IN ('plan', 'build')),
            prompt_text TEXT NOT NULL,
            ${hasDefault ? 'default_prompt_text TEXT NOT NULL,' : ''}
            is_custom INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(agent_role, mode)
          )`
        )
        const cols = existingCols.join(', ')
        db.exec(
          `INSERT INTO core_agent_prompts_new (${cols}) SELECT ${cols} FROM core_agent_prompts;`
        )
        db.exec(`DROP TABLE core_agent_prompts`)
        db.exec(`ALTER TABLE core_agent_prompts_new RENAME TO core_agent_prompts`)
        dbLogger.info('[migration-70] ✓ core_agent_prompts.agent_role CHECK tightened')
      }

      dbLogger.info('[migration-70] ✓ CHECK constraints tightened')
    }
  },
  {
    version: 71,
    name: 'davinci-solo-developer-prompt-redesign',
    up: (db) => {
      // DaVinci prompt redesign: strip all handoff content, rewrite as pure
      // Solo Developer, add specialist-swap proposal instructions.
      // Only overwrite prompt_text for uncustomized rows (is_custom = 0).
      // Users with customized prompts keep their text and get the updated
      // default_prompt_text so they can diff in the settings UI.
      const newPlanPrompt = DEFAULT_PROMPTS['da-vinci'].plan
      const newBuildPrompt = DEFAULT_PROMPTS['da-vinci'].build

      db.prepare(
        `
        UPDATE core_agent_prompts
        SET default_prompt_text = ?,
            prompt_text = CASE WHEN is_custom = 0 THEN ? ELSE prompt_text END,
            updated_at = datetime('now')
        WHERE agent_role = 'da-vinci' AND mode = 'plan'
      `
      ).run(newPlanPrompt, newPlanPrompt)

      db.prepare(
        `
        UPDATE core_agent_prompts
        SET default_prompt_text = ?,
            prompt_text = CASE WHEN is_custom = 0 THEN ? ELSE prompt_text END,
            updated_at = datetime('now')
        WHERE agent_role = 'da-vinci' AND mode = 'build'
      `
      ).run(newBuildPrompt, newBuildPrompt)

      dbLogger.info(
        '[migration-71] ✓ DaVinci plan + build prompts refreshed (solo-developer redesign)'
      )
    }
  },
  {
    version: 72,
    name: 'drop-specialist-mcp-columns',
    up: (db) => {
      runDropSpecialistMcpColumnsMigration(db)
    }
  },
  {
    version: 73,
    name: 'davinci-tool-error-handling-guidance',
    up: (db) => {
      // Adds the "Tool Error Handling" section to DaVinci's build prompt so
      // the model stops misdiagnosing `<tool_use_error>File has been modified
      // since read…` as a sandbox/permission issue. Only overwrites
      // uncustomized rows; customized rows just get the new
      // default_prompt_text so users can diff in the settings UI.
      const newPlanPrompt = DEFAULT_PROMPTS['da-vinci'].plan
      const newBuildPrompt = DEFAULT_PROMPTS['da-vinci'].build

      db.prepare(
        `
        UPDATE core_agent_prompts
        SET default_prompt_text = ?,
            prompt_text = CASE WHEN is_custom = 0 THEN ? ELSE prompt_text END,
            updated_at = datetime('now')
        WHERE agent_role = 'da-vinci' AND mode = 'plan'
      `
      ).run(newPlanPrompt, newPlanPrompt)

      db.prepare(
        `
        UPDATE core_agent_prompts
        SET default_prompt_text = ?,
            prompt_text = CASE WHEN is_custom = 0 THEN ? ELSE prompt_text END,
            updated_at = datetime('now')
        WHERE agent_role = 'da-vinci' AND mode = 'build'
      `
      ).run(newBuildPrompt, newBuildPrompt)

      dbLogger.info('[migration-73] ✓ DaVinci prompts refreshed with tool-error guidance')
    }
  },
  {
    version: 74,
    name: 'add-skill-enrichment-columns',
    up: (db) => {
      // Stage 1: per-skill enrichment metadata (generated by Haiku on import)
      try {
        db.exec(`ALTER TABLE skills ADD COLUMN enrichment_json TEXT DEFAULT NULL`)
      } catch {
        /* column may exist */
      }

      // Stage 2: per-specialist cached skill recommendations
      try {
        db.exec(`ALTER TABLE specialists ADD COLUMN skill_recommendations_json TEXT DEFAULT NULL`)
      } catch {
        /* column may exist */
      }
      try {
        db.exec(`ALTER TABLE specialists ADD COLUMN skill_recommendations_hash TEXT DEFAULT NULL`)
      } catch {
        /* column may exist */
      }

      dbLogger.info('[migration-74] ✓ Skill enrichment + recommendation columns added')
    }
  },
  {
    version: 75,
    name: 'sync-plan-prompt-enriched-fields',
    up: (db) => {
      // Sync plan-mode prompt with enriched plan fields: type classification,
      // phased plans, verification criteria, root causes, and mermaid guidance.
      const newPlanPrompt = DEFAULT_PROMPTS['da-vinci'].plan

      db.prepare(
        `
        UPDATE core_agent_prompts
        SET default_prompt_text = ?,
            prompt_text = CASE WHEN is_custom = 0 THEN ? ELSE prompt_text END,
            updated_at = datetime('now')
        WHERE agent_role = 'da-vinci' AND mode = 'plan'
      `
      ).run(newPlanPrompt, newPlanPrompt)

      dbLogger.info(
        '[migration-75] ✓ Plan prompt updated with type selection, phases, verification, and diagram guidance'
      )
    }
  },
  {
    version: 76,
    name: 'drop-dream-runs-table',
    up: (db) => {
      db.exec(`DROP TABLE IF EXISTS dream_runs;`)
      dbLogger.info('[migration-76] ✓ Dropped dream_runs table')
    }
  },
  {
    version: 77,
    name: 'add-audit-health-tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_runs (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          mode TEXT NOT NULL DEFAULT 'light' CHECK (mode IN ('light', 'deep')),
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'running', 'completed', 'partial', 'cancelled')),
          overall_score INTEGER,
          selected_tracks TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(selected_tracks)),
          detected_techs TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(detected_techs)),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_runs_workspace
          ON audit_runs(workspace_id);

        CREATE TABLE IF NOT EXISTS audit_results (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          audit_run_id TEXT NOT NULL REFERENCES audit_runs(id) ON DELETE CASCADE,
          track_id TEXT NOT NULL,
          score INTEGER,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
          findings TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(findings)),
          summary TEXT DEFAULT '',
          skills_used TEXT DEFAULT '[]' CHECK (json_valid(skills_used)),
          started_at TEXT,
          completed_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_audit_results_run ON audit_results(audit_run_id);
      `)
      dbLogger.info('[migration-77] ✓ Created audit_runs + audit_results tables')
    }
  },
  {
    version: 78,
    name: 'add-llm-provider-to-conversations',
    up: (db) => {
      db.exec(
        `ALTER TABLE conversations ADD COLUMN llm_provider TEXT NOT NULL DEFAULT 'claude' CHECK (llm_provider IN ('claude', 'local-llm'))`
      )
      dbLogger.info('[migration-78] ✓ Added llm_provider column to conversations')
    }
  },
  {
    version: 79,
    name: 'fix-audit-runs-unique-index',
    up: (db) => {
      db.exec(`DROP INDEX IF EXISTS idx_audit_runs_workspace`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_runs_workspace ON audit_runs(workspace_id)`)
      dbLogger.info('[migration-79] ✓ Replaced UNIQUE index on audit_runs with non-unique index')
    }
  },
  {
    version: 80,
    name: 'create-grill-sessions-table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS grill_sessions (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          track_id TEXT,
          status TEXT NOT NULL DEFAULT 'idle'
            CHECK (status IN ('idle', 'evaluating', 'awaiting_answers', 'completed', 'cancelled', 'failed')),
          current_score INTEGER,
          score_label TEXT,
          feedback TEXT,
          iteration_count INTEGER DEFAULT 0,
          messages TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(messages)),
          track_scores TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(track_scores)),
          history TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(history)),
          question_states TEXT DEFAULT NULL,
          current_iteration TEXT DEFAULT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_grill_sessions_idea ON grill_sessions(idea_id)`)
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_grill_sessions_workspace ON grill_sessions(workspace_id)`
      )
      dbLogger.info('[migration-80] ✓ Created grill_sessions table')
    }
  },
  {
    version: 81,
    name: 'add-audit-coverage-columns',
    up: (db) => {
      db.exec(`ALTER TABLE audit_results ADD COLUMN coverage_stats TEXT DEFAULT NULL`)
      db.exec(`ALTER TABLE audit_results ADD COLUMN coverage_sufficient INTEGER DEFAULT NULL`)
      dbLogger.info(
        '[migration-81] ✓ Added coverage_stats and coverage_sufficient columns to audit_results'
      )
    }
  },
  {
    version: 82,
    name: 'add-turn-usage-context-tokens',
    up: (db) => {
      // Store the SDK's context window total separately from the API-reported input_tokens.
      // Previously updateLastTurnTokens() overwrote input_tokens with the SDK context total
      // and zeroed out cache_read_tokens/cache_creation_tokens — destroying cache data.
      // This column stores the context window size without touching the original API values.
      db.exec(`ALTER TABLE turn_usage ADD COLUMN context_tokens INTEGER DEFAULT 0`)
      dbLogger.info('[migration-82] ✓ Added context_tokens column to turn_usage')
    }
  },
  {
    version: 83,
    name: 'clear-embeddings-for-model-migration',
    up: (db) => {
      // Embedding model changed from qwen3-embedding:4b (Ollama) to
      // nomic-embed-text-v1.5 (Transformers.js). Vectors from different
      // models are incompatible — clear all embeddings so workspaces
      // re-index with the new model on next use.
      db.exec('DELETE FROM chunk_embeddings')
      db.exec("UPDATE indexing_state SET status = 'idle', embedding_model = NULL")
      dbLogger.info('[migration-83] ✓ Cleared embeddings for model migration (qwen3→nomic-embed)')
    }
  },
  {
    version: 84,
    name: 'plan-mode-direct-answer-support',
    up: (db) => {
      // Sync updated PLAN_MODE_SECTION that distinguishes questions from plan requests.
      // Follows the same pattern as migrations 49, 53, 54, 55, 56, 71.
      const newPlanPrompt = DEFAULT_PROMPTS['da-vinci'].plan

      db.prepare(
        `
        UPDATE core_agent_prompts
        SET default_prompt_text = ?,
            prompt_text = CASE WHEN is_custom = 0 THEN ? ELSE prompt_text END,
            updated_at = datetime('now')
        WHERE agent_role = 'da-vinci' AND mode = 'plan'
        `
      ).run(newPlanPrompt, newPlanPrompt)

      dbLogger.info(
        '[migration-84] ✓ Updated plan-mode prompt to support direct answers for questions'
      )
    }
  },
  {
    version: 85,
    name: 'add-conversation-mcp-overrides',
    up: (db) => {
      db.exec(`ALTER TABLE conversations ADD COLUMN mcp_overrides_json TEXT DEFAULT '{}'`)
      dbLogger.info('[migration-85] ✓ Added mcp_overrides_json column to conversations')
    }
  },
  {
    version: 86,
    name: 'drop-conversation-file-changes',
    up: (db) => {
      db.exec('DROP TABLE IF EXISTS conversation_file_changes')
      db.exec('DROP INDEX IF EXISTS idx_file_changes_conversation')
      dbLogger.info(
        '[migration-86] ✓ Dropped conversation_file_changes table (replaced by pure git status)'
      )
    }
  },
  {
    version: 87,
    name: 'create-local-plan-state',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS local_plan_state (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          original_request TEXT NOT NULL,
          discovered_context TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(discovered_context)),
          plan_text TEXT DEFAULT '',
          status TEXT NOT NULL DEFAULT 'in_progress'
            CHECK(status IN ('in_progress', 'completed', 'abandoned')),
          continuation_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_plan_state_conv ON local_plan_state(conversation_id)`)
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_plan_state_ws ON local_plan_state(workspace_id, status)`
      )
      dbLogger.info('[migration-87] ✓ Created local_plan_state table for local LLM plan continuity')
    }
  },
  {
    version: 88,
    name: 'add-conversation-communication-tone',
    up: (db) => {
      db.exec(`ALTER TABLE conversations ADD COLUMN communication_tone TEXT DEFAULT NULL`)
      dbLogger.info(
        '[migration-88] ✓ Added communication_tone column to conversations (per-chat tone override)'
      )
    }
  },
  {
    version: 89,
    name: 'add-indexing-state-checkpoint-columns',
    up: (db) => {
      // Track embedding checkpoint offset for resume-after-crash.
      // preprocessed_chunks_json stores the serialized processedChunks array
      // so the embedding phase can resume from the checkpoint offset without
      // re-running the full preprocessing phase.
      db.exec(`ALTER TABLE indexing_state ADD COLUMN checkpoint_offset INTEGER NOT NULL DEFAULT 0`)
      db.exec(
        `ALTER TABLE indexing_state ADD COLUMN description_source TEXT NOT NULL DEFAULT 'none'`
      )
      dbLogger.info(
        '[migration-89] ✓ Added checkpoint_offset and description_source to indexing_state for resumable indexing'
      )
    }
  },
  {
    version: 90,
    name: 'add-chunk-descriptions-source',
    up: (db) => {
      // Track whether a description was generated by AI or heuristic engine.
      // Allows the background AI enrichment phase to selectively upgrade
      // heuristic descriptions without touching AI-generated ones.
      db.exec(`ALTER TABLE chunk_descriptions ADD COLUMN source TEXT NOT NULL DEFAULT 'ai'`)
      dbLogger.info('[migration-90] ✓ Added source column to chunk_descriptions (ai/heuristic)')
    }
  },
  {
    version: 91,
    name: 'add-conversation-effort',
    up: (db) => {
      db.exec(
        `ALTER TABLE conversations ADD COLUMN effort TEXT NOT NULL DEFAULT 'high' CHECK (effort IN ('low', 'medium', 'high'))`
      )
      dbLogger.info('[migration-91] ✓ Added effort column to conversations')
    }
  },
  {
    version: 92,
    name: 'add-danger-mode',
    up: (db) => {
      runAddDangerModeMigration(db)
    }
  },
  {
    version: 93,
    name: 'create-mpa-tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS mpa_runs (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
          grill_session_id TEXT,
          title TEXT NOT NULL,
          goal TEXT NOT NULL,
          goal_type TEXT NOT NULL DEFAULT 'feature'
            CHECK (goal_type IN ('feature', 'refactor', 'bugfix', 'tests')),
          status TEXT NOT NULL DEFAULT 'running'
            CHECK (status IN ('running', 'paused', 'completed', 'failed', 'cancelled')),
          current_phase TEXT,
          config_json TEXT DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT,
          total_tokens INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS mpa_phases (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          run_id TEXT NOT NULL REFERENCES mpa_runs(id) ON DELETE CASCADE,
          phase_type TEXT NOT NULL CHECK (phase_type IN ('plan', 'execute', 'verify')),
          iteration INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
          agent_role TEXT NOT NULL,
          goal_condition TEXT,
          input_artifact_id TEXT,
          output_artifact_id TEXT,
          started_at TEXT,
          completed_at TEXT,
          tokens_used INTEGER DEFAULT 0,
          stream_content TEXT DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS mpa_artifacts (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          run_id TEXT NOT NULL REFERENCES mpa_runs(id) ON DELETE CASCADE,
          phase_id TEXT REFERENCES mpa_phases(id) ON DELETE SET NULL,
          artifact_type TEXT NOT NULL
            CHECK (artifact_type IN ('plan', 'verify_report', 'goal_spec')),
          content_json TEXT NOT NULL,
          content_md TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_mpa_phases_run ON mpa_phases(run_id);
        CREATE INDEX IF NOT EXISTS idx_mpa_artifacts_run ON mpa_artifacts(run_id);
        CREATE INDEX IF NOT EXISTS idx_mpa_runs_workspace ON mpa_runs(workspace_id);
      `)
      dbLogger.info('[migration-93] ✓ Created mpa_runs, mpa_phases, mpa_artifacts tables')
    }
  },
  {
    version: 94,
    name: 'Add council_sessions table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS council_sessions (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
          input_type TEXT NOT NULL CHECK (input_type IN ('plan', 'requirement', 'question')),
          input_content TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running'
            CHECK (status IN ('running', 'completed', 'cancelled', 'failed')),
          verdict_json TEXT,
          transcript_md TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_council_sessions_workspace ON council_sessions(workspace_id);
      `)
      dbLogger.info('[migration-94] ✓ Created council_sessions table')
    }
  },
  {
    version: 95,
    name: 'add-plan-json-to-grill-sessions',
    up: (db) => {
      db.exec(`ALTER TABLE grill_sessions ADD COLUMN plan_json TEXT DEFAULT NULL`)
      dbLogger.info('[migration-95] ✓ Added plan_json column to grill_sessions')
    }
  },
  {
    version: 96,
    name: 'add-council-resume-columns',
    up: (db) => {
      db.exec(`
        ALTER TABLE council_sessions ADD COLUMN grill_session_id TEXT DEFAULT NULL;
        ALTER TABLE council_sessions ADD COLUMN structured_plan_json TEXT DEFAULT NULL;
        ALTER TABLE council_sessions ADD COLUMN advisor_reviews_json TEXT DEFAULT '[]';
        ALTER TABLE council_sessions ADD COLUMN peer_reviews_json TEXT DEFAULT '[]';
        ALTER TABLE council_sessions ADD COLUMN phase TEXT DEFAULT 'framing'
          CHECK (phase IN ('framing', 'deliberating', 'peer-review', 'synthesizing', 'complete', 'failed'));
        ALTER TABLE council_sessions ADD COLUMN completed_advisors TEXT DEFAULT '[]';
      `)
      dbLogger.info('[migration-96] ✓ Added resume columns to council_sessions')
    }
  },
  {
    version: 97,
    name: 'recover-persona-specialist-id',
    up: (db) => {
      db.exec(`
        ALTER TABLE conversations
        ADD COLUMN persona_specialist_id TEXT DEFAULT NULL
        REFERENCES specialists(id) ON DELETE SET NULL
      `)
      dbLogger.info('[migration-97] ✓ Recovered persona_specialist_id column')
    }
  },
  {
    version: 98,
    name: 'add-tool-activities-json-to-messages',
    up: (db) => {
      db.exec(`ALTER TABLE messages ADD COLUMN tool_activities_json TEXT DEFAULT NULL`)
      dbLogger.info('[migration-98] ✓ Added tool_activities_json to messages')
    }
  },
  {
    version: 99,
    name: 'add-selected-skills-to-audit-runs',
    up: (db) => {
      db.exec(
        `ALTER TABLE audit_runs ADD COLUMN selected_skills TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(selected_skills))`
      )
      dbLogger.info('[migration-99] ✓ Added selected_skills column to audit_runs')
    }
  },
  {
    version: 100,
    name: 'create-audit-plans-table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_plans (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          audit_run_id TEXT NOT NULL REFERENCES audit_runs(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
          source_finding_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_finding_ids)),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_audit_plans_run ON audit_plans(audit_run_id);
      `)
      dbLogger.info('[migration-100] ✓ Created audit_plans table')
    }
  },
  {
    version: 101,
    name: 'create-mpa-campaigns-table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS mpa_campaigns (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          original_plan_md TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'running'
            CHECK (status IN ('running', 'paused', 'completed', 'failed', 'cancelled')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT
        );

        ALTER TABLE mpa_runs ADD COLUMN campaign_id TEXT
          REFERENCES mpa_campaigns(id) ON DELETE CASCADE;
        ALTER TABLE mpa_runs ADD COLUMN order_index INTEGER;

        CREATE INDEX IF NOT EXISTS idx_mpa_campaigns_workspace ON mpa_campaigns(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_mpa_runs_campaign ON mpa_runs(campaign_id);
      `)
      dbLogger.info(
        '[migration-101] ✓ Created mpa_campaigns table + campaign_id/order_index on mpa_runs'
      )
    }
  },
  {
    version: 102,
    name: 'add-usage-log',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS usage_log (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          feature TEXT NOT NULL,
          agent_type TEXT,
          model TEXT,
          workspace_id TEXT,
          conversation_id TEXT,
          session_id TEXT,
          turn_number INTEGER,
          input_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          cache_read_tokens INTEGER DEFAULT 0,
          cache_creation_tokens INTEGER DEFAULT 0,
          cost_cents INTEGER DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_usage_log_workspace ON usage_log(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_usage_log_feature ON usage_log(feature);
        CREATE INDEX IF NOT EXISTS idx_usage_log_conversation ON usage_log(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_usage_log_created ON usage_log(created_at);
      `)
      dbLogger.info('[migration-102] ✓ Created usage_log table')
    }
  },
  {
    version: 103,
    name: 'create-blueprints-tables',
    up: (db) => {
      db.exec(`
        -- Blueprints: top-level entity for the structured specification pipeline
        CREATE TABLE IF NOT EXISTS blueprints (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          short_name TEXT NOT NULL DEFAULT '',
          description TEXT DEFAULT '',
          status TEXT NOT NULL DEFAULT 'draft'
            CHECK (status IN ('draft','specifying','clarifying','planning',
                               'tasking','reviewing','building','verifying',
                               'complete','failed','cancelled')),
          current_phase TEXT DEFAULT 'specify'
            CHECK (current_phase IN ('specify','clarify','plan','tasks',
                                      'review','build','verify')),
          priority TEXT DEFAULT 'P1'
            CHECK (priority IN ('P1','P2','P3')),
          source_idea_id TEXT REFERENCES ideas(id) ON DELETE SET NULL,
          constitution_snapshot TEXT,
          settings_json TEXT DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_blueprints_workspace ON blueprints(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_blueprints_status ON blueprints(status);

        -- Blueprint phases: each pipeline step gets its own record
        CREATE TABLE IF NOT EXISTS blueprint_phases (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          blueprint_id TEXT NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
          phase TEXT NOT NULL
            CHECK (phase IN ('specify','clarify','plan','tasks','review','build','verify')),
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','active','complete','skipped','failed')),
          conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
          artifacts_json TEXT DEFAULT '[]',
          context_snapshot TEXT,
          started_at TEXT,
          completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_bp_phases_blueprint ON blueprint_phases(blueprint_id);

        -- Blueprint tasks: parsed from tasks.md artifact, used for wave execution
        CREATE TABLE IF NOT EXISTS blueprint_tasks (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          blueprint_id TEXT NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL,
          wave INTEGER NOT NULL DEFAULT 1,
          user_story TEXT,
          description TEXT NOT NULL,
          file_paths_json TEXT DEFAULT '[]',
          is_parallel INTEGER NOT NULL DEFAULT 0,
          depends_on_json TEXT DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','running','complete','failed','skipped')),
          executor_run_id TEXT REFERENCES mpa_runs(id) ON DELETE SET NULL,
          started_at TEXT,
          completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_bp_tasks_blueprint ON blueprint_tasks(blueprint_id);
        CREATE INDEX IF NOT EXISTS idx_bp_tasks_wave ON blueprint_tasks(wave);

        -- Link mpa_runs to blueprints (BUILD/VERIFY phases reuse MPA)
        ALTER TABLE mpa_runs ADD COLUMN blueprint_id TEXT REFERENCES blueprints(id) ON DELETE SET NULL;
        ALTER TABLE mpa_runs ADD COLUMN blueprint_phase_id TEXT REFERENCES blueprint_phases(id) ON DELETE SET NULL;

        -- Workspace constitution storage
        ALTER TABLE workspaces ADD COLUMN constitution_md TEXT;
        ALTER TABLE workspaces ADD COLUMN constitution_version TEXT DEFAULT '1.0.0';
      `)
      dbLogger.info(
        '[migration-103] ✓ Created blueprints, blueprint_phases, blueprint_tasks tables + ALTER mpa_runs/workspaces'
      )
    }
  },

  // ── v104: Unified plan registry ──
  {
    version: 104,
    name: 'create-plans-table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS plans (
          id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          source        TEXT NOT NULL CHECK (source IN ('chat','grill','audit','council','mpa','blueprint')),
          source_id     TEXT NOT NULL,
          title         TEXT NOT NULL,
          summary       TEXT NOT NULL DEFAULT '',
          plan_type     TEXT DEFAULT NULL,
          structured_plan_json TEXT NOT NULL CHECK (json_valid(structured_plan_json)),
          source_plan_json     TEXT DEFAULT NULL,
          requirement_document TEXT DEFAULT NULL,
          status        TEXT NOT NULL DEFAULT 'saved'
            CHECK (status IN ('saved','handed_off','in_progress','completed','archived')),
          linked_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
          linked_mpa_run_id      TEXT REFERENCES mpa_runs(id) ON DELETE SET NULL,
          linked_council_session_id TEXT REFERENCES council_sessions(id) ON DELETE SET NULL,
          file_count    INTEGER DEFAULT 0,
          phase_count   INTEGER DEFAULT 0,
          risk_count    INTEGER DEFAULT 0,
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_plans_workspace ON plans(workspace_id, status);
        CREATE INDEX IF NOT EXISTS idx_plans_source ON plans(source, source_id);
        CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(workspace_id, status, updated_at DESC);
      `)
      dbLogger.info('[migration-104] ✓ Created plans table + indexes')
    }
  },

  // ── Migration 105: LLM Presets ──
  {
    version: 105,
    name: 'LLM presets table + conversation preset columns',
    up(database: Database.Database): void {
      database.exec(`
        CREATE TABLE IF NOT EXISTS llm_presets (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(12)))),
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          is_built_in INTEGER NOT NULL DEFAULT 0,
          action_config_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_llm_presets_workspace ON llm_presets(workspace_id);
      `)

      // Add preset_id and handoff_context columns to conversations
      try {
        database.exec(`ALTER TABLE conversations ADD COLUMN preset_id TEXT DEFAULT NULL`)
      } catch {
        /* column may already exist */
      }
      try {
        database.exec(`ALTER TABLE conversations ADD COLUMN handoff_context TEXT DEFAULT NULL`)
      } catch {
        /* column may already exist */
      }

      // Seed built-in presets for each existing workspace
      const workspaces = database.prepare('SELECT id FROM workspaces').all() as { id: string }[]
      const insertPreset = database.prepare(`
        INSERT OR IGNORE INTO llm_presets (id, workspace_id, name, is_built_in, action_config_json)
        VALUES (?, ?, ?, 1, ?)
      `)

      for (const ws of workspaces) {
        insertPreset.run(`${ws.id}_full-claude`, ws.id, 'Full Claude', '{}')
        insertPreset.run(`${ws.id}_full-local`, ws.id, 'Full Local', '{}')
      }

      // Migrate existing modelOverrides into a custom preset per workspace
      const wsWithSettings = database
        .prepare('SELECT id, settings_json FROM workspaces WHERE settings_json IS NOT NULL')
        .all() as { id: string; settings_json: string }[]

      for (const ws of wsWithSettings) {
        try {
          const settings = JSON.parse(ws.settings_json)
          if (settings.modelOverrides && Object.keys(settings.modelOverrides).length > 0) {
            const actionConfig: Record<string, { provider: string; modelId: string }> = {}
            for (const [action, modelId] of Object.entries(settings.modelOverrides)) {
              if (typeof modelId === 'string') {
                actionConfig[action] = { provider: 'claude', modelId }
              }
            }
            if (Object.keys(actionConfig).length > 0) {
              insertPreset.run(
                `${ws.id}_migrated`,
                ws.id,
                'Custom (migrated)',
                JSON.stringify(actionConfig)
              )
            }
          }
        } catch {
          /* non-fatal — skip malformed settings */
        }
      }

      dbLogger.info('[migration-105] ✓ Created llm_presets table + seeded built-in presets')
    }
  },

  // ── Migration 106: Library documentation cache ──
  {
    version: 106,
    name: 'create-library-docs-table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS library_docs (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id  TEXT NOT NULL,
          package_name  TEXT NOT NULL,
          version       TEXT NOT NULL DEFAULT '',
          section_index INTEGER NOT NULL DEFAULT 0,
          section_title TEXT NOT NULL DEFAULT '',
          section_content TEXT NOT NULL,
          source        TEXT NOT NULL CHECK (source IN ('node_modules', 'context7', 'npm_registry')),
          indexed_at    TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(workspace_id, package_name, section_index)
        );
        CREATE INDEX IF NOT EXISTS idx_library_docs_pkg
          ON library_docs(workspace_id, package_name);
        CREATE VIRTUAL TABLE IF NOT EXISTS library_docs_fts USING fts5(
          package_name, section_title, section_content,
          content=library_docs, content_rowid=id
        );
      `)
      dbLogger.info('[migration-106] ✓ Created library_docs table + FTS5 index')
    }
  },

  // ── Migration 107: Add 'skipped' to blueprint_tasks CHECK constraint ──
  // BP-TASK-CHECK-01: The CHECK constraint on blueprint_tasks.status was missing
  // 'skipped', causing SQLite CHECK constraint failures when the build service
  // tries to mark remaining tasks as 'skipped' after a task failure.
  {
    version: 107,
    name: 'fix-blueprint-tasks-skipped-status',
    up: (db) => {
      // SQLite cannot ALTER CHECK constraints — must rebuild the table
      db.exec(`
        CREATE TABLE blueprint_tasks_new (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          blueprint_id TEXT NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL,
          wave INTEGER NOT NULL DEFAULT 1,
          user_story TEXT,
          description TEXT NOT NULL,
          file_paths_json TEXT DEFAULT '[]',
          is_parallel INTEGER NOT NULL DEFAULT 0,
          depends_on_json TEXT DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','running','complete','failed','skipped')),
          executor_run_id TEXT REFERENCES mpa_runs(id) ON DELETE SET NULL,
          started_at TEXT,
          completed_at TEXT
        );
        INSERT INTO blueprint_tasks_new SELECT * FROM blueprint_tasks;
        DROP TABLE blueprint_tasks;
        ALTER TABLE blueprint_tasks_new RENAME TO blueprint_tasks;
        CREATE INDEX IF NOT EXISTS idx_bp_tasks_blueprint ON blueprint_tasks(blueprint_id);
        CREATE INDEX IF NOT EXISTS idx_bp_tasks_wave ON blueprint_tasks(wave);
      `)
      dbLogger.info('[migration-107] ✓ Added skipped to blueprint_tasks CHECK constraint')
    }
  },

  // ── Migration 108: Seed Claude model presets (Opus, Sonnet, Haiku) ──
  {
    version: 108,
    name: 'seed-claude-model-presets',
    up: (db) => {
      const workspaces = db.prepare('SELECT id FROM workspaces').all() as { id: string }[]
      const insert = db.prepare(`
        INSERT OR IGNORE INTO llm_presets (id, workspace_id, name, is_built_in, action_config_json)
        VALUES (?, ?, ?, 1, ?)
      `)

      // Chat-group actions overridden by model presets
      const chatActions = [
        'da-vinci',
        'da-vinci:plan',
        'da-vinci:build',
        'project-specialist',
        'project-specialist:plan',
        'project-specialist:build'
      ]
      function buildCfg(modelId: string): string {
        const cfg: Record<string, { provider: string; modelId: string }> = {}
        for (const a of chatActions) cfg[a] = { provider: 'claude', modelId }
        return JSON.stringify(cfg)
      }

      const presets = [
        { suffix: 'claude-opus', name: 'Claude Opus', modelId: 'claude-opus-4-8' },
        { suffix: 'claude-sonnet', name: 'Claude Sonnet', modelId: 'claude-sonnet-4-6' },
        { suffix: 'claude-haiku', name: 'Claude Haiku', modelId: 'claude-haiku-4-5-20251001' }
      ]

      for (const ws of workspaces) {
        for (const p of presets) {
          insert.run(`${ws.id}_${p.suffix}`, ws.id, p.name, buildCfg(p.modelId))
        }
      }
      dbLogger.info(
        `[migration-108] ✓ Seeded Claude model presets for ${workspaces.length} workspace(s)`
      )
    }
  },
  {
    version: 109,
    name: 'add-conversation-type-column',
    up: (db) => {
      db.exec(
        `ALTER TABLE conversations ADD COLUMN type TEXT NOT NULL DEFAULT 'chat' CHECK (type IN ('chat', 'blueprint'))`
      )
      dbLogger.info('[migration-109] ✓ Added type column to conversations')
    }
  },
  {
    version: 110,
    name: 'blueprint-events-journal',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS blueprint_events (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          blueprint_id TEXT NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('system','agent','user','findings','qa','plan','tasks')),
          payload_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_bp_events_blueprint ON blueprint_events(blueprint_id, seq);
      `)
      dbLogger.info('[migration-110] ✓ Created blueprint_events table + index')
    }
  },
  {
    version: 111,
    name: 'conversation-model-config-snapshot',
    up: (db) => {
      // Stores frozen model configuration at conversation creation time.
      // NULL → legacy live-resolution (permanent backward compat).
      // JSON contains resolved plan/build/background models + source provenance.
      db.exec(`ALTER TABLE conversations ADD COLUMN model_config_json TEXT DEFAULT NULL`)
      dbLogger.info('[migration-111] ✓ Added model_config_json column to conversations')
    }
  },
  {
    version: 112,
    name: 'knowledge-aware-memory-engine',
    up: (db) => {
      // ── memory_facts: core fact storage with embeddings + tiers ──
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_facts (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
          category TEXT NOT NULL CHECK (category IN ('decision','convention','gotcha','preference','reference')),
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
          scope_paths TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scope_paths)),
          tier INTEGER NOT NULL DEFAULT 0 CHECK (tier BETWEEN 0 AND 3),
          confidence REAL NOT NULL DEFAULT 0.5,
          confirmation_count INTEGER NOT NULL DEFAULT 0,
          last_confirmed_at TEXT,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','archived')),
          superseded_by TEXT,
          source_type TEXT NOT NULL CHECK (source_type IN ('session','commit','document','tool','manual')),
          source_ref TEXT,
          embedding BLOB,
          embedding_pending INTEGER NOT NULL DEFAULT 1,
          last_accessed_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_facts_workspace ON memory_facts(workspace_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_facts_status ON memory_facts(status)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_facts_category ON memory_facts(category)`)
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_memory_facts_tier ON memory_facts(tier DESC, confidence DESC)`
      )
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_memory_facts_embedding_pending ON memory_facts(embedding_pending) WHERE embedding_pending = 1`
      )
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_memory_facts_source ON memory_facts(source_type, source_ref)`
      )

      // ── memory_contradictions: audit trail for conflicting facts ──
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_contradictions (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          old_fact_id TEXT NOT NULL REFERENCES memory_facts(id),
          new_fact_id TEXT NOT NULL REFERENCES memory_facts(id),
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('auto_resolved','pending','user_resolved')),
          resolution TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          resolved_at TEXT
        )
      `)
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_memory_contradictions_status ON memory_contradictions(status)`
      )

      // ── memory_doc_state: content-hash gate for doc watcher ──
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_doc_state (
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          file_path TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          last_extracted_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (workspace_id, file_path)
        )
      `)

      // ── Drop legacy memories table (fresh start — decision #3) ──
      db.exec(`DROP TABLE IF EXISTS memories`)

      dbLogger.info(
        '[migration-112] ✓ Created memory_facts, memory_contradictions, memory_doc_state; dropped memories'
      )
    }
  },

  // ── v113: E2E testing tables ──
  {
    version: 113,
    name: 'e2e-testing-tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS e2e_test_runs (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'cancelled')),
          model_id TEXT,
          backend TEXT,
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          finished_at TEXT,
          total_passed INTEGER NOT NULL DEFAULT 0,
          total_failed INTEGER NOT NULL DEFAULT 0,
          total_skipped INTEGER NOT NULL DEFAULT 0,
          total_error INTEGER NOT NULL DEFAULT 0
        )
      `)
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_e2e_test_runs_workspace ON e2e_test_runs(workspace_id)`
      )
      db.exec(`CREATE INDEX IF NOT EXISTS idx_e2e_test_runs_status ON e2e_test_runs(status)`)

      db.exec(`
        CREATE TABLE IF NOT EXISTS e2e_test_results (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          run_id TEXT NOT NULL REFERENCES e2e_test_runs(id) ON DELETE CASCADE,
          scenario_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'passed', 'failed', 'skipped', 'error')),
          duration_ms INTEGER,
          failure_reason TEXT,
          assertion_results TEXT DEFAULT '[]',
          transcript_json TEXT DEFAULT '[]',
          conversation_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_e2e_test_results_run ON e2e_test_results(run_id)`)
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_e2e_test_results_scenario ON e2e_test_results(scenario_id)`
      )
      db.exec(`CREATE INDEX IF NOT EXISTS idx_e2e_test_results_status ON e2e_test_results(status)`)

      dbLogger.info('[migration-113] ✓ Created e2e_test_runs, e2e_test_results tables')
    }
  },

  // ── Migration 114: Upgrade Claude Sonnet preset from 4.6 → 5 + seed Fable 5 preset ──
  {
    version: 114,
    name: 'upgrade-sonnet-5-seed-fable-5-presets',
    up: (db) => {
      // 1. Update built-in Sonnet presets: swap claude-sonnet-4-6 → claude-sonnet-5 in action_config_json
      const sonnetPresets = db
        .prepare(
          `SELECT id, action_config_json FROM llm_presets WHERE is_built_in = 1 AND name = 'Claude Sonnet'`
        )
        .all() as { id: string; action_config_json: string }[]

      const updateStmt = db.prepare(
        `UPDATE llm_presets SET action_config_json = ?, updated_at = datetime('now') WHERE id = ?`
      )
      for (const preset of sonnetPresets) {
        const updatedJson = preset.action_config_json.replace(
          /claude-sonnet-4-6/g,
          'claude-sonnet-5'
        )
        updateStmt.run(updatedJson, preset.id)
      }

      // 2. Seed Fable 5 preset for each workspace (same chat-group actions as migration-108)
      const workspaces = db.prepare('SELECT id FROM workspaces').all() as { id: string }[]
      const chatActions = [
        'da-vinci',
        'da-vinci:plan',
        'da-vinci:build',
        'project-specialist',
        'project-specialist:plan',
        'project-specialist:build'
      ]
      const cfg: Record<string, { provider: string; modelId: string }> = {}
      for (const a of chatActions) cfg[a] = { provider: 'claude', modelId: 'claude-fable-5' }
      const fableJson = JSON.stringify(cfg)

      const insert = db.prepare(
        `INSERT OR IGNORE INTO llm_presets (id, workspace_id, name, is_built_in, action_config_json) VALUES (?, ?, ?, 1, ?)`
      )
      for (const ws of workspaces) {
        insert.run(`${ws.id}_claude-fable`, ws.id, 'Claude Fable', fableJson)
      }

      dbLogger.info(
        `[migration-114] ✓ Upgraded Sonnet presets to v5 + seeded Fable 5 for ${workspaces.length} workspace(s)`
      )
    }
  },

  // ── Migration 115: Extend memory_facts source_type CHECK for blueprint + grill ──
  {
    version: 115,
    name: 'memory-facts-blueprint-grill-source-types',
    up: (db) => {
      // Remove orphaned facts whose workspace was deleted before FK cascade existed.
      // Without this, the INSERT…SELECT below violates the FK on memory_facts_new.
      const purged = db
        .prepare(
          `DELETE FROM memory_facts
         WHERE workspace_id IS NOT NULL
           AND workspace_id NOT IN (SELECT id FROM workspaces)`
        )
        .run()
      if (purged.changes > 0)
        dbLogger.warn(`[migration-115] Purged ${purged.changes} orphaned memory_facts`)

      // SQLite cannot ALTER CHECK constraints — must rebuild the table.
      // Precedent: migration 107 (blueprint_tasks 'skipped' status).
      //
      // memory_contradictions has FK references to memory_facts(id), so we must
      // detach it before DROP TABLE memory_facts and recreate it after.
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_contradictions_bak AS
          SELECT * FROM memory_contradictions;
        DROP TABLE IF EXISTS memory_contradictions;
      `)

      db.exec(`
        CREATE TABLE memory_facts_new (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
          category TEXT NOT NULL CHECK (category IN ('decision','convention','gotcha','preference','reference')),
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
          scope_paths TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scope_paths)),
          tier INTEGER NOT NULL DEFAULT 0 CHECK (tier BETWEEN 0 AND 3),
          confidence REAL NOT NULL DEFAULT 0.5,
          confirmation_count INTEGER NOT NULL DEFAULT 0,
          last_confirmed_at TEXT,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','archived')),
          superseded_by TEXT,
          source_type TEXT NOT NULL CHECK (source_type IN ('session','commit','document','tool','manual','claude-md','blueprint','grill')),
          source_ref TEXT,
          embedding BLOB,
          embedding_pending INTEGER NOT NULL DEFAULT 1,
          last_accessed_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO memory_facts_new SELECT * FROM memory_facts;
        DROP TABLE memory_facts;
        ALTER TABLE memory_facts_new RENAME TO memory_facts;
        CREATE INDEX IF NOT EXISTS idx_memory_facts_workspace ON memory_facts(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_memory_facts_status ON memory_facts(status);
        CREATE INDEX IF NOT EXISTS idx_memory_facts_category ON memory_facts(category);
        CREATE INDEX IF NOT EXISTS idx_memory_facts_tier ON memory_facts(tier DESC, confidence DESC);
        CREATE INDEX IF NOT EXISTS idx_memory_facts_embedding_pending ON memory_facts(embedding_pending) WHERE embedding_pending = 1;
        CREATE INDEX IF NOT EXISTS idx_memory_facts_source ON memory_facts(source_type, source_ref);
      `)

      // Restore memory_contradictions with FK pointing at the rebuilt memory_facts
      db.exec(`
        CREATE TABLE memory_contradictions (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          old_fact_id TEXT NOT NULL REFERENCES memory_facts(id),
          new_fact_id TEXT NOT NULL REFERENCES memory_facts(id),
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('auto_resolved','pending','user_resolved')),
          resolution TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          resolved_at TEXT
        );
        INSERT INTO memory_contradictions
          SELECT * FROM memory_contradictions_bak
          WHERE old_fact_id IN (SELECT id FROM memory_facts)
            AND new_fact_id IN (SELECT id FROM memory_facts);
        DROP TABLE memory_contradictions_bak;
        CREATE INDEX IF NOT EXISTS idx_memory_contradictions_status ON memory_contradictions(status);
      `)
      dbLogger.info(
        '[migration-115] ✓ Extended memory_facts source_type CHECK to include blueprint + grill'
      )
    }
  },

  // ── Migration 116: Sync plan prompt with diagram styling + Lucide icon guidance ──
  {
    version: 116,
    name: 'sync-plan-prompt-diagram-styling',
    up: (db) => {
      const newPlanPrompt = DEFAULT_PROMPTS['da-vinci'].plan
      db.prepare(
        `
        UPDATE core_agent_prompts
        SET default_prompt_text = ?,
            prompt_text = CASE WHEN is_custom = 0 THEN ? ELSE prompt_text END,
            updated_at = datetime('now')
        WHERE agent_role = 'da-vinci' AND mode = 'plan'
      `
      ).run(newPlanPrompt, newPlanPrompt)
      dbLogger.info('[migration-116] ✓ Plan prompt updated with diagram styling + icon guidance')
    }
  },

  // ── Migration 117: Unify da-vinci → specialist ──
  // Rewrites all persisted 'da-vinci' role/agent references to 'specialist'.
  // The DaVinci agent concept is removed; ProjectSpecialistRoleAdapter is
  // the only chat adapter. Historical 'da-vinci' messages are preserved
  // as 'specialist' for rendering continuity.
  {
    version: 117,
    name: 'unify-da-vinci-to-specialist',
    up: (db) => {
      // 0a. Rebuild core_agent_prompts CHECK to include 'specialist'
      // The current CHECK (from migration 92) only allows ('da-vinci', 'generalist').
      // We must widen it before UPDATE can set agent_role = 'specialist'.
      const promptCols = (
        db.prepare('PRAGMA table_info(core_agent_prompts)').all() as Array<{ name: string }>
      )
        .map((c) => c.name)
        .join(', ')
      db.exec(`
        CREATE TABLE core_agent_prompts_new (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          agent_role TEXT NOT NULL CHECK (agent_role IN ('specialist', 'da-vinci', 'generalist')),
          mode TEXT NOT NULL CHECK (mode IN ('plan', 'build', 'danger')),
          prompt_text TEXT NOT NULL,
          default_prompt_text TEXT NOT NULL,
          is_custom INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(agent_role, mode)
        )
      `)
      db.exec(
        `INSERT INTO core_agent_prompts_new (${promptCols}) SELECT ${promptCols} FROM core_agent_prompts`
      )
      db.exec('DROP TABLE core_agent_prompts')
      db.exec('ALTER TABLE core_agent_prompts_new RENAME TO core_agent_prompts')

      // 0b. Rebuild core_agent_aliases CHECK to include 'specialist'
      // The current CHECK (from migration 70) only allows ('da-vinci').
      db.exec(`
        CREATE TABLE core_agent_aliases_new (
          agent_role TEXT PRIMARY KEY CHECK (agent_role IN ('specialist', 'da-vinci', 'generalist')),
          alias TEXT DEFAULT NULL,
          avatar_key TEXT DEFAULT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
      db.exec('INSERT INTO core_agent_aliases_new SELECT * FROM core_agent_aliases')
      db.exec('DROP TABLE core_agent_aliases')
      db.exec('ALTER TABLE core_agent_aliases_new RENAME TO core_agent_aliases')

      dbLogger.info('[migration-117] ✓ CHECK constraints rebuilt to include specialist')

      // 1. Rewrite message roles
      const msgResult = db
        .prepare(
          `
        UPDATE messages SET role = 'specialist' WHERE role = 'da-vinci'
      `
        )
        .run()
      dbLogger.info(
        `[migration-117] Rewrote ${msgResult.changes} message roles da-vinci → specialist`
      )

      // 2. Rewrite core_agent_prompts agent_role
      db.prepare(
        `
        UPDATE core_agent_prompts SET agent_role = 'specialist' WHERE agent_role = 'da-vinci'
      `
      ).run()

      // 3. Rewrite core_agent_aliases agent_role
      db.prepare(
        `
        UPDATE core_agent_aliases SET agent_role = 'specialist' WHERE agent_role = 'da-vinci'
      `
      ).run()

      // 4. Rewrite agent_sessions agent_type
      db.prepare(
        `
        UPDATE agent_sessions SET agent_type = 'specialist' WHERE agent_type = 'da-vinci'
      `
      ).run()

      // 5. Rewrite model overrides in workspace settings JSON
      // Replace 'da-vinci' → 'specialist', 'da-vinci:plan' → 'specialist:plan',
      // 'da-vinci:build' → 'specialist:build', 'project-specialist' → 'specialist',
      // 'project-specialist:plan' → 'specialist:plan', 'project-specialist:build' → 'specialist:build'
      const workspaces = db
        .prepare(`SELECT id, settings_json FROM workspaces WHERE settings_json IS NOT NULL`)
        .all() as Array<{ id: string; settings_json: string }>
      const updateSettings = db.prepare(`UPDATE workspaces SET settings_json = ? WHERE id = ?`)
      for (const ws of workspaces) {
        if (
          !ws.settings_json ||
          (!ws.settings_json.includes('da-vinci') &&
            !ws.settings_json.includes('project-specialist'))
        )
          continue
        let updated = ws.settings_json
        // Order matters: replace longer keys first
        updated = updated.replace(/"project-specialist:plan"/g, '"specialist:plan"')
        updated = updated.replace(/"project-specialist:build"/g, '"specialist:build"')
        updated = updated.replace(/"project-specialist"/g, '"specialist"')
        updated = updated.replace(/"da-vinci:plan"/g, '"specialist:plan"')
        updated = updated.replace(/"da-vinci:build"/g, '"specialist:build"')
        updated = updated.replace(/"da-vinci"/g, '"specialist"')
        // Remove specialistSwapAccepted (no longer needed)
        try {
          const parsed = JSON.parse(updated)
          delete parsed.specialistSwapAccepted
          updated = JSON.stringify(parsed)
        } catch {
          /* leave as-is if parse fails */
        }
        if (updated !== ws.settings_json) {
          updateSettings.run(updated, ws.id)
        }
      }

      // 6. Rewrite events entries
      db.prepare(
        `
        UPDATE events SET agent_id = 'specialist' WHERE agent_id = 'da-vinci'
      `
      ).run()

      // 7. Rewrite model preset action keys in llm_presets
      const presets = db
        .prepare(
          `SELECT id, action_config_json FROM llm_presets WHERE action_config_json IS NOT NULL`
        )
        .all() as Array<{ id: string; action_config_json: string }>
      const updatePreset = db.prepare(`UPDATE llm_presets SET action_config_json = ? WHERE id = ?`)
      for (const preset of presets) {
        if (
          !preset.action_config_json.includes('da-vinci') &&
          !preset.action_config_json.includes('project-specialist')
        )
          continue
        let updated = preset.action_config_json
        // Order matters: replace longer keys first
        updated = updated.replace(/"project-specialist:plan"/g, '"specialist:plan"')
        updated = updated.replace(/"project-specialist:build"/g, '"specialist:build"')
        updated = updated.replace(/"project-specialist"/g, '"specialist"')
        updated = updated.replace(/"da-vinci:plan"/g, '"specialist:plan"')
        updated = updated.replace(/"da-vinci:build"/g, '"specialist:build"')
        updated = updated.replace(/"da-vinci"/g, '"specialist"')
        if (updated !== preset.action_config_json) {
          updatePreset.run(updated, preset.id)
        }
      }

      dbLogger.info('[migration-117] ✓ Unified da-vinci → specialist across all tables')
    }
  },

  // ── v118: Unified Handoff Protocol ────────────────────────────────
  {
    version: 118,
    name: 'create-handoff-events-table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS handoff_events (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          source TEXT NOT NULL CHECK (source IN ('chat','grill','audit','council','blueprint','mpa')),
          target TEXT NOT NULL CHECK (target IN ('chat','grill','audit','council','blueprint','goals')),
          envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','expired','failed')),
          source_session_id TEXT,
          target_session_id TEXT,
          parent_handoff_id TEXT,
          intent TEXT NOT NULL,
          priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
          confidence REAL NOT NULL DEFAULT 0.5,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          accepted_at TEXT,
          expires_at TEXT,
          rejection_reason TEXT
        )
      `)

      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_handoff_events_workspace ON handoff_events(workspace_id, created_at DESC)`
      )
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_handoff_events_source ON handoff_events(source, source_session_id)`
      )
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_handoff_events_status ON handoff_events(status) WHERE status = 'pending'`
      )
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_handoff_events_parent ON handoff_events(parent_handoff_id)`
      )

      dbLogger.info('[migration-118] ✓ Created handoff_events table')
    }
  },

  // ── v119: Memory system overhaul — dedup, consolidation, evidence-based promotion ──
  {
    version: 119,
    name: 'memory-system-overhaul',
    up: (db) => {
      // ── 1. Purge all pending contradiction rows (review queue reset) ──
      const purged = db.prepare(`DELETE FROM memory_contradictions WHERE status = 'pending'`).run()
      if (purged.changes > 0) {
        dbLogger.info(`[migration-119] Purged ${purged.changes} pending contradiction rows`)
      }

      // ── 1b. Deduplicate resolved contradiction pairs before creating UNIQUE index ──
      // handleContradiction may have inserted (A,B) and (B,A) as separate resolved rows.
      // Keep only the newest row per normalized pair; delete the rest.
      const deduped = db
        .prepare(
          `
        DELETE FROM memory_contradictions
        WHERE rowid NOT IN (
          SELECT MAX(rowid)
          FROM memory_contradictions
          GROUP BY MIN(old_fact_id, new_fact_id), MAX(old_fact_id, new_fact_id)
        )
      `
        )
        .run()
      if (deduped.changes > 0) {
        dbLogger.info(`[migration-119] Deduped ${deduped.changes} duplicate contradiction pairs`)
      }

      // ── 2. Add order-normalized UNIQUE index on contradiction pairs ──
      // Prevents duplicate contradiction records for the same pair (A,B) or (B,A).
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_contradictions_pair
          ON memory_contradictions(MIN(old_fact_id, new_fact_id), MAX(old_fact_id, new_fact_id))
      `)

      // ── 3. Add merged_into + volatile columns to memory_facts ──
      // merged_into: points to the canonical fact after cluster merge
      // volatile: facts matching version/count patterns always UPDATE-in-place
      db.exec(`ALTER TABLE memory_facts ADD COLUMN merged_into TEXT`)
      db.exec(`ALTER TABLE memory_facts ADD COLUMN volatile INTEGER NOT NULL DEFAULT 0`)

      // ── 4. Create memory_confirmations table (event log replacing bare counter) ──
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_confirmations (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          fact_id TEXT NOT NULL REFERENCES memory_facts(id) ON DELETE CASCADE,
          source_type TEXT NOT NULL CHECK (source_type IN ('auto_dedup','human','tool','extraction','bootstrap')),
          weight REAL NOT NULL DEFAULT 1.0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_memory_confirmations_fact ON memory_confirmations(fact_id)`
      )
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_memory_confirmations_date ON memory_confirmations(created_at)`
      )

      // ── 5. Backfill confirmation events from existing confirmation_count ──
      // For each fact with confirmation_count > 0, insert that many auto_dedup events
      // spread across the fact's lifetime so tier recalibration has data to work with.
      const factsWithConfirms = db
        .prepare(
          `SELECT id, confirmation_count, created_at FROM memory_facts WHERE confirmation_count > 0`
        )
        .all() as Array<{ id: string; confirmation_count: number; created_at: string }>

      const insertConfirm = db.prepare(
        `INSERT INTO memory_confirmations (fact_id, source_type, weight, created_at) VALUES (?, 'auto_dedup', 0.5, ?)`
      )
      for (const fact of factsWithConfirms) {
        for (let i = 0; i < fact.confirmation_count; i++) {
          // All backfilled events get the fact's created_at (same day = won't satisfy day-spread rules)
          insertConfirm.run(fact.id, fact.created_at)
        }
      }
      if (factsWithConfirms.length > 0) {
        dbLogger.info(
          `[migration-119] Backfilled confirmation events for ${factsWithConfirms.length} facts`
        )
      }

      // ── 6. Demote T3/T2 facts that lack human confirmation ──
      // Any T3 (Wisdom) fact drops to T1; any T2 (Knowledge) drops to T1.
      // They can re-earn their tier through the new evidence-based rules.
      const demoted = db
        .prepare(
          `UPDATE memory_facts SET tier = 1, updated_at = datetime('now')
         WHERE tier >= 2 AND status = 'active'`
        )
        .run()
      if (demoted.changes > 0) {
        dbLogger.info(
          `[migration-119] Demoted ${demoted.changes} T2/T3 facts to T1 for re-evaluation`
        )
      }

      // ── 7. Detect and flag volatile facts (version/count patterns) ──
      const volatilePatterns = db
        .prepare(
          `UPDATE memory_facts SET volatile = 1, updated_at = datetime('now')
         WHERE status = 'active'
           AND (
             content LIKE '%schemaVersion%' OR content LIKE '%schema_version%'
             OR content LIKE '%electronVersion%' OR content LIKE '%electron_version%'
             OR content LIKE '%CURRENT_SCHEMA_VERSION%'
             OR title LIKE '%version%' AND (content LIKE '%=%' OR content LIKE '%:%')
           )`
        )
        .run()
      if (volatilePatterns.changes > 0) {
        dbLogger.info(`[migration-119] Flagged ${volatilePatterns.changes} facts as volatile`)
      }

      dbLogger.info('[migration-119] ✓ Memory system overhaul complete')
    }
  },

  // ── v120: Persist plan card action on messages ──
  {
    version: 120,
    name: 'add-plan-action-to-messages',
    up: (db) => {
      db.exec(`ALTER TABLE messages ADD COLUMN plan_action TEXT DEFAULT NULL`)
      dbLogger.info('[migration-120] ✓ Added plan_action column to messages')
    }
  },

  // ── v121: Add source_audit_run_id to conversations (Audit → Chat handoff) ──
  {
    version: 121,
    name: 'add-source-audit-run-id-to-conversations',
    up: (db) => {
      db.exec(`ALTER TABLE conversations ADD COLUMN source_audit_run_id TEXT DEFAULT NULL`)
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_conversations_audit_run ON conversations(source_audit_run_id) WHERE source_audit_run_id IS NOT NULL`
      )
      dbLogger.info('[migration-121] ✓ Added source_audit_run_id to conversations')
    }
  },

  // ── Migration 122: Plan Detail — status history + revision linking ──
  {
    version: 122,
    name: 'add-plan-status-history-and-revision-link',
    up: (db) => {
      db.exec(`
        -- Status timeline for the Plan Detail page
        CREATE TABLE IF NOT EXISTS plan_status_history (
          id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          plan_id       TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
          from_status   TEXT DEFAULT NULL,
          to_status     TEXT NOT NULL,
          changed_at    TEXT NOT NULL DEFAULT (datetime('now')),
          actor         TEXT NOT NULL DEFAULT 'user'
        );
        CREATE INDEX IF NOT EXISTS idx_plan_status_history_plan
          ON plan_status_history(plan_id, changed_at);
      `)

      // Revision linking: soft-link to the plan this one supersedes
      try {
        db.exec(
          `ALTER TABLE plans ADD COLUMN previous_plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL`
        )
      } catch {
        /* column may already exist */
      }

      dbLogger.info('[migration-122] ✓ Created plan_status_history table + previous_plan_id column')
    }
  },

  // ── v123: Backfill model_config_json + harden llm_provider for per-chat isolation ──
  {
    version: 123,
    name: 'backfill-model-config-snapshot-and-provider',
    up: (db) => {
      // Phase 1.2: Backfill model_config_json for legacy conversations (pre-migration 111)
      // that still have NULL snapshots. This freezes their *current effective* model config
      // so they stop following future workspace setting changes.
      //
      // Phase 1.3: Harden llm_provider for conversations missing a provider value.

      interface BackfillRow {
        conv_id: string
        workspace_id: string
        llm_provider: string | null
        settings_json: string | null
      }

      const rows = db
        .prepare(
          `
        SELECT c.id as conv_id, c.workspace_id, c.llm_provider,
               w.settings_json
        FROM conversations c
        JOIN workspaces w ON c.workspace_id = w.id
        WHERE c.model_config_json IS NULL
      `
        )
        .all() as BackfillRow[]

      if (rows.length === 0) {
        dbLogger.info('[migration-123] No conversations need backfill')
        return
      }

      const updateSnapshot = db.prepare(
        'UPDATE conversations SET model_config_json = ?, llm_provider = ? WHERE id = ?'
      )

      let backfilled = 0
      for (const row of rows) {
        try {
          let settings: Record<string, unknown> = {}
          try {
            settings = row.settings_json ? JSON.parse(row.settings_json) : {}
          } catch {
            /* corrupted settings — use defaults */
          }

          const workspaceProvider = (settings.llmProvider as LLMProvider) ?? 'claude'
          const workspaceBackend = (settings.localLlmBackend as LocalLLMBackend) ?? undefined
          const modelRoles = (settings.modelRoles ?? undefined) as ModelRoleMap | undefined
          const modelOverrides = (settings.modelOverrides ?? undefined) as
            ModelOverrides | undefined

          const resolveOpts = { modelRoles, modelOverrides, workspaceProvider, workspaceBackend }

          const snapshot = {
            plan: resolveAssignment({ action: 'specialist:plan', ...resolveOpts }),
            build: resolveAssignment({ action: 'specialist:build', ...resolveOpts }),
            background: resolveAssignment({ action: 'haiku', ...resolveOpts }),
            snapshotAt: new Date().toISOString()
          }

          // Phase 1.3: Derive provider from snapshot (same logic as conversation creation)
          const resolvedProvider = snapshot.plan.provider
          const effectiveProvider = row.llm_provider || resolvedProvider

          updateSnapshot.run(JSON.stringify(snapshot), effectiveProvider, row.conv_id)
          backfilled++
        } catch (err) {
          dbLogger.warn(`[migration-123] Failed to backfill conversation ${row.conv_id}:`, err)
          // Non-fatal per row — continue with remaining conversations
        }
      }

      dbLogger.info(
        `[migration-123] ✓ Backfilled model_config_json for ${backfilled}/${rows.length} conversations`
      )
    }
  },

  // ── v124: Add completion_json to blueprint_tasks for verify-phase disk checks ──
  {
    version: 124,
    name: 'add-completion-json-to-blueprint-tasks',
    up: (db) => {
      db.exec(`ALTER TABLE blueprint_tasks ADD COLUMN completion_json TEXT DEFAULT NULL`)
      dbLogger.info('[migration-124] ✓ Added completion_json to blueprint_tasks')
    }
  },

  // ── v125: Phase progress tracking + todo persistence ──
  {
    version: 125,
    name: 'add-plan-phase-progress-and-todo-persistence',
    up: (db) => {
      // Phase progress: JSON column on plans table
      db.exec(`ALTER TABLE plans ADD COLUMN phase_progress_json TEXT DEFAULT NULL`)

      // Todo persistence: new table
      db.exec(`
        CREATE TABLE IF NOT EXISTS conversation_todos (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          text            TEXT NOT NULL,
          completed       INTEGER NOT NULL DEFAULT 0,
          item_index      INTEGER DEFAULT NULL,
          created_at      TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_conv_todos_conv
          ON conversation_todos(conversation_id);
      `)

      dbLogger.info(
        '[migration-125] ✓ Added phase_progress_json to plans + conversation_todos table'
      )
    }
  },
  {
    version: 126,
    name: 'add-completed-at-to-blueprints-and-plans',
    up: (db) => {
      // Add completed_at to blueprints
      db.exec(`ALTER TABLE blueprints ADD COLUMN completed_at TEXT`)
      // Backfill from updated_at for existing terminal blueprints
      db.exec(
        `UPDATE blueprints SET completed_at = updated_at WHERE status IN ('complete', 'failed', 'cancelled')`
      )

      // Add completed_at to plans
      db.exec(`ALTER TABLE plans ADD COLUMN completed_at TEXT`)
      // Backfill from updated_at for existing terminal plans
      db.exec(
        `UPDATE plans SET completed_at = updated_at WHERE status IN ('completed', 'archived')`
      )

      dbLogger.info('[migration-126] ✓ Added completed_at to blueprints and plans tables')
    }
  },
  {
    version: 127,
    name: 'expand-effort-check-constraint',
    disableForeignKeys: true, // CRITICAL: prevents CASCADE wipe of messages/attachments/checkpoints
    up: (db) => {
      // SQLite cannot ALTER CHECK constraints — rebuild the table.
      db.exec(`
        CREATE TABLE conversations_new (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          title TEXT NOT NULL DEFAULT 'New Conversation',
          mode TEXT NOT NULL DEFAULT 'plan' CHECK (mode IN ('plan', 'build', 'danger')),
          type TEXT NOT NULL DEFAULT 'chat' CHECK (type IN ('chat', 'blueprint')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
          summary TEXT,
          claude_session_id TEXT,
          pr_number INTEGER,
          pr_url TEXT,
          branch_name TEXT,
          sort_order INTEGER DEFAULT 0,
          persona_specialist_id TEXT DEFAULT NULL REFERENCES specialists(id) ON DELETE SET NULL,
          llm_provider TEXT NOT NULL DEFAULT 'claude' CHECK (llm_provider IN ('claude', 'local-llm')),
          mcp_overrides_json TEXT DEFAULT '{}',
          communication_tone TEXT DEFAULT NULL,
          effort TEXT NOT NULL DEFAULT 'high' CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
          preset_id TEXT DEFAULT NULL,
          handoff_context TEXT DEFAULT NULL,
          model_config_json TEXT DEFAULT NULL,
          source_audit_run_id TEXT DEFAULT NULL
        )
      `)

      db.exec(`
        INSERT INTO conversations_new (
          id, workspace_id, title, mode, type, created_at, status, summary, claude_session_id,
          pr_number, pr_url, branch_name, sort_order, persona_specialist_id, llm_provider,
          mcp_overrides_json, communication_tone, effort, preset_id, handoff_context,
          model_config_json, source_audit_run_id
        )
        SELECT
          id, workspace_id, title, mode, type, created_at, status, summary, claude_session_id,
          pr_number, pr_url, branch_name, sort_order, persona_specialist_id, llm_provider,
          mcp_overrides_json, communication_tone, effort, preset_id, handoff_context,
          model_config_json, source_audit_run_id
        FROM conversations
      `)

      db.exec('DROP TABLE conversations')
      db.exec('ALTER TABLE conversations_new RENAME TO conversations')

      // Recreate indexes dropped with the old table
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_conversations_workspace ON conversations(workspace_id)'
      )
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_conversations_audit_run ON conversations(source_audit_run_id) WHERE source_audit_run_id IS NOT NULL`
      )

      dbLogger.info('[migration-127] ✓ Expanded effort CHECK constraint to include xhigh + max')
    }
  },
  {
    version: 128,
    name: 'add-hidden-to-messages',
    up: (db) => {
      db.exec(`ALTER TABLE messages ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`)
      dbLogger.info('[migration-128] ✓ Added hidden column to messages table')
    }
  },
  {
    version: 129,
    name: 'add-source-branch-to-conversations',
    up: (db) => {
      db.exec(`ALTER TABLE conversations ADD COLUMN source_branch TEXT DEFAULT NULL`)
      dbLogger.info('[migration-129] ✓ Added source_branch column to conversations')
    }
  },
  {
    version: 130,
    name: 'code-graph-edge-typing-and-provenance',
    up: (db) => {
      // Deliberately plain TEXT without CHECK — SQLite ALTER TABLE ADD COLUMN
      // with a CHECK on a populated table is an avoidable footgun. The enum is
      // enforced in TypeScript (EdgeResolution / SymbolKind).
      db.exec(`ALTER TABLE code_graph_tags ADD COLUMN symbol_kind TEXT DEFAULT NULL`)
      db.exec(`ALTER TABLE code_graph_edges ADD COLUMN resolution TEXT NOT NULL DEFAULT 'inferred'`)
      db.exec(`ALTER TABLE code_graph_edges ADD COLUMN def_fanout INTEGER NOT NULL DEFAULT 1`)
      dbLogger.info('[migration-130] ✓ Added symbol_kind, resolution, def_fanout')
      dbLogger.info(
        '[migration-130] Existing rows keep default values until the next index run, ' +
          'which detects the untyped index and re-parses every file automatically.'
      )
    }
  },
  {
    version: 131,
    name: 'drop-unused-code-graph-resolution-index',
    up: (db) => {
      // resolution is never a WHERE/ORDER BY term — ordering happens in JS.
      // The index only cost migration time and per-insert maintenance on
      // workspaces with millions of edges.
      db.exec('DROP INDEX IF EXISTS idx_graph_resolution')
      dbLogger.info('[migration-131] ✓ Dropped unused idx_graph_resolution')
    }
  },

  // ── Migration 132: Add 'bootstrap' to memory_facts source_type CHECK ──
  {
    version: 132,
    name: 'memory-facts-bootstrap-source-type',
    up: (db) => {
      // MemorySourceType has included 'bootstrap' since the bootstrap pipeline
      // shipped, but the CHECK was never extended past migration 115. Every
      // deterministic bootstrap write (docs, stack, architecture, history,
      // structure) therefore failed with
      //   CHECK constraint failed: source_type IN (...)
      // and the per-fact try/catch in memory-extraction.service swallowed it,
      // so Feed Brain / Deep Scan silently produced 0 facts from those phases.
      // Only agent-recorded facts (source_type 'tool', via the memory MCP
      // server) ever landed.
      //
      // SQLite cannot ALTER a CHECK constraint — rebuild the table.
      // Mirrors migration 115, including the memory_contradictions FK detach.
      const purged = db
        .prepare(
          `DELETE FROM memory_facts
         WHERE workspace_id IS NOT NULL
           AND workspace_id NOT IN (SELECT id FROM workspaces)`
        )
        .run()
      if (purged.changes > 0)
        dbLogger.warn(`[migration-132] Purged ${purged.changes} orphaned memory_facts`)

      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_contradictions_bak AS
          SELECT * FROM memory_contradictions;
        DROP TABLE IF EXISTS memory_contradictions;
      `)

      db.exec(`
        CREATE TABLE memory_facts_new (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
          category TEXT NOT NULL CHECK (category IN ('decision','convention','gotcha','preference','reference')),
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
          scope_paths TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scope_paths)),
          tier INTEGER NOT NULL DEFAULT 0 CHECK (tier BETWEEN 0 AND 3),
          confidence REAL NOT NULL DEFAULT 0.5,
          confirmation_count INTEGER NOT NULL DEFAULT 0,
          last_confirmed_at TEXT,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','archived')),
          superseded_by TEXT,
          merged_into TEXT,
          volatile INTEGER NOT NULL DEFAULT 0,
          source_type TEXT NOT NULL CHECK (source_type IN ('session','commit','document','tool','manual','claude-md','blueprint','grill','bootstrap')),
          source_ref TEXT,
          embedding BLOB,
          embedding_pending INTEGER NOT NULL DEFAULT 1,
          last_accessed_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `)

      // Column-explicit copy: migrations 118/119 added merged_into and volatile
      // after 115, so positional INSERT…SELECT * is not safe here.
      db.exec(`
        INSERT INTO memory_facts_new (
          id, workspace_id, category, title, content, tags, scope_paths,
          tier, confidence, confirmation_count, last_confirmed_at, status,
          superseded_by, merged_into, volatile, source_type, source_ref,
          embedding, embedding_pending, last_accessed_at, created_at, updated_at
        )
        SELECT
          id, workspace_id, category, title, content, tags, scope_paths,
          tier, confidence, confirmation_count, last_confirmed_at, status,
          superseded_by, merged_into, volatile, source_type, source_ref,
          embedding, embedding_pending, last_accessed_at, created_at, updated_at
        FROM memory_facts;
        DROP TABLE memory_facts;
        ALTER TABLE memory_facts_new RENAME TO memory_facts;
        CREATE INDEX IF NOT EXISTS idx_memory_facts_workspace ON memory_facts(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_memory_facts_status ON memory_facts(status);
        CREATE INDEX IF NOT EXISTS idx_memory_facts_category ON memory_facts(category);
        CREATE INDEX IF NOT EXISTS idx_memory_facts_tier ON memory_facts(tier DESC, confidence DESC);
        CREATE INDEX IF NOT EXISTS idx_memory_facts_embedding_pending ON memory_facts(embedding_pending) WHERE embedding_pending = 1;
        CREATE INDEX IF NOT EXISTS idx_memory_facts_source ON memory_facts(source_type, source_ref);
      `)

      db.exec(`
        CREATE TABLE memory_contradictions (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          old_fact_id TEXT NOT NULL REFERENCES memory_facts(id),
          new_fact_id TEXT NOT NULL REFERENCES memory_facts(id),
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('auto_resolved','pending','user_resolved')),
          resolution TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          resolved_at TEXT
        );
        INSERT INTO memory_contradictions
          SELECT * FROM memory_contradictions_bak
          WHERE old_fact_id IN (SELECT id FROM memory_facts)
            AND new_fact_id IN (SELECT id FROM memory_facts);
        DROP TABLE memory_contradictions_bak;
        CREATE INDEX IF NOT EXISTS idx_memory_contradictions_status ON memory_contradictions(status);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_contradictions_pair
          ON memory_contradictions(old_fact_id, new_fact_id);
      `)

      dbLogger.info(
        "[migration-132] ✓ Extended memory_facts source_type CHECK to include 'bootstrap'"
      )
    }
  },

  // ── Migration 133: Durable Feed Brain ingestion queue ──
  {
    version: 133,
    name: 'memory-bootstrap-run-queue',
    up: (db) => {
      // Bootstrap used to be a purely in-memory pipeline: discovery and
      // extraction were interleaved, so the item total was unknowable, progress
      // was phase-index guesswork, and cancelling or quitting discarded every
      // partially-processed file. These two tables turn it into a durable job
      // queue — plan up front, drain incrementally, resume where it stopped.
      // Purely additive: memory_doc_state stays as the cross-run fast path.
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_bootstrap_runs (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          mode TEXT NOT NULL,
          scope TEXT NOT NULL,
          status TEXT NOT NULL,
          current_phase TEXT,
          items_total INTEGER NOT NULL DEFAULT 0,
          items_done INTEGER NOT NULL DEFAULT 0,
          items_skipped INTEGER NOT NULL DEFAULT 0,
          items_failed INTEGER NOT NULL DEFAULT 0,
          facts_created INTEGER NOT NULL DEFAULT 0,
          active_ms INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          finished_at TEXT
        );

        CREATE TABLE IF NOT EXISTS memory_bootstrap_items (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          run_id TEXT NOT NULL REFERENCES memory_bootstrap_runs(id) ON DELETE CASCADE,
          workspace_id TEXT NOT NULL,
          phase TEXT NOT NULL,
          kind TEXT NOT NULL,
          source_ref TEXT NOT NULL,
          content_hash TEXT,
          priority INTEGER NOT NULL DEFAULT 100,
          chunk_total INTEGER NOT NULL DEFAULT 0,
          chunk_done INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'pending',
          facts_created INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_bootstrap_items_run
          ON memory_bootstrap_items(run_id, status, priority);
        CREATE INDEX IF NOT EXISTS idx_bootstrap_runs_ws
          ON memory_bootstrap_runs(workspace_id, status);
      `)

      dbLogger.info('[migration-133] ✓ Created memory_bootstrap_runs + memory_bootstrap_items')
    }
  },

  // ── Migration 134: Specialist build provenance ──
  {
    version: 134,
    name: 'specialist-build-provenance',
    up: (db) => {
      // A specialist whose LLM tailoring silently failed was persisted with
      // build_status='ready' and the untouched template skeleton — identical
      // in the UI to a genuinely tailored one. These two columns make the
      // degradation visible instead of inferring it from prompt length.
      //
      // Plain TEXT without CHECK, matching migration 130's reasoning: the enum
      // ('agentic' | 'oneshot' | 'skeleton') is enforced in TypeScript.
      db.exec(`ALTER TABLE specialists ADD COLUMN build_method TEXT DEFAULT NULL`)
      db.exec(`ALTER TABLE specialists ADD COLUMN ingestion_run_id TEXT DEFAULT NULL`)
      dbLogger.info('[migration-134] ✓ Added build_method + ingestion_run_id to specialists')
    }
  },

  // ── Migration 135: Full-text search index over memory facts ──
  {
    version: 135,
    name: 'memory-facts-fts',
    up: (db) => {
      // Keyword retrieval was `LIKE '%q%'` plus JS token overlap computed over
      // every active fact loaded with its embedding BLOB. That is linear in the
      // corpus on every turn, and `LIKE` cannot rank.
      //
      // This is a *standard* FTS5 table, not the external-content form used by
      // library_docs_fts: that one keys off an INTEGER rowid, and
      // memory_facts.id is TEXT (hex randomblob). `fact_id` is UNINDEXED so it
      // is stored and returnable without polluting the term index.
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_facts_fts USING fts5(
          fact_id UNINDEXED,
          title,
          content,
          tags
        );
      `)

      // Sync via triggers rather than from the repository. Facts are written
      // through a dozen paths — createFact, updateFact, updateFactInPlace,
      // archiveFact, supersedeFact, mergeFact, decayFacts, bulk dedup — and a
      // manually-synced index only has to be forgotten once to start returning
      // stale titles forever. Triggers cannot be bypassed.
      //
      // Every fact is indexed regardless of status; `searchFts` joins back to
      // memory_facts and filters there, so a status change needs no index work.
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS memory_facts_fts_ai
        AFTER INSERT ON memory_facts BEGIN
          INSERT INTO memory_facts_fts(fact_id, title, content, tags)
          VALUES (new.id, new.title, new.content, new.tags);
        END;

        CREATE TRIGGER IF NOT EXISTS memory_facts_fts_ad
        AFTER DELETE ON memory_facts BEGIN
          DELETE FROM memory_facts_fts WHERE fact_id = old.id;
        END;

        CREATE TRIGGER IF NOT EXISTS memory_facts_fts_au
        AFTER UPDATE ON memory_facts BEGIN
          DELETE FROM memory_facts_fts WHERE fact_id = old.id;
          INSERT INTO memory_facts_fts(fact_id, title, content, tags)
          VALUES (new.id, new.title, new.content, new.tags);
        END;
      `)

      // Backfill. Guarded so re-running against a partially-built index cannot
      // double-insert every row.
      db.exec(`DELETE FROM memory_facts_fts;`)
      db.exec(`
        INSERT INTO memory_facts_fts(fact_id, title, content, tags)
        SELECT id, title, content, tags FROM memory_facts;
      `)

      const indexed = (
        db.prepare('SELECT count(*) AS n FROM memory_facts_fts').get() as { n: number }
      ).n
      dbLogger.info(
        `[migration-135] ✓ Created memory_facts_fts + triggers (${indexed} fact(s) indexed)`
      )
    }
  },

  // ── Migration 136: Bi-temporal validity on memory facts ──
  {
    version: 136,
    name: 'memory-facts-bitemporal',
    up: (db) => {
      // Four timestamps, separating when something was *true* from when we
      // happened to *learn* it:
      //   valid_from  — when the fact became true of the project
      //   valid_to    — when it stopped being true (NULL = still true)
      //   observed_at — when the source stated it (a commit date, a file mtime)
      //   recorded_at — when this row was written
      //
      // Two concrete wins. A commit-sourced fact can carry the commit's date
      // rather than today's, which matters across a long history. And
      // `computeRecency` read `updated_at`, so a dedup merge made a decade-old
      // convention look brand new — it now reads `observed_at`, which a merge
      // does not touch.
      db.exec(`ALTER TABLE memory_facts ADD COLUMN valid_from TEXT`)
      db.exec(`ALTER TABLE memory_facts ADD COLUMN valid_to TEXT`)
      db.exec(`ALTER TABLE memory_facts ADD COLUMN observed_at TEXT`)
      db.exec(`ALTER TABLE memory_facts ADD COLUMN recorded_at TEXT`)

      // Backfill from what we have. An active fact's window is still open; a
      // superseded or archived one closed when it was last touched.
      db.exec(`
        UPDATE memory_facts SET
          recorded_at = created_at,
          observed_at = created_at,
          valid_from  = created_at,
          valid_to    = CASE
                          WHEN status IN ('superseded', 'archived') THEN updated_at
                          ELSE NULL
                        END
      `)

      // The hot retrieval predicate.
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_memory_facts_valid
          ON memory_facts(workspace_id, status, valid_to)
      `)

      const open = (
        db.prepare('SELECT count(*) AS n FROM memory_facts WHERE valid_to IS NULL').get() as {
          n: number
        }
      ).n
      dbLogger.info(`[migration-136] ✓ Added bi-temporal columns (${open} fact(s) currently valid)`)
    }
  },

  // ── Migration 137: Typed relationships between facts ──
  {
    version: 137,
    name: 'memory-edges',
    up: (db) => {
      // Relationships between facts were spread across three ad-hoc places:
      // `superseded_by`, `merged_into`, and `memory_contradictions` — the last
      // of which had also been pressed into service as a cluster-review queue
      // by prefixing its `resolution` text. One typed edge table replaces all
      // of it and gives synthesis somewhere to record parent/child links.
      //
      // Edge direction is always "from acts on to":
      //   A supersedes   B  — A replaced B
      //   A contradicts  B  — A conflicts with B
      //   A derived_from B  — A was synthesised from B
      //   A relates_to   B  — undirected association
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_edges (
          id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          from_id    TEXT NOT NULL REFERENCES memory_facts(id) ON DELETE CASCADE,
          to_id      TEXT NOT NULL REFERENCES memory_facts(id) ON DELETE CASCADE,
          edge_type  TEXT NOT NULL CHECK (edge_type IN
                       ('derived_from','relates_to','contradicts','supersedes')),
          confidence REAL NOT NULL DEFAULT 1.0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(from_id, to_id, edge_type)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_edges_from ON memory_edges(from_id, edge_type);
        CREATE INDEX IF NOT EXISTS idx_memory_edges_to   ON memory_edges(to_id, edge_type);
      `)

      // Backfill. INSERT OR IGNORE covers the UNIQUE constraint, and the
      // subqueries drop rows pointing at facts that no longer exist — the FK
      // would reject those and abort the whole migration.
      db.exec(`
        INSERT OR IGNORE INTO memory_edges (from_id, to_id, edge_type)
        SELECT f.superseded_by, f.id, 'supersedes'
          FROM memory_facts f
         WHERE f.superseded_by IS NOT NULL
           AND EXISTS (SELECT 1 FROM memory_facts n WHERE n.id = f.superseded_by);
      `)

      db.exec(`
        INSERT OR IGNORE INTO memory_edges (from_id, to_id, edge_type)
        SELECT f.merged_into, f.id, 'supersedes'
          FROM memory_facts f
         WHERE f.merged_into IS NOT NULL
           AND EXISTS (SELECT 1 FROM memory_facts n WHERE n.id = f.merged_into);
      `)

      db.exec(`
        INSERT OR IGNORE INTO memory_edges (from_id, to_id, edge_type)
        SELECT c.new_fact_id, c.old_fact_id, 'contradicts'
          FROM memory_contradictions c
         WHERE EXISTS (SELECT 1 FROM memory_facts a WHERE a.id = c.new_fact_id)
           AND EXISTS (SELECT 1 FROM memory_facts b WHERE b.id = c.old_fact_id);
      `)

      const edges = (db.prepare('SELECT count(*) AS n FROM memory_edges').get() as { n: number }).n
      dbLogger.info(`[migration-137] ✓ Created memory_edges (${edges} edge(s) backfilled)`)
    }
  },

  // ── Migration 138: Narrow the FTS update trigger to indexed columns ──
  {
    version: 138,
    name: 'memory-facts-fts-narrow-update-trigger',
    up: (db) => {
      // Migration 135 created `memory_facts_fts_au` as AFTER UPDATE ON
      // memory_facts — every column. That put a DELETE + INSERT into the FTS
      // index on the *read* path: `touchFacts` writes `last_accessed_at` for
      // up to ten facts on every single retrieval, and `decayFacts`,
      // `confirmFact`, `setEmbedding`, `setVolatile` and `reopenValidity` all
      // fire it too. None of them change indexed text, so every one of those
      // rewrites reindexed identical strings and dirtied the WAL.
      //
      // Two guards, because they catch different things:
      //   UPDATE OF — skips statements that never mention the indexed columns
      //               (the touch/decay/confirm paths).
      //   WHEN      — skips statements that do mention them but write the same
      //               value (updateFactInPlace re-writing an identical title).
      //
      // `IS NOT` rather than `<>` so a NULL on either side compares correctly;
      // `tags` is nullable and `<>` would silently never fire for it.
      db.exec(`DROP TRIGGER IF EXISTS memory_facts_fts_au;`)
      db.exec(`
        CREATE TRIGGER memory_facts_fts_au
        AFTER UPDATE OF title, content, tags ON memory_facts
        WHEN old.title   IS NOT new.title
          OR old.content IS NOT new.content
          OR old.tags    IS NOT new.tags
        BEGIN
          DELETE FROM memory_facts_fts WHERE fact_id = old.id;
          INSERT INTO memory_facts_fts(fact_id, title, content, tags)
          VALUES (new.id, new.title, new.content, new.tags);
        END;
      `)

      dbLogger.info('[migration-138] ✓ Narrowed memory_facts_fts_au to title/content/tags changes')
    }
  },

  // ── Migration 139: Per-conversation git worktrees ──
  {
    version: 139,
    name: 'chat-worktrees',
    up: (db) => {
      // `conversations.branch_name` has recorded a branch per chat since v6, but
      // nothing enforced it: every conversation's CLI ran with cwd = workspace
      // root, and MAX_CONCURRENT_STREAMS allows three of them at once. Three
      // writers, one HEAD — work begun on one branch could be committed to
      // another with no error anywhere. This table binds a conversation to a
      // real directory so the branch it claims is the branch it writes to.
      //
      // Note this is NOT a revival of `agent_worktrees` (v9, dropped in v66).
      // That table was keyed per *specialist* for a pool of parallel agents
      // sharing one chat. This is keyed per *conversation*, which is the unit
      // that actually owns a branch.
      //
      // Two uniqueness rules, both load-bearing:
      //   conversation_id            — one tree per conversation.
      //   (workspace_id, branch_name) — git itself refuses to check the same
      //                                 branch out in two worktrees, so the DB
      //                                 rejects it first with a clear error
      //                                 instead of surfacing a raw git failure.
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_worktrees (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
          branch_name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          base_branch TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_used_at TEXT
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_worktrees_branch
          ON chat_worktrees(workspace_id, branch_name);
        CREATE INDEX IF NOT EXISTS idx_chat_worktrees_status
          ON chat_worktrees(workspace_id, status);
      `)

      dbLogger.info('[migration-139] ✓ Created chat_worktrees')
    }
  },

  // ── Migration 140: Retained worktrees survive their conversation ──
  {
    version: 140,
    name: 'chat-worktrees-retained',
    disableForeignKeys: true,
    up: (db) => {
      // v139 declared `conversation_id NOT NULL ... ON DELETE CASCADE`, which
      // made "never lose uncommitted work" impossible to honour. Teardown on
      // chat close/delete now parks a dirty tree as `retained` instead of
      // running `worktree remove --force` over it — but the conversation row is
      // deleted moments later, and CASCADE took the only record of the
      // directory with it. The tree survived on disk with nothing pointing at
      // it: not reapable, not listable, not findable by branch, so the next
      // chat wanting that branch got a raw git error instead of a clear
      // "already checked out" message.
      //
      // SET NULL keeps the row. A retained tree is parked work, not a chat's
      // execution target, so losing the conversation link is the correct
      // semantics rather than a workaround. UNIQUE still holds: SQLite permits
      // multiple NULLs in a unique index, so any number of trees can be parked.
      //
      // SQLite cannot alter a foreign key in place — the table must be rebuilt.
      db.exec(`
        CREATE TABLE chat_worktrees_new (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          conversation_id TEXT UNIQUE REFERENCES conversations(id) ON DELETE SET NULL,
          branch_name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          base_branch TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_used_at TEXT
        );

        INSERT INTO chat_worktrees_new
          (id, workspace_id, conversation_id, branch_name, path,
           base_branch, status, created_at, last_used_at)
        SELECT id, workspace_id, conversation_id, branch_name, path,
               base_branch, status, created_at, last_used_at
          FROM chat_worktrees;

        DROP TABLE chat_worktrees;
        ALTER TABLE chat_worktrees_new RENAME TO chat_worktrees;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_worktrees_branch
          ON chat_worktrees(workspace_id, branch_name);
        CREATE INDEX IF NOT EXISTS idx_chat_worktrees_status
          ON chat_worktrees(workspace_id, status);
      `)

      dbLogger.info('[migration-140] ✓ chat_worktrees.conversation_id is nullable (SET NULL)')
    }
  },

  // ── Migration 141: chat_worktrees → work_tracks (owner-keyed) ──
  {
    version: 141,
    name: 'work-tracks',
    up: (db) => {
      // `conversation_id REFERENCES conversations(id)` was the wrong key.
      //
      // It is why v140 needed a SET NULL escape hatch: retained work outlives
      // the chat that produced it, so the owning row has to be able to have no
      // owner. And it locks the table to chats. A blueprint run is not a
      // conversation and a synthetic id like `blueprint-build-<id>-<task>` is
      // not a row, so the FK rejects every non-chat writer outright — which is
      // precisely the set of writers (Blueprint BUILD/VERIFY, MPA execute) that
      // most needs its own tree, because they write to the user's own checkout.
      //
      // A *track* is one unit of parallel work: one branch, one worktree, one
      // owner. The owner is identified structurally (`owner_kind`) rather than
      // relationally, and there is deliberately NO foreign key: an owner may be
      // a row in another table, a synthetic run id, or nothing at all once the
      // work is retained.
      //
      // UNIQUE(owner_kind, owner_id) replaces UNIQUE(conversation_id). SQLite
      // permits multiple NULLs in a unique index, so any number of retained
      // tracks can sit ownerless side by side.
      //
      // landing_mode / landed_at / landed_into are the columns the landing
      // phase needs. They are added now, unused, because a second rebuild of
      // this table later is a migration nobody should have to write twice.
      db.exec(`
        CREATE TABLE work_tracks (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          owner_kind TEXT NOT NULL,
          owner_id TEXT,
          branch_name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          base_branch TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          landing_mode TEXT,
          landed_at TEXT,
          landed_into TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_used_at TEXT
        );

        INSERT INTO work_tracks
          (id, workspace_id, owner_kind, owner_id, branch_name, path,
           base_branch, status, created_at, last_used_at)
        SELECT id, workspace_id, 'chat', conversation_id, branch_name, path,
               base_branch, status, created_at, last_used_at
          FROM chat_worktrees;

        DROP TABLE chat_worktrees;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_work_tracks_owner
          ON work_tracks(owner_kind, owner_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_work_tracks_branch
          ON work_tracks(workspace_id, branch_name);
        CREATE INDEX IF NOT EXISTS idx_work_tracks_status
          ON work_tracks(workspace_id, status);
      `)

      dbLogger.info('[migration-141] ✓ chat_worktrees → work_tracks (owner_kind/owner_id)')
    }
  },

  // ── Migration 142: which files each track has touched ──
  {
    version: 142,
    name: 'track-file-claims',
    up: (db) => {
      // Blueprint's wave scheduler already refuses to run two tasks that touch
      // the same file, and that guard is the reason parallel BUILD is safe. It
      // is also scoped to a single wave: it has no idea chats, other blueprints
      // or campaigns exist, so two *tracks* editing the same file is invisible
      // until one of them tries to land and gets a merge conflict — hours later,
      // with both sets of work already written.
      //
      // This table is the cheap generalisation: record what each track has
      // touched, and the same overlap check that guards a wave can warn across
      // the whole workspace. Prediction only — nothing is blocked on it.
      //
      // (track_id, file_path) is the primary key so re-recording a turn is an
      // upsert rather than unbounded growth, and first_seen_at survives it:
      // "who touched this first" is the question a user asks when two tracks
      // collide. Rows die with their track via ON DELETE CASCADE.
      db.exec(`
        CREATE TABLE IF NOT EXISTS track_file_claims (
          track_id TEXT NOT NULL REFERENCES work_tracks(id) ON DELETE CASCADE,
          file_path TEXT NOT NULL,
          first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (track_id, file_path)
        );

        CREATE INDEX IF NOT EXISTS idx_track_file_claims_path
          ON track_file_claims(file_path);
      `)

      dbLogger.info('[migration-142] ✓ Created track_file_claims')
    }
  },
  {
    version: 143,
    name: 'blueprint-task-user-skip',
    up: (db) => {
      // A task can be genuinely unverifiable — its planned files live outside
      // any tree BUILD is allowed to read — and no amount of retrying changes
      // that. Until now the only way out was `status = 'skipped'`, which
      // retryPhase resets to 'pending' on every attempt, so the run looped on
      // the same task forever.
      //
      // User intent gets its own column rather than a sixth status value for
      // two reasons: the failure cascade writes 'skipped' by itself (so status
      // cannot distinguish "a human decided" from "collateral damage"), and a
      // retry must be able to reset status without erasing the decision.
      db.exec(`ALTER TABLE blueprint_tasks ADD COLUMN skipped_by_user_at TEXT`)

      dbLogger.info('[migration-143] ✓ Added blueprint_tasks.skipped_by_user_at')
    }
  },

  // ── Migration 144: per-track code-graph index scope ──
  {
    version: 144,
    name: 'workspace-shadow-for-track-index',
    up: (db) => {
      // The code graph is keyed by workspace_id, so a workspace has exactly one
      // index — built from the primary checkout. An agent working in a track's
      // worktree is usually on a *different branch*, whose files that index has
      // never seen: asking "where is X defined" returns nothing, and because
      // `hasPersistedIndex()` is a workspace-wide count it still reports the
      // workspace as indexed, so no "unindexed, use Grep" hint fires either.
      // The agent gets a silent empty answer and falls back to raw `grep -rn`.
      //
      // A shadow workspace row per worktree gives that tree its own index under
      // the existing key, so none of the graph tables, repositories or the MCP
      // server need to learn about tracks. Shadows are excluded from findAll()
      // and are not user-visible; they exist only to scope an index.
      //
      // Self-referencing FK with CASCADE so deleting the real workspace takes
      // its shadows (and, through them, their graph rows) with it.
      db.exec(`
        ALTER TABLE workspaces
          ADD COLUMN shadow_of_workspace_id TEXT
          REFERENCES workspaces(id) ON DELETE CASCADE
      `)

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_workspaces_shadow_of
          ON workspaces(shadow_of_workspace_id)
      `)

      dbLogger.info('[migration-144] ✓ Added workspaces.shadow_of_workspace_id')
    }
  },
  {
    version: 145,
    name: 'audit-finding-handoffs',
    up: (db) => {
      // A finding that has already been sent to chat or turned into a blueprint
      // looks identical to one nobody has touched, so the same work gets handed
      // off twice. Recording the handoff lets the list mark it.
      //
      // Keyed by run: finding ids are regenerated on every audit, so a re-run
      // legitimately starts from a clean slate. Rows are not unique per finding
      // — handing the same finding off again is allowed, and the newest row wins.
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_finding_handoffs (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          audit_run_id TEXT NOT NULL REFERENCES audit_runs(id) ON DELETE CASCADE,
          finding_id TEXT NOT NULL,
          target TEXT NOT NULL CHECK (target IN ('chat', 'blueprint')),
          ref_id TEXT,
          ref_title TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_audit_finding_handoffs_run
          ON audit_finding_handoffs(audit_run_id)
      `)

      dbLogger.info('[migration-145] ✓ Created audit_finding_handoffs')
    }
  },
  {
    version: 146,
    name: 'blueprint-task-outcome',
    up: (db) => {
      // A failed build task recorded only `status = 'failed'`. The reason was
      // computed, emitted as a transient event and then dropped, so after a
      // reload nothing on disk said *why* — reconstructing intent meant opening
      // SQLite by hand. Retry inherited the same blindness: it reset the row to
      // 'pending' with no memory of the previous verdict and walked the agent
      // into the identical trap.
      //
      // `outcome_kind` records how the task was closed rather than merely that
      // it closed: 'verified' (claims fresh on disk), 'unproven' (claims exist,
      // freshness unprovable), 'preexisting' (declared already-correct),
      // 'accepted_by_user' (a human closed it out). It is deliberately NOT a new
      // `status` value — status carries a CHECK constraint, so a sixth value
      // means a full table rebuild plus every enum in main, preload and renderer.
      //
      // Three additive ALTERs, no rebuild: ignoring the columns reverts the change.
      db.exec(`ALTER TABLE blueprint_tasks ADD COLUMN failure_reason TEXT`)
      db.exec(`ALTER TABLE blueprint_tasks ADD COLUMN outcome_kind TEXT`)
      db.exec(`ALTER TABLE blueprint_tasks ADD COLUMN resolution_note TEXT`)

      dbLogger.info(
        '[migration-146] ✓ Added blueprint_tasks.failure_reason / outcome_kind / resolution_note'
      )
    }
  },
  {
    version: 147,
    name: 'expand-llm-provider-check-for-glm',
    disableForeignKeys: true, // CRITICAL: prevents CASCADE wipe of messages/attachments/checkpoints
    up: (db) => {
      // GLM was wired end-to-end in TypeScript — deriveProvider, the model
      // snapshot, the IPC layer and the repository all pass 'glm' through
      // untouched — but the column's CHECK constraint only admitted
      // ('claude', 'local-llm'). Creating the very first GLM conversation
      // therefore died at the INSERT with SQLITE_CONSTRAINT, surfacing as a
      // generic "failed to create conversation" toast that named neither the
      // column nor the provider.
      //
      // SQLite cannot ALTER a CHECK constraint — rebuild the table, same
      // create/copy/drop/rename shape as migration 127.
      db.exec(`
        CREATE TABLE conversations_new (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          title TEXT NOT NULL DEFAULT 'New Conversation',
          mode TEXT NOT NULL DEFAULT 'plan' CHECK (mode IN ('plan', 'build', 'danger')),
          type TEXT NOT NULL DEFAULT 'chat' CHECK (type IN ('chat', 'blueprint')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
          summary TEXT,
          claude_session_id TEXT,
          pr_number INTEGER,
          pr_url TEXT,
          branch_name TEXT,
          sort_order INTEGER DEFAULT 0,
          persona_specialist_id TEXT DEFAULT NULL REFERENCES specialists(id) ON DELETE SET NULL,
          llm_provider TEXT NOT NULL DEFAULT 'claude' CHECK (llm_provider IN ('claude', 'local-llm', 'glm')),
          mcp_overrides_json TEXT DEFAULT '{}',
          communication_tone TEXT DEFAULT NULL,
          effort TEXT NOT NULL DEFAULT 'high' CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
          preset_id TEXT DEFAULT NULL,
          handoff_context TEXT DEFAULT NULL,
          model_config_json TEXT DEFAULT NULL,
          source_audit_run_id TEXT DEFAULT NULL,
          source_branch TEXT DEFAULT NULL
        )
      `)

      db.exec(`
        INSERT INTO conversations_new (
          id, workspace_id, title, mode, type, created_at, status, summary, claude_session_id,
          pr_number, pr_url, branch_name, sort_order, persona_specialist_id, llm_provider,
          mcp_overrides_json, communication_tone, effort, preset_id, handoff_context,
          model_config_json, source_audit_run_id, source_branch
        )
        SELECT
          id, workspace_id, title, mode, type, created_at, status, summary, claude_session_id,
          pr_number, pr_url, branch_name, sort_order, persona_specialist_id, llm_provider,
          mcp_overrides_json, communication_tone, effort, preset_id, handoff_context,
          model_config_json, source_audit_run_id, source_branch
        FROM conversations
      `)

      db.exec('DROP TABLE conversations')
      db.exec('ALTER TABLE conversations_new RENAME TO conversations')

      // Recreate indexes dropped with the old table
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_conversations_workspace ON conversations(workspace_id)'
      )
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_conversations_audit_run ON conversations(source_audit_run_id) WHERE source_audit_run_id IS NOT NULL`
      )

      dbLogger.info("[migration-147] ✓ Expanded llm_provider CHECK constraint to include 'glm'")
    }
  },
  {
    version: 148,
    name: 'blueprint-code-review-phase',
    disableForeignKeys: true, // rebuilds `blueprints`, the CASCADE parent of phases/tasks
    up: (db) => {
      // The adversarial code-review layer is a real pipeline phase between BUILD
      // and VERIFY, so it needs a row in blueprint_phases and a status on the
      // blueprint. Both columns carry CHECK constraints that SQLite cannot ALTER,
      // so this is the create/copy/drop/rename rebuild used by migrations 107/147.
      //
      // Columns are enumerated rather than `SELECT *`: the rebuild has to survive
      // the ALTERs that earlier migrations bolted on (blueprints.completed_at),
      // and positional copying silently mis-assigns if that order ever shifts.
      db.exec(`
        CREATE TABLE blueprints_new (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          short_name TEXT NOT NULL DEFAULT '',
          description TEXT DEFAULT '',
          status TEXT NOT NULL DEFAULT 'draft'
            CHECK (status IN ('draft','specifying','clarifying','planning',
                              'tasking','reviewing','building','codeReviewing','verifying',
                              'complete','failed','cancelled')),
          current_phase TEXT DEFAULT 'specify'
            CHECK (current_phase IN ('specify','clarify','plan','tasks',
                                     'review','build','code-review','verify')),
          priority TEXT DEFAULT 'P1'
            CHECK (priority IN ('P1','P2','P3')),
          source_idea_id TEXT REFERENCES ideas(id) ON DELETE SET NULL,
          constitution_snapshot TEXT,
          settings_json TEXT DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT
        )
      `)

      db.exec(`
        INSERT INTO blueprints_new (
          id, workspace_id, title, short_name, description, status, current_phase,
          priority, source_idea_id, constitution_snapshot, settings_json,
          created_at, updated_at, completed_at
        )
        SELECT
          id, workspace_id, title, short_name, description, status, current_phase,
          priority, source_idea_id, constitution_snapshot, settings_json,
          created_at, updated_at, completed_at
        FROM blueprints
      `)

      db.exec('DROP TABLE blueprints')
      db.exec('ALTER TABLE blueprints_new RENAME TO blueprints')
      db.exec('CREATE INDEX IF NOT EXISTS idx_blueprints_workspace ON blueprints(workspace_id)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_blueprints_status ON blueprints(status)')

      db.exec(`
        CREATE TABLE blueprint_phases_new (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          blueprint_id TEXT NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
          phase TEXT NOT NULL
            CHECK (phase IN ('specify','clarify','plan','tasks','review','build','code-review','verify')),
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','active','complete','skipped','failed')),
          conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
          artifacts_json TEXT DEFAULT '[]',
          context_snapshot TEXT,
          started_at TEXT,
          completed_at TEXT
        )
      `)

      db.exec(`
        INSERT INTO blueprint_phases_new (
          id, blueprint_id, phase, status, conversation_id, artifacts_json,
          context_snapshot, started_at, completed_at
        )
        SELECT
          id, blueprint_id, phase, status, conversation_id, artifacts_json,
          context_snapshot, started_at, completed_at
        FROM blueprint_phases
      `)

      db.exec('DROP TABLE blueprint_phases')
      db.exec('ALTER TABLE blueprint_phases_new RENAME TO blueprint_phases')
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_bp_phases_blueprint ON blueprint_phases(blueprint_id)'
      )

      dbLogger.info("[migration-148] ✓ Added 'code-review' phase and 'codeReviewing' status")
    }
  },
  {
    version: 149,
    name: 'blueprint-quality-gates',
    up: (db) => {
      // Gate results were emitted over IPC and then dropped. After a reload the
      // UI could say a task was 'complete' with no record of WHICH gates proved
      // it — or, worse, no record that three of them reported `unverifiable` and
      // the work shipped unproven. The ledger only means something if it survives.
      //
      // `packet_json` is on the task rather than parsed out of the tasks artifact
      // on demand because the packet is the gate contract: the write-set G4
      // enforces has to be the one the builder was given, not a re-parse of an
      // artifact a later phase may have rewritten.
      //
      // Additive ALTERs — no rebuild, and ignoring the columns reverts the change.
      db.exec(`ALTER TABLE blueprint_tasks ADD COLUMN packet_json TEXT`)
      db.exec(`ALTER TABLE blueprint_tasks ADD COLUMN gates_json TEXT`)
      db.exec(`ALTER TABLE blueprint_tasks ADD COLUMN unverified_json TEXT`)
      db.exec(`ALTER TABLE blueprint_tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`)
      db.exec(`ALTER TABLE blueprint_tasks ADD COLUMN escalated_to TEXT`)

      // Blueprint-level rollup: the accumulated unverified ledger decides whether
      // the run completes clean or completes flagged.
      db.exec(`ALTER TABLE blueprints ADD COLUMN unverified_json TEXT`)

      dbLogger.info('[migration-149] ✓ Added blueprint quality-gate columns')
    }
  },
  {
    version: 150,
    name: 'usage-attribution',
    up: (db) => {
      // Token rows recorded WHICH model burned the tokens but not which provider
      // served it or which unit of work asked for it. `model` was the only proxy
      // for provider and it is unreliable — OpenCode serves Claude-named models,
      // so a row reading 'claude-opus-5' could have come from either path. The
      // question "what does a blueprint cost on OpenCode vs Claude" was not
      // answerable even in principle.
      //
      // `provider` stores the LLM provider ('claude'|'local-llm'|'glm'), not the
      // executor backend: the backend is a pure function of the provider, so
      // nothing is lost, while storing the backend would merge free local models
      // and paid GLM into one 'opencode' bucket.
      //
      // blueprint_id / task_id / attempt exist for the same reason: joining a
      // usage row back to a blueprint meant string-parsing conversation_id.
      //
      // Additive ALTERs, all nullable — every existing row and every non-blueprint
      // feature keeps working, and ignoring the columns reverts the change.
      db.exec(`ALTER TABLE usage_log ADD COLUMN provider TEXT`)
      db.exec(`ALTER TABLE usage_log ADD COLUMN blueprint_id TEXT`)
      db.exec(`ALTER TABLE usage_log ADD COLUMN task_id TEXT`)
      db.exec(`ALTER TABLE usage_log ADD COLUMN attempt INTEGER`)

      db.exec(`ALTER TABLE turn_usage ADD COLUMN provider TEXT`)
      db.exec(`ALTER TABLE turn_usage ADD COLUMN blueprint_id TEXT`)
      db.exec(`ALTER TABLE turn_usage ADD COLUMN task_id TEXT`)
      db.exec(`ALTER TABLE turn_usage ADD COLUMN attempt INTEGER`)

      db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_log_blueprint ON usage_log(blueprint_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_turn_usage_blueprint ON turn_usage(blueprint_id)`)

      // Historical rows keep NULL provider — the backend that served them is not
      // inferable after the fact, and a guess would be worse than an absence.
      dbLogger.info('[migration-150] ✓ Added usage attribution columns')
    }
  },
  {
    version: 151,
    name: 'memory-legacy-tier-amnesty',
    up: (db) => {
      // Migration 119 replaced the bare `confirmation_count` with an event log,
      // and in doing so destroyed the history it was migrating. It backfilled
      // every historical confirmation as source_type='auto_dedup' — which the
      // promotion rules filter out of the evidence set entirely — gave every
      // backfilled row the fact's own created_at (so distinctDays = 1), and then
      // demoted every active T2/T3 fact to T1.
      //
      // The net effect on any workspace that predates 119: years of corroboration
      // became invisible, the tiers that corroboration had earned were reset, and
      // no amount of re-evaluation could recover either. Facts do not un-become
      // true because we changed how we store evidence.
      //
      // This grants back a tier derived from the surviving `confirmation_count`,
      // and only to facts whose evidence is *entirely* the 119 backfill (weight
      // 0.5 is that backfill's fingerprint — nothing else has ever written it).
      // A fact that has earned real evidence since is left alone: the normal
      // gates already speak for it.
      //
      // Capped at T2. T3 keeps its human gate — amnesty restores what was taken,
      // it does not hand out a tier that always required a person to agree.
      const grant = (minCount: number, tier: number): number =>
        db
          .prepare(
            `UPDATE memory_facts SET tier = ?, updated_at = datetime('now')
             WHERE status = 'active'
               AND volatile = 0
               AND tier < ?
               AND confirmation_count >= ?
               AND EXISTS (
                 SELECT 1 FROM memory_confirmations c
                 WHERE c.fact_id = memory_facts.id
                   AND c.source_type = 'auto_dedup' AND c.weight = 0.5
               )
               AND NOT EXISTS (
                 SELECT 1 FROM memory_confirmations c
                 WHERE c.fact_id = memory_facts.id AND c.source_type != 'auto_dedup'
               )`
          )
          .run(tier, tier, minCount).changes

      // T2 first: the `tier < ?` guard then excludes those rows from the T1 pass,
      // so a 5-confirm fact is never walked back down to T1.
      const toT2 = grant(5, 2)
      const toT1 = grant(3, 1)

      if (toT1 + toT2 > 0) {
        dbLogger.info(`[migration-151] Restored ${toT1} facts to T1 and ${toT2} to T2`)
      }
      dbLogger.info('[migration-151] ✓ Legacy memory tier amnesty complete')
    }
  },
  {
    version: 152,
    name: 'turn-usage-prefix-tokens',
    up: (db) => {
      // `context_tokens` was being read as "the prefix floor" and it is not that.
      // TokenAccountant.accumulateFromMessageStart OVERWRITES its snapshot on
      // every API round-trip, so the stored value is the LAST call of an agentic
      // loop — after every tool result has accumulated — not the prompt we sent.
      // Measured on the packaged DB: a blueprint task with input_tokens = 22 and
      // cache_read = 1,014,653 stored context_tokens = 102,986, i.e. ~10 round
      // trips each re-reading ~103 K. The statically measured BUILD prefix is
      // ~22-35 K tokens, so ~68-78 % of that "floor" is in-loop accumulation.
      //
      // prefix_tokens records the FIRST round-trip's prompt size instead — the
      // invariant prefix, the only quantity prefix-reduction work can be judged
      // against. context_tokens keeps its current meaning (end-of-loop occupancy,
      // which the compaction badge and modal read).
      //
      // Nullable and additive: historical rows keep NULL (it is not
      // reconstructible), and ignoring the column reverts the change.
      db.exec(`ALTER TABLE turn_usage ADD COLUMN prefix_tokens INTEGER`)

      dbLogger.info('[migration-152] ✓ Added turn_usage.prefix_tokens')
    }
  },
  {
    version: 153,
    name: 'track-base-source',
    up: (db) => {
      // `base_branch` says WHERE a track forked from; it never said WHY, and
      // the why is the part that cannot be recovered later. The checkout moves,
      // the workspace setting changes, the integration branch advances — so by
      // the time somebody asks "why did this blueprint fork from there?", every
      // input to that decision has already changed underneath them. That is the
      // exact shape of the incident this column exists to prevent recurring.
      //
      // Values are the resolution rules in order ('blueprint-fork',
      // 'workspace-setting', 'checkout', 'repo-default', 'fallback') plus
      // 'existing-branch', which is not a rule: it records that the branch was
      // already present, so `worktree add` used its own tip and no base was
      // consulted at all.
      //
      // Nullable and additive: existing tracks keep NULL (their source is not
      // reconstructible, and inventing 'checkout' for all of them would be the
      // same confident guess this column exists to replace), and ignoring the
      // column reverts the change.
      db.exec(`ALTER TABLE work_tracks ADD COLUMN base_source TEXT`)

      dbLogger.info('[migration-153] ✓ Added work_tracks.base_source')
    }
  },
  {
    version: 154,
    name: 'track-base-commit',
    up: (db) => {
      // `base_branch` names a moving target. Asking "what did this run fork
      // from?" six weeks later resolves that name against a branch that has
      // since advanced, been rebased, or been deleted — so the honest answer
      // only exists if it was written down at the time.
      //
      // Recorded only when the caller can vouch for it: a blueprint whose
      // branch was reconciled to its base knows the commit exactly, and a
      // branch left alone because it carried its own work writes NULL rather
      // than a tip it never started from.
      //
      // Nullable and additive: existing tracks keep NULL (the branch reflog is
      // the only other record, and it expires), and ignoring the column
      // reverts the change.
      db.exec(`ALTER TABLE work_tracks ADD COLUMN base_commit TEXT`)

      dbLogger.info('[migration-154] ✓ Added work_tracks.base_commit')
    }
  },
  {
    version: 155,
    name: 'memory-confirmations-retrieval-source-type',
    // Rebuilds memory_confirmations, which memory_facts is the FK parent of.
    disableForeignKeys: true,
    up: (db) => {
      // Retrieval becomes evidence. Until now the only promotable confirmation
      // came from a fact being independently re-extracted, so a convention that
      // was retrieved and used every day — and never contradicted — accrued no
      // evidence at all and sat at T0 forever. Recording use as a weak,
      // once-per-day signal is what lets steady usage carry a fact to T1.
      //
      // SQLite cannot ALTER a CHECK in place, so this is the rebuild-and-copy
      // pattern from migration 70.
      const existing = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_confirmations'`)
        .get() as { sql: string } | undefined

      // Idempotent: skip when the table is absent or already widened.
      if (!existing || existing.sql.includes("'retrieval'")) {
        dbLogger.info('[migration-155] ✓ memory_confirmations CHECK already current — skipped')
        return
      }

      db.exec(`
        CREATE TABLE memory_confirmations_new (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          fact_id TEXT NOT NULL REFERENCES memory_facts(id) ON DELETE CASCADE,
          source_type TEXT NOT NULL CHECK (source_type IN ('auto_dedup','human','tool','extraction','bootstrap','retrieval')),
          weight REAL NOT NULL DEFAULT 1.0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO memory_confirmations_new (id, fact_id, source_type, weight, created_at)
          SELECT id, fact_id, source_type, weight, created_at FROM memory_confirmations;
        DROP TABLE memory_confirmations;
        ALTER TABLE memory_confirmations_new RENAME TO memory_confirmations;
        CREATE INDEX IF NOT EXISTS idx_memory_confirmations_fact ON memory_confirmations(fact_id);
        CREATE INDEX IF NOT EXISTS idx_memory_confirmations_date ON memory_confirmations(created_at);
      `)

      dbLogger.info("[migration-155] ✓ memory_confirmations accepts 'retrieval' source type")
    }
  },
  {
    version: 156,
    name: 'blueprint-telemetry',
    up: (db) => {
      // E11 — attempt-level telemetry for blueprint execution. Until now the
      // decisions that matter most operationally (why a task was retried, why a
      // ladder stopped early, why parallelism dropped) existed only as log lines
      // and in-memory `SchedulerStats`, so every tuning question about them was
      // answered by guessing.
      //
      // A NEW TABLE, not a widening of `events`. `events.category` carries a
      // CHECK that schema.sql and the migrated chain have disagreed about since
      // migration 44: it added 'telemetry' to schema.sql and, in its own comment,
      // explicitly skipped rebuilding the table for existing installs. Writing
      // telemetry to `events` would therefore pass on a fresh dev database and
      // violate the CHECK on any upgraded one. Widening a shared, hot table to
      // serve one feature is exactly what produced that divergence.
      //
      // `kind` has NO CHECK, deliberately: adding a telemetry kind must never
      // require a table rebuild. That is the lesson of migration 44, applied.
      //
      // `blueprint_id` carries no FK. Telemetry outlives the run it describes —
      // the point is to still have the trail after a blueprint is deleted — and
      // pruning is by age, via `pruneOlderThan`.
      db.exec(`
        CREATE TABLE IF NOT EXISTS blueprint_telemetry (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          blueprint_id TEXT NOT NULL,
          phase TEXT,
          task_id TEXT,
          attempt INTEGER,
          kind TEXT NOT NULL,
          data_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_bp_telemetry_blueprint ON blueprint_telemetry(blueprint_id)`
      )
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_bp_telemetry_kind ON blueprint_telemetry(kind, created_at)`
      )

      dbLogger.info('[migration-156] ✓ Added blueprint_telemetry')
    }
  }
]

/**
 * Run only pending migrations (where version > current user_version).
 * Each migration is wrapped in a transaction that atomically updates user_version.
 * Failed migrations throw instead of being silently swallowed.
 */
function runMigrations(database: Database.Database): void {
  const currentVersion = (database.pragma('user_version', { simple: true }) as number) ?? 0
  dbLogger.info(`Schema version: ${currentVersion}, target: ${CURRENT_SCHEMA_VERSION}`)

  const pending = migrations.filter((m) => m.version > currentVersion)
  if (pending.length === 0) {
    dbLogger.info('✓ Schema up to date — no migrations needed')
    return
  }

  dbLogger.info(`Running ${pending.length} pending migration(s)...`)

  for (const migration of pending) {
    dbLogger.info(`Running migration v${migration.version}: ${migration.name}`)
    const needsFkOff = migration.disableForeignKeys === true
    try {
      if (needsFkOff) {
        // PRAGMA foreign_keys cannot be changed inside a transaction.
        // Disable BEFORE the transaction to prevent CASCADE side-effects
        // when parent tables are rebuilt via DROP TABLE + RENAME.
        database.pragma('foreign_keys = OFF')
      }
      database.transaction(() => {
        migration.up(database)
        database.pragma(`user_version = ${migration.version}`)
      })()
      if (needsFkOff) {
        database.pragma('foreign_keys = ON')
        // Verify FK integrity wasn't broken by the rebuild
        const violations = database.pragma('foreign_key_check') as unknown[]
        if (violations.length > 0) {
          dbLogger.error(
            `[DB] FK violations after migration v${migration.version}:`,
            violations.slice(0, 10)
          )
        }
      }
      dbLogger.info(`✓ Migration v${migration.version} complete`)
    } catch (error) {
      // Re-enable FK enforcement even on failure
      if (needsFkOff) {
        try {
          database.pragma('foreign_keys = ON')
        } catch {
          /* best-effort */
        }
      }
      // Tolerate "duplicate column" errors when schema.sql already includes the column.
      // This happens on fresh DBs where CREATE TABLE includes columns that ALTER TABLE
      // migrations try to re-add. Advance user_version so we don't retry.
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('duplicate column name')) {
        dbLogger.warn(`⚠ Migration v${migration.version} skipped (column already exists)`)
        database.pragma(`user_version = ${migration.version}`)
      } else {
        dbLogger.error(`✗ Migration v${migration.version} (${migration.name}) FAILED:`, error)
        throw error // Don't swallow real errors — surface disk full, corruption, etc.
      }
    }
  }

  dbLogger.info(`✓ All migrations complete — schema at v${CURRENT_SCHEMA_VERSION}`)
}

export function getDatabase(): Database.Database {
  if (db) return db

  // Standalone MCP-server processes run as plain `node` (no Electron app global),
  // so `app.getPath()` is undefined and would crash. They pass DB_PATH explicitly.
  const userDataDir = process.env.DB_PATH ?? getElectronApp().getPath('userData')
  const newDbPath = join(userDataDir, 'code-atelier.db')
  const oldDbPath = join(userDataDir, 'agent-studio.db')

  // Migrate DB filename for existing installations
  if (!existsSync(newDbPath) && existsSync(oldDbPath)) {
    renameSync(oldDbPath, newDbPath)
    dbLogger.info('[DB] Migrated database: agent-studio.db → code-atelier.db')
  }

  const dbPath = newDbPath
  db = new Database(dbPath)

  // Standalone MCP-server processes run as plain `node` (no Electron app global).
  // They pass DB_PATH explicitly. This flag gates several behaviors below:
  // - busy_timeout: MCP servers retry patiently (5s); main process fails fast (500ms)
  // - migrations: only the main process runs schema changes
  // - WAL checkpoint: only the main process checkpoints
  const isStandaloneMcpServer = !!process.env.DB_PATH

  // ── ARM BUSY HANDLER FIRST ──
  // Must be set BEFORE journal_mode = WAL. Switching to WAL creates/recovers
  // the -wal/-shm files and takes a brief exclusive lock. Without busy_timeout
  // armed first, a concurrent opener gets instant SQLITE_BUSY (0ms wait) instead
  // of retrying. Same bug as Cursor SDK #166153 (July 2026, confirmed & fixed).
  //
  // Split by process role:
  // - Main Electron process: 500ms (fail fast enough to avoid UI jank,
  //   but not so aggressive that legitimate short contention triggers
  //   spurious SQLITE_BUSY errors. better-sqlite3 recommends ≥1000ms
  //   even for "max performance" — 500ms is a pragmatic middle ground.)
  // - Standalone MCP servers: 5000ms (retry patiently, no UI to block)
  db.pragma(`busy_timeout = ${isStandaloneMcpServer ? 5000 : 500}`)

  // Enable WAL mode for crash-safe writes.
  // Now safe — busy handler will retry if the WAL switch contends for a lock.
  db.pragma('journal_mode = WAL')

  // Cap WAL file growth. Without this, checkpoint starvation can let the WAL
  // grow unboundedly (Cursor's 2.1 GB write storm, May 2026, was exactly this).
  // 256 MB is generous for any reasonable write burst but prevents disk exhaustion.
  // SQLite truncates the WAL to this size after each successful checkpoint.
  db.pragma('journal_size_limit = 268435456') // 256 MB

  db.pragma('foreign_keys = ON')

  // Run schema (creates tables if not exist) — inlined at build time via ?raw import
  db.exec(SCHEMA_SQL)

  // Run versioned migrations (only pending ones).
  // Standalone MCP-server processes (spawned with DB_PATH) must NOT run migrations —
  // the Electron main process owns schema changes; racing two writers corrupts state.
  if (!isStandaloneMcpServer) {
    try {
      runMigrations(db)
    } catch (migrationError) {
      // Zombie-state prevention: if migrations fail, close the DB and null out
      // the singleton so the app doesn't silently run on an unmigrated schema.
      dbLogger.error('[DB] Migration failed — closing DB to prevent zombie state:', migrationError)
      try {
        db.close()
      } catch {
        /* best-effort close */
      }
      db = null
      throw migrationError
    }
  } else {
    dbLogger.info('[DB] Standalone MCP server — skipping migrations (main process owns schema)')
  }

  // WAL checkpoint to reclaim space.
  // PASSIVE: checkpoints what it can without blocking — never stalls the main
  // thread waiting for readers/writers to finish. SQLite auto-checkpoints at
  // 1000 WAL pages anyway, so this is just an opportunistic housekeeping nudge.
  // TRUNCATE was replaced because it forces a full WAL replay synchronously,
  // which blocks the main thread for seconds on NTFS with large WAL files.
  // Standalone MCP servers skip checkpointing entirely — the main process owns it.
  if (!isStandaloneMcpServer) {
    db.pragma('wal_checkpoint(PASSIVE)')
  }

  // ── DB + WAL size monitoring ──
  // Log a warning if the database or WAL file exceeds safe thresholds. Catches
  // Cursor-style growth problems (state.vscdb hit 390 MB; WAL write storm
  // reached 2.1 GB in 9 min) before they become crashes or disk exhaustion.
  if (!isStandaloneMcpServer) {
    try {
      const dbSizeBytes = statSync(dbPath).size
      const dbSizeMB = Math.round(dbSizeBytes / (1024 * 1024))
      if (dbSizeBytes > 2 * 1024 * 1024 * 1024) {
        dbLogger.warn(
          `[DB] ⚠ Database file is ${dbSizeMB} MB — consider re-indexing or cleaning old workspace data`
        )
      } else if (dbSizeBytes > 1024 * 1024 * 1024) {
        dbLogger.info(`[DB] Database file is ${dbSizeMB} MB — approaching large size`)
      }

      // WAL file can grow independently of the main DB file. Checkpoint starvation
      // (everlasting concurrent reads preventing WAL recycling) lets it grow without
      // bound. journal_size_limit caps it at 256 MB after each successful checkpoint,
      // but if checkpoints keep failing, the WAL can still bloat.
      const walPath = dbPath + '-wal'
      if (existsSync(walPath)) {
        const walSizeBytes = statSync(walPath).size
        const walSizeMB = Math.round(walSizeBytes / (1024 * 1024))
        if (walSizeBytes > 256 * 1024 * 1024) {
          dbLogger.warn(`[DB] ⚠ WAL file is ${walSizeMB} MB — possible checkpoint starvation`)
        } else if (walSizeBytes > 128 * 1024 * 1024) {
          dbLogger.info(`[DB] WAL file is ${walSizeMB} MB — elevated but within limits`)
        }
      }
    } catch {
      // Best-effort — don't block startup if stat fails
    }
  }

  // Seed default data (idempotent — checks count before inserting)
  seedDefaultSpecialists(db)
  seedDefaultSkills(db)

  // DB-MAINT: reclaim freelist pages in the background if they exceed the
  // threshold (v1.0.89: 454MB of the 579MB packaged store was freelist).
  //
  // blueprint.service imports db/index for getDatabase(), so it is pulled in
  // lazily to avoid a load-time cycle — but with import(), never require().
  // A relative require() is emitted verbatim by electron-vite and then resolves
  // against the flat out/main layout instead of the source tree: that is how
  // `require('./maintenance')` threw MODULE_NOT_FOUND on every boot from 1.0.94
  // to 1.0.99, silently disabling VACUUM. import() is rewritten to the emitted
  // chunk and keeps the module in the bundle graph.
  if (!isStandaloneMcpServer) {
    // Bind the handle we just opened rather than re-reading the module-level
    // `db`, which may have been reassigned by the time the import resolves.
    const opened = db
    void import('../services/blueprint.service')
      .then(({ blueprintService }) => {
        maybeVacuumInBackground(opened, dbPath, () => blueprintService.hasAnyRunningPipeline())
      })
      .catch((err: NodeJS.ErrnoException) => {
        // A missing module is a broken build, never a runtime condition to
        // tolerate — keep it distinct from "deferred because the DB was busy".
        if (err?.code === 'MODULE_NOT_FOUND') {
          dbLogger.error(
            '[DB] VACUUM disabled — maintenance dependency missing from this build:',
            err
          )
        } else {
          dbLogger.warn('[DB] Failed to schedule maintenance VACUUM:', err)
        }
      })
  }

  return db
}

export function closeDatabase(): void {
  if (db) {
    // Force WAL checkpoint at clean shutdown to reclaim disk space.
    // TRUNCATE resets the WAL file to zero bytes. This is safe at shutdown
    // because all services have already stopped — no concurrent readers/writers.
    // If MCP servers are still alive (shouldn't be), TRUNCATE will checkpoint
    // what it can and proceed.
    try {
      db.pragma('wal_checkpoint(TRUNCATE)')
    } catch {
      // Best-effort — don't prevent shutdown if checkpoint fails
    }
    db.close()
    db = null
  }
}

/**
 * @internal Test-only: override the database instance for unit/integration tests.
 * Allows tests to inject an in-memory DB without requiring Electron's app.getPath().
 * Guarded by NODE_ENV to prevent accidental use in production.
 */
export function _setDatabaseForTesting(testDb: Database.Database): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_setDatabaseForTesting is only available in test mode')
  }
  db = testDb
}

function seedDefaultSpecialists(database: Database.Database): void {
  const count = database.prepare('SELECT COUNT(*) as cnt FROM specialists').get() as {
    cnt: number
  }
  if (count.cnt > 0) return

  const insert = database.prepare(`
    INSERT INTO specialists (agent_id, display_name, icon, color, priority)
    VALUES (?, ?, ?, ?, ?)
  `)

  const defaults = [
    {
      agentId: 'generalist',
      displayName: 'Da Vinci',
      icon: '🎨',
      color: '#D97706',
      priority: 0
    },
    {
      agentId: 'react-architect',
      displayName: 'React Architect',
      icon: '⚛️',
      color: '#61DAFB',
      priority: 2
    },
    {
      agentId: 'dotnet-architect',
      displayName: '.NET Architect',
      icon: '🟣',
      color: '#512BD4',
      priority: 3
    },
    {
      agentId: 'electron-architect',
      displayName: 'Electron Architect',
      icon: '⚡',
      color: '#47848F',
      priority: 4
    },
    {
      agentId: 'agentic-architect',
      displayName: 'Agentic Architect',
      icon: '🤖',
      color: '#D97706',
      priority: 5
    },
    {
      agentId: 'db-architect',
      displayName: 'DB Architect',
      icon: '🗄️',
      color: '#336791',
      priority: 6
    },
    {
      agentId: 'ux-ui-specialist',
      displayName: 'UX/UI Specialist',
      icon: '🎨',
      color: '#DB2777',
      priority: 7
    },
    {
      agentId: 'git-github-specialist',
      displayName: 'Git/GitHub Specialist',
      icon: '🔀',
      color: '#64748B',
      priority: 8
    },
    {
      agentId: 'requirements-specialist',
      displayName: 'Requirements Specialist',
      icon: '📋',
      color: '#059669',
      priority: 9
    },
    {
      agentId: 'code-planner',
      displayName: 'Code Planner',
      icon: '📝',
      color: '#475569',
      priority: 10
    },
    {
      agentId: 'execution-planner',
      displayName: 'Execution Planner',
      icon: '📅',
      color: '#DC6843',
      priority: 11
    },
    {
      agentId: 'cicd-devops',
      displayName: 'CI/CD DevOps',
      icon: '🚀',
      color: '#DC2626',
      priority: 12
    },
    {
      agentId: 'cloud-infrastructure',
      displayName: 'Cloud Infrastructure',
      icon: '☁️',
      color: '#0D9488',
      priority: 13
    }
  ]

  const tx = database.transaction(() => {
    for (const s of defaults) {
      insert.run(s.agentId, s.displayName, s.icon, s.color, s.priority)
    }
  })
  tx()
}

function seedDefaultSkills(database: Database.Database): void {
  const count = database.prepare('SELECT COUNT(*) as cnt FROM skills').get() as { cnt: number }
  if (count.cnt > 0) return

  database
    .prepare(
      `
    INSERT INTO skills (name, description, filename, file_path, is_active, last_updated_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      'Electron Pro',
      'Use this skill for ANY Electron desktop application work including IPC, security, packaging, and native OS integration.',
      'electron-pro.md',
      '.claude/skills/electron-pro/SKILL.md',
      1,
      '2026-03-21'
    )
}
