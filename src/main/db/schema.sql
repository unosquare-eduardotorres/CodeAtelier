-- Workspaces: registered projects
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL UNIQUE,
  git_remote_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  settings_json TEXT DEFAULT '{}'
);

-- Conversations: chat sessions per workspace
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

-- Messages: individual chat messages
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'coordinator', 'specialist', 'generalist')),
  agent_id TEXT,
  content_md TEXT NOT NULL,
  attachments_json TEXT DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Attachments: context files uploaded by user
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

-- Agent sessions: basic tracking for Phase 1
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

-- Specialists: dynamic agent definitions (app-global)
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

-- Skills: importable .MD skill files (app-global)
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

-- Junction: many-to-many specialists <-> skills
CREATE TABLE IF NOT EXISTS specialist_skills (
  specialist_id TEXT NOT NULL REFERENCES specialists(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (specialist_id, skill_id)
);

-- File changes tracked per conversation (for selective git commit)
CREATE TABLE IF NOT EXISTS conversation_file_changes (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  change_type TEXT NOT NULL DEFAULT 'modified' CHECK (change_type IN ('created', 'modified', 'deleted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(conversation_id, file_path)
);

-- Git worktrees for agent isolation during parallel execution
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

CREATE INDEX IF NOT EXISTS idx_conversations_workspace ON conversations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_attachments_conversation ON attachments(conversation_id);
CREATE INDEX IF NOT EXISTS idx_file_changes_conversation ON conversation_file_changes(conversation_id);
CREATE INDEX IF NOT EXISTS idx_specialists_priority ON specialists(priority);
CREATE INDEX IF NOT EXISTS idx_skills_active ON skills(is_active);
