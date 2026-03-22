import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { dbLogger } from '../logger'

let db: Database.Database | null = null

export function getDatabase(): Database.Database {
  if (db) return db

  const dbPath = join(app.getPath('userData'), 'agent-studio.db')
  db = new Database(dbPath)

  // Enable WAL mode for crash-safe writes
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // Run schema migration
  const schemaPath = join(__dirname, 'schema.sql')
  try {
    const schema = readFileSync(schemaPath, 'utf-8')
    db.exec(schema)
  } catch {
    // If schema.sql isn't bundled, use inline schema
    db.exec(SCHEMA_SQL)
  }

  // Migration: add mode column to existing conversations table
  try {
    db.exec(
      `ALTER TABLE conversations ADD COLUMN mode TEXT NOT NULL DEFAULT 'plan' CHECK (mode IN ('plan', 'build'))`
    )
    dbLogger.info('Migration: added mode column to conversations')
  } catch {
    // Column already exists — ignore
  }

  // Migration: update messages table CHECK constraint to include 'generalist' role
  try {
    const tableInfo = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'")
      .get() as { sql: string } | undefined

    if (tableInfo && !tableInfo.sql.includes("'generalist'")) {
      dbLogger.info('Migration: updating messages CHECK constraint to include generalist role')
      db.transaction(() => {
        db!.exec(`
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
      })()
      dbLogger.info('Migration: messages CHECK constraint updated successfully')
    } else {
      dbLogger.info('✓ Messages table already has generalist role — no migration needed')
    }
  } catch (e) {
    dbLogger.error('Migration: failed to update messages CHECK constraint:', e)
  }

  dbLogger.info('✓ Messages table CHECK constraint verified (includes generalist)')

  // Seed default data
  seedDefaultSpecialists(db)
  seedDefaultSkills(db)

  // Migration: ensure generalist exists in specialists table
  try {
    const generalistExists = db
      .prepare("SELECT 1 FROM specialists WHERE agent_id = 'generalist'")
      .get()
    if (!generalistExists) {
      db.prepare(
        'INSERT INTO specialists (agent_id, display_name, icon, color, priority) VALUES (?, ?, ?, ?, ?)'
      ).run('generalist', 'Generalist', '💬', '#6366F1', 0)
    }
  } catch {
    /* ignore */
  }

  // Migration: rename postgres-architect → db-architect
  try {
    db.prepare(
      "UPDATE specialists SET agent_id = 'db-architect', display_name = 'DB Architect', icon = '🗄️' WHERE agent_id = 'postgres-architect'"
    ).run()
  } catch {
    /* ignore */
  }

  // Migration: add electron-architect if missing
  try {
    const electronExists = db
      .prepare("SELECT 1 FROM specialists WHERE agent_id = 'electron-architect'")
      .get()
    if (!electronExists) {
      db.prepare(
        'INSERT INTO specialists (agent_id, display_name, icon, color, priority) VALUES (?, ?, ?, ?, ?)'
      ).run('electron-architect', 'Electron Architect', '⚡', '#47848F', 4)
    }
  } catch {
    /* ignore */
  }

  // Migration: add source_yaml column to specialists table
  try {
    db.exec('ALTER TABLE specialists ADD COLUMN source_yaml TEXT DEFAULT NULL')
    dbLogger.info('Migration: added source_yaml column to specialists')
  } catch {
    // Column already exists — ignore
  }

  // Migration: add claude_session_id column to conversations table for --resume support
  try {
    db.exec('ALTER TABLE conversations ADD COLUMN claude_session_id TEXT DEFAULT NULL')
    dbLogger.info('Migration: added claude_session_id column to conversations')
  } catch {
    // Column already exists — ignore
  }

  // Migration: create conversation_file_changes table for per-session file tracking
  try {
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
    dbLogger.info('Migration: conversation_file_changes table ready')
  } catch {
    // Table already exists — ignore
  }

  // Migration: create agent_worktrees table for worktree-based agent isolation
  try {
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
    dbLogger.info('Migration: agent_worktrees table ready')
  } catch {
    // Table already exists — ignore
  }

  return db
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}

function seedDefaultSpecialists(database: Database.Database): void {
  const count = database.prepare('SELECT COUNT(*) as cnt FROM specialists').get() as { cnt: number }
  if (count.cnt > 0) return

  const insert = database.prepare(`
    INSERT INTO specialists (agent_id, display_name, icon, color, priority)
    VALUES (?, ?, ?, ?, ?)
  `)

  const defaults = [
    { agentId: 'generalist', displayName: 'Generalist', icon: '💬', color: '#6366F1', priority: 0 },
    {
      agentId: 'orchestrator',
      displayName: 'Orchestrator',
      icon: '🎯',
      color: '#8B5CF6',
      priority: 1
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
  stdout_log_path TEXT
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
