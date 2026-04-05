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

-- Agent sessions: tracking with workspace/conversation context
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
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  complexity_score INTEGER,
  model_used TEXT,
  complexity_tier TEXT
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
  alias TEXT DEFAULT NULL,
  avatar_url TEXT DEFAULT NULL,
  pixel_sprite_id TEXT DEFAULT NULL,
  use_pixel_for_chat INTEGER NOT NULL DEFAULT 0,
  is_core INTEGER NOT NULL DEFAULT 0,
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

-- Conversation specialist activation: per-conversation active specialist set with skill gating
CREATE TABLE IF NOT EXISTS conversation_specialists (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  specialist_id TEXT NOT NULL REFERENCES specialists(id) ON DELETE CASCADE,
  is_active INTEGER NOT NULL DEFAULT 1,
  skills_enabled INTEGER NOT NULL DEFAULT 1,
  skill_overrides TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(conversation_id, specialist_id)
);

-- Conversation specialist history: activation/deactivation timeline
CREATE TABLE IF NOT EXISTS specialist_conversation_history (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  specialist_id TEXT NOT NULL REFERENCES specialists(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('activated', 'deactivated')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
CREATE INDEX IF NOT EXISTS idx_conversation_specialists_conversation ON conversation_specialists(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversation_specialists_specialist ON conversation_specialists(specialist_id);
CREATE INDEX IF NOT EXISTS idx_specialist_history_conversation ON specialist_conversation_history(conversation_id);
CREATE INDEX IF NOT EXISTS idx_specialist_history_specialist ON specialist_conversation_history(specialist_id);
CREATE INDEX IF NOT EXISTS idx_specialist_history_conversation_created ON specialist_conversation_history(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_workspace ON agent_sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_conversation ON agent_sessions(conversation_id);

-- Ideas: quick-capture work item drafts per workspace
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

-- Memories: auto memory system (persistent cross-session knowledge)
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

-- Dream runs: consolidation cycles that process and refine memories
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

-- User profile: app-wide identity (singleton row)
CREATE TABLE IF NOT EXISTS user_profile (
  id TEXT PRIMARY KEY DEFAULT 'default',
  display_name TEXT NOT NULL DEFAULT 'Developer',
  avatar_key TEXT NOT NULL DEFAULT 'astronaut',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Core agent aliases: personality overrides for generalist & coordinator
CREATE TABLE IF NOT EXISTS core_agent_aliases (
  agent_role TEXT PRIMARY KEY CHECK (agent_role IN ('generalist', 'coordinator')),
  alias TEXT DEFAULT NULL,
  avatar_key TEXT DEFAULT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Core agent prompts: editable system prompts for generalist
CREATE TABLE IF NOT EXISTS core_agent_prompts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  agent_role TEXT NOT NULL CHECK (agent_role IN ('generalist')),
  mode TEXT NOT NULL CHECK (mode IN ('plan', 'build')),
  prompt_text TEXT NOT NULL,
  default_prompt_text TEXT NOT NULL,
  is_custom INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_role, mode)
);

-- Events: structured audit log for agent lifecycle, gates, escalations
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  session_id TEXT,
  conversation_id TEXT,
  workspace_id TEXT,
  event_type TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN (
    'session', 'agent', 'escalation', 'gate', 'abandonment',
    'checkpoint', 'hook', 'budget', 'error', 'telemetry'
  )),
  message TEXT NOT NULL,
  data_json TEXT DEFAULT '{}',
  agent_id TEXT,
  model TEXT,
  sequence_number INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);
CREATE INDEX IF NOT EXISTS idx_events_conversation ON events(conversation_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);

-- Checkpoints: state snapshots for rollback on multi-specialist execution failure
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
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_conversation ON checkpoints(conversation_id);

-- Gate results: quality gate pass/fail records from specialist output
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
);
CREATE INDEX IF NOT EXISTS idx_gate_results_conversation ON gate_results(conversation_id);
CREATE INDEX IF NOT EXISTS idx_gate_results_task ON gate_results(task_id);

-- App-level key-value preferences
CREATE TABLE IF NOT EXISTS app_preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Unified Storage: Code Intelligence Tables ───────────────────────────────

-- Preprocessed code units for semantic search
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
);

CREATE INDEX IF NOT EXISTS idx_chunks_workspace ON code_chunks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON code_chunks(workspace_id, file_path);
CREATE INDEX IF NOT EXISTS idx_chunks_symbol ON code_chunks(workspace_id, symbol_name);
CREATE INDEX IF NOT EXISTS idx_chunks_kind ON code_chunks(workspace_id, symbol_kind);
CREATE INDEX IF NOT EXISTS idx_chunks_language ON code_chunks(workspace_id, language);

-- Vector embeddings stored as BLOBs (768 floats x 4 bytes = 3,072 bytes per vector)
CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunk_id TEXT PRIMARY KEY REFERENCES code_chunks(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_embeddings_workspace ON chunk_embeddings(workspace_id);

-- AI-generated code descriptions (replaces description-cache.db)
CREATE TABLE IF NOT EXISTS chunk_descriptions (
  key TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  model TEXT NOT NULL,
  file_path TEXT NOT NULL,
  symbol_name TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_descriptions_workspace ON chunk_descriptions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_descriptions_file ON chunk_descriptions(file_path);

-- Cached symbol relationships from code graph / repomap
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
);

CREATE INDEX IF NOT EXISTS idx_graph_workspace ON code_graph_edges(workspace_id);
CREATE INDEX IF NOT EXISTS idx_graph_source ON code_graph_edges(workspace_id, source_file, source_symbol);
CREATE INDEX IF NOT EXISTS idx_graph_target ON code_graph_edges(workspace_id, target_file, target_symbol);

-- Tree-sitter tags (def + ref) per workspace — enables incremental re-indexing via mtime
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
);

CREATE INDEX IF NOT EXISTS idx_cg_tags_workspace ON code_graph_tags(workspace_id);
CREATE INDEX IF NOT EXISTS idx_cg_tags_file ON code_graph_tags(workspace_id, rel_fname);
CREATE INDEX IF NOT EXISTS idx_cg_tags_name ON code_graph_tags(workspace_id, name);
CREATE INDEX IF NOT EXISTS idx_cg_tags_kind ON code_graph_tags(workspace_id, kind);

-- Per-file PageRank scores — pre-computed during indexing for instant lookups
CREATE TABLE IF NOT EXISTS code_graph_ranks (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rel_fname TEXT NOT NULL,
  page_rank REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, rel_fname)
);

CREATE INDEX IF NOT EXISTS idx_cg_ranks_workspace ON code_graph_ranks(workspace_id);

-- Indexing state for code graph (separate from semantic search indexing_state)
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
);

-- Persistent indexing progress per workspace (resume-after-crash)
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
);

-- ── Inter-Agent Communication ──────────────────────────────────────────────

-- Persistent inter-agent message log for crash recovery and audit
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
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_conversation ON agent_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_agent_messages_run ON agent_messages(run_id);
CREATE INDEX IF NOT EXISTS idx_agent_messages_task ON agent_messages(task_id);
CREATE INDEX IF NOT EXISTS idx_agent_messages_from ON agent_messages(from_agent);

-- ── Per-Turn Token Usage ──────────────────────────────────────────────────

-- Fine-grained token usage per turn for cost debugging and cache rate trends
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
);
CREATE INDEX IF NOT EXISTS idx_turn_usage_session ON turn_usage(session_id);
CREATE INDEX IF NOT EXISTS idx_turn_usage_conversation ON turn_usage(conversation_id);

-- Agent context: per-conversation persistent memory for long-running agent context (Anthropic pattern)
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
