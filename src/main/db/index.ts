import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'node:path'
import { readFileSync, existsSync, renameSync } from 'node:fs'
import { dbLogger } from '../logger'
import { DEFAULT_PROMPTS } from '../services/default-prompts'
import { runProjectSpecialistMigration } from './migrations/project-specialist-migration'
import { runDropSpecialistMcpColumnsMigration } from './migrations/drop-specialist-mcp-columns-migration'
import { runAddDangerModeMigration } from './migrations/add-danger-mode-migration'

let db: Database.Database | null = null

// ── Versioned Migration System ──────────────────────────────────────────────
// Each migration runs in a transaction and atomically updates PRAGMA user_version.
// Only migrations with version > current user_version are executed.
// Failed migrations throw (surfacing real errors) instead of being silently swallowed.

const CURRENT_SCHEMA_VERSION = 96

interface Migration {
  version: number
  name: string
  up: (db: Database.Database) => void
}

const migrations: Migration[] = [
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
      const avatarKey = profile?.avatar_key ?? 'business-man'

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
        const userDataPath = app.getPath('userData')
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
            parent_message_id TEXT REFERENCES messages_new(id)
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
      db.exec(`ALTER TABLE conversations ADD COLUMN effort TEXT NOT NULL DEFAULT 'high' CHECK (effort IN ('low', 'medium', 'high'))`)
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
    try {
      database.transaction(() => {
        migration.up(database)
        database.pragma(`user_version = ${migration.version}`)
      })()
      dbLogger.info(`✓ Migration v${migration.version} complete`)
    } catch (error) {
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

  const newDbPath = join(app.getPath('userData'), 'code-atelier.db')
  const oldDbPath = join(app.getPath('userData'), 'agent-studio.db')

  // Migrate DB filename for existing installations
  if (!existsSync(newDbPath) && existsSync(oldDbPath)) {
    renameSync(oldDbPath, newDbPath)
    dbLogger.info('[DB] Migrated database: agent-studio.db → code-atelier.db')
  }

  const dbPath = newDbPath
  db = new Database(dbPath)

  // Enable WAL mode for crash-safe writes
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // Run schema (creates tables if not exist)
  const schemaPath = join(__dirname, 'schema.sql')
  try {
    const schema = readFileSync(schemaPath, 'utf-8')
    db.exec(schema)
  } catch {
    // If schema.sql isn't bundled, use inline schema
    db.exec(SCHEMA_SQL)
  }

  // Run versioned migrations (only pending ones)
  runMigrations(db)

  // WAL checkpoint to reclaim space (runs every startup, cheap no-op if WAL is small)
  db.pragma('wal_checkpoint(TRUNCATE)')

  // Seed default data (idempotent — checks count before inserting)
  seedDefaultSpecialists(db)
  seedDefaultSkills(db)

  return db
}

export function closeDatabase(): void {
  if (db) {
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

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL UNIQUE,
  git_remote_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  settings_json TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New Conversation',
  mode TEXT NOT NULL DEFAULT 'plan' CHECK (mode IN ('plan', 'build')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  summary TEXT,
  claude_session_id TEXT,
  mcp_overrides_json TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'coordinator', 'specialist', 'generalist')),
  agent_id TEXT,
  content_md TEXT NOT NULL,
  attachments_json TEXT DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT,
  file_path TEXT NOT NULL,
  extracted_text TEXT,
  token_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  task_id TEXT,
  agent_type TEXT NOT NULL,
  pid INTEGER,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'terminated')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  token_usage INTEGER DEFAULT 0,
  stdout_log_path TEXT,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS specialists (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  agent_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '🔧',
  color TEXT NOT NULL DEFAULT '#6366F1',
  prompt TEXT DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 100,
  is_active INTEGER NOT NULL DEFAULT 1,
  source_yaml TEXT DEFAULT NULL,
  skill_recommendations_json TEXT DEFAULT NULL,
  skill_recommendations_hash TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  filename TEXT NOT NULL UNIQUE,
  file_path TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_updated_date TEXT,
  tier1_json TEXT,
  tier2_instructions TEXT,
  enrichment_json TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS specialist_skills (
  specialist_id TEXT NOT NULL REFERENCES specialists(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (specialist_id, skill_id)
);

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

CREATE INDEX IF NOT EXISTS idx_conversations_workspace ON conversations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_attachments_conversation ON attachments(conversation_id);
CREATE INDEX IF NOT EXISTS idx_specialists_priority ON specialists(priority);
CREATE INDEX IF NOT EXISTS idx_skills_active ON skills(is_active);
CREATE INDEX IF NOT EXISTS idx_worktrees_conversation ON agent_worktrees(conversation_id);
CREATE INDEX IF NOT EXISTS idx_worktrees_status ON agent_worktrees(status);
`
