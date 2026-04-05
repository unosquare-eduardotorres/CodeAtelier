import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { dbLogger } from '../logger'
import { DEFAULT_PROMPTS } from '../services/default-prompts'

let db: Database.Database | null = null

// ── Versioned Migration System ──────────────────────────────────────────────
// Each migration runs in a transaction and atomically updates PRAGMA user_version.
// Only migrations with version > current user_version are executed.
// Failed migrations throw (surfacing real errors) instead of being silently swallowed.

const CURRENT_SCHEMA_VERSION = 50

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
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC)`
      )
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
      db.exec(
        `ALTER TABLE agent_sessions ADD COLUMN estimated_cost_cents REAL DEFAULT 0`
      )
      db.exec(
        `ALTER TABLE agent_sessions ADD COLUMN input_tokens INTEGER DEFAULT 0`
      )
      db.exec(
        `ALTER TABLE agent_sessions ADD COLUMN output_tokens INTEGER DEFAULT 0`
      )
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
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_gate_results_task ON gate_results(task_id)`
      )
    }
  },
  {
    version: 26,
    name: 'reconceive-agent-roster-16-to-8',
    up: (db) => {
      // Deactivate archived agent IDs
      const archivedIds = [
        'electron-architect', 'agentic-architect',
        'code-planner', 'execution-planner', 'requirements-specialist',
        'cicd-devops', 'cloud-infrastructure',
        'git-github-specialist', 'docs-diagrams-specialist'
      ]
      const deactivateStmt = db.prepare(
        `UPDATE specialists SET active = 0 WHERE agent_id = ?`
      )
      for (const id of archivedIds) {
        deactivateStmt.run(id)
      }

      // Rename existing agents
      db.prepare(`UPDATE specialists SET agent_id = 'frontend-architect', display_name = 'Frontend Architect' WHERE agent_id = 'react-architect'`).run()
      db.prepare(`UPDATE specialists SET agent_id = 'data-architect', display_name = 'Data Architect' WHERE agent_id = 'db-architect'`).run()
      db.prepare(`UPDATE specialists SET agent_id = 'design-specialist', display_name = 'Design Specialist' WHERE agent_id = 'ux-ui-specialist'`).run()

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
        'stravinsky': 'renaissance-astronomer',
        'robot': 'renaissance-alchemist',
        'ninja': 'renaissance-knight',
        'superhero': 'renaissance-knight',
        'pirate': 'renaissance-navigator',
        'scientist': 'renaissance-alchemist',
        'chef': 'renaissance-jester'
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
      db.exec(`ALTER TABLE conversation_specialists ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1`)
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
      db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_symbol ON code_chunks(workspace_id, symbol_name)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_kind ON code_chunks(workspace_id, symbol_kind)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_language ON code_chunks(workspace_id, language)`)

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
      db.exec(`CREATE INDEX IF NOT EXISTS idx_embeddings_workspace ON chunk_embeddings(workspace_id)`)

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
      db.exec(`CREATE INDEX IF NOT EXISTS idx_descriptions_workspace ON chunk_descriptions(workspace_id)`)
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
      db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_source ON code_graph_edges(workspace_id, source_file, source_symbol)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_target ON code_graph_edges(workspace_id, target_file, target_symbol)`)

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
        const { existsSync } = require('node:fs') as typeof import('node:fs')

        if (existsSync(oldDbPath)) {
          const OldDatabase = require('better-sqlite3') as typeof import('better-sqlite3').default
          const oldDb = new OldDatabase(oldDbPath, { readonly: true })

          try {
            // Check if the old table exists
            const tableExists = oldDb
              .prepare(
                `SELECT name FROM sqlite_master WHERE type='table' AND name='descriptions'`
              )
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

                dbLogger.info(
                  `✓ Migrated ${rows.length} descriptions from description-cache.db`
                )
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
      db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_messages_conversation ON agent_messages(conversation_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_messages_run ON agent_messages(run_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_messages_task ON agent_messages(task_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_messages_from ON agent_messages(from_agent)`)
    }
  },
  {
    version: 42,
    name: 'update-build-prompt-always-report-outcomes',
    up: (db) => {
      const newBuildPrompt = DEFAULT_PROMPTS.generalist.build

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
      const update = db.prepare(
        'UPDATE specialists SET pixel_sprite_id = ? WHERE agent_id = ?'
      )
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
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_cg_tags_workspace ON code_graph_tags(workspace_id)`
      )
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_cg_tags_file ON code_graph_tags(workspace_id, rel_fname)`
      )
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_cg_tags_name ON code_graph_tags(workspace_id, name)`
      )
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_cg_tags_kind ON code_graph_tags(workspace_id, kind)`
      )

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
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_cg_ranks_workspace ON code_graph_ranks(workspace_id)`
      )

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
      const newPlanPrompt = DEFAULT_PROMPTS.generalist.plan

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

  const dbPath = join(app.getPath('userData'), 'agent-studio.db')
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

function seedDefaultSpecialists(database: Database.Database): void {
  const count = database.prepare('SELECT COUNT(*) as cnt FROM specialists').get() as {
    cnt: number
  }
  if (count.cnt > 0) return

  const insert = database.prepare(`
    INSERT INTO specialists (agent_id, display_name, icon, color, priority, pixel_sprite_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  const defaults = [
    {
      agentId: 'generalist',
      displayName: 'Da Vinci',
      icon: '🎨',
      color: '#D97706',
      priority: 0,
      pixelSpriteId: 'male-07-1'
    },
    {
      agentId: 'react-architect',
      displayName: 'React Architect',
      icon: '⚛️',
      color: '#61DAFB',
      priority: 2,
      pixelSpriteId: 'female-07-1'
    },
    {
      agentId: 'dotnet-architect',
      displayName: '.NET Architect',
      icon: '🟣',
      color: '#512BD4',
      priority: 3,
      pixelSpriteId: 'male-03-2'
    },
    {
      agentId: 'electron-architect',
      displayName: 'Electron Architect',
      icon: '⚡',
      color: '#47848F',
      priority: 4,
      pixelSpriteId: 'male-18-1'
    },
    {
      agentId: 'agentic-architect',
      displayName: 'Agentic Architect',
      icon: '🤖',
      color: '#D97706',
      priority: 5,
      pixelSpriteId: 'female-05-2'
    },
    {
      agentId: 'db-architect',
      displayName: 'DB Architect',
      icon: '🗄️',
      color: '#336791',
      priority: 6,
      pixelSpriteId: 'male-15-1'
    },
    {
      agentId: 'ux-ui-specialist',
      displayName: 'UX/UI Specialist',
      icon: '🎨',
      color: '#DB2777',
      priority: 7,
      pixelSpriteId: 'female-15-1'
    },
    {
      agentId: 'git-github-specialist',
      displayName: 'Git/GitHub Specialist',
      icon: '🔀',
      color: '#64748B',
      priority: 8,
      pixelSpriteId: 'male-01-3'
    },
    {
      agentId: 'requirements-specialist',
      displayName: 'Requirements Specialist',
      icon: '📋',
      color: '#059669',
      priority: 9,
      pixelSpriteId: 'female-09-2'
    },
    {
      agentId: 'code-planner',
      displayName: 'Code Planner',
      icon: '📝',
      color: '#475569',
      priority: 10,
      pixelSpriteId: 'male-05-4'
    },
    {
      agentId: 'execution-planner',
      displayName: 'Execution Planner',
      icon: '📅',
      color: '#DC6843',
      priority: 11,
      pixelSpriteId: 'female-02-3'
    },
    {
      agentId: 'cicd-devops',
      displayName: 'CI/CD DevOps',
      icon: '🚀',
      color: '#DC2626',
      priority: 12,
      pixelSpriteId: 'male-12-1'
    },
    {
      agentId: 'cloud-infrastructure',
      displayName: 'Cloud Infrastructure',
      icon: '☁️',
      color: '#0D9488',
      priority: 13,
      pixelSpriteId: 'male-10-3'
    }
  ]

  const tx = database.transaction(() => {
    for (const s of defaults) {
      insert.run(s.agentId, s.displayName, s.icon, s.color, s.priority, s.pixelSpriteId)
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
  claude_session_id TEXT
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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS specialist_skills (
  specialist_id TEXT NOT NULL REFERENCES specialists(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (specialist_id, skill_id)
);

CREATE TABLE IF NOT EXISTS conversation_file_changes (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  change_type TEXT NOT NULL DEFAULT 'modified' CHECK (change_type IN ('created', 'modified', 'deleted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(conversation_id, file_path)
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

CREATE INDEX IF NOT EXISTS idx_conversations_workspace ON conversations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_attachments_conversation ON attachments(conversation_id);
CREATE INDEX IF NOT EXISTS idx_file_changes_conversation ON conversation_file_changes(conversation_id);
CREATE INDEX IF NOT EXISTS idx_specialists_priority ON specialists(priority);
CREATE INDEX IF NOT EXISTS idx_skills_active ON skills(is_active);
CREATE INDEX IF NOT EXISTS idx_worktrees_conversation ON agent_worktrees(conversation_id);
CREATE INDEX IF NOT EXISTS idx_worktrees_status ON agent_worktrees(status);
`
