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
  mode TEXT NOT NULL DEFAULT 'plan' CHECK (mode IN ('plan', 'build', 'danger')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  summary TEXT,
  claude_session_id TEXT,
  persona_specialist_id TEXT DEFAULT NULL REFERENCES specialists(id) ON DELETE SET NULL,
  llm_provider TEXT NOT NULL DEFAULT 'claude' CHECK (llm_provider IN ('claude', 'local-llm')),
  effort TEXT NOT NULL DEFAULT 'high' CHECK (effort IN ('low', 'medium', 'high')),
  source_audit_run_id TEXT DEFAULT NULL
);

-- Messages: individual chat messages
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  -- Layer 2 (migration 69): new canonical value is 'da-vinci'. Legacy
  -- 'generalist' accepted so historical migrations (2, 31, …) replay cleanly
  -- on fresh installs; migration 69 rewrites any surviving 'generalist' rows.
  role TEXT NOT NULL CHECK (role IN ('user', 'specialist', 'da-vinci', 'generalist')),
  agent_id TEXT,
  content_md TEXT NOT NULL,
  attachments_json TEXT DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  parent_message_id TEXT REFERENCES messages(id),
  tool_activities_json TEXT DEFAULT NULL
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
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_creation_tokens INTEGER DEFAULT 0,
  stdout_log_path TEXT,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  complexity_score INTEGER,
  model_used TEXT,
  complexity_tier TEXT
);

-- Specialists: per-workspace Project Specialists + the app-global Generalist row.
-- After migration 66: workspace_id is nullable (only the Generalist row leaves it NULL).
-- Every other specialist is bound to exactly one workspace via the unique index below.
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
  is_core INTEGER NOT NULL DEFAULT 0,
  -- Project Specialist columns (nullable on the Generalist row)
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  build_status TEXT NOT NULL DEFAULT 'ready' CHECK (build_status IN ('pending', 'building', 'ready', 'failed')),
  stack_fingerprint TEXT,
  detected_techs TEXT DEFAULT '[]' CHECK (json_valid(detected_techs)),
  last_built_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A workspace has at most one Project Specialist. The Generalist row has workspace_id=NULL
-- and is excluded from this constraint by the partial index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_specialists_workspace_unique
  ON specialists(workspace_id) WHERE workspace_id IS NOT NULL;

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

-- Junction: many-to-many specialists <-> skills.
-- is_enabled controls whether a skill is currently contributing to the specialist's
-- prompt/MCP. After migration 66 every attached skill starts disabled (is_enabled=0).
CREATE TABLE IF NOT EXISTS specialist_skills (
  specialist_id TEXT NOT NULL REFERENCES specialists(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  is_enabled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (specialist_id, skill_id)
);

-- Conversation specialist activation: one row per conversation pointing to
-- the workspace's Project Specialist. Nearly vestigial today (single row per
-- conv); kept for UI history + skill-enablement semantics.
CREATE TABLE IF NOT EXISTS conversation_specialists (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  specialist_id TEXT NOT NULL REFERENCES specialists(id) ON DELETE CASCADE,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(conversation_id, specialist_id)
);

CREATE INDEX IF NOT EXISTS idx_conversations_workspace ON conversations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_conversation ON attachments(conversation_id);
CREATE INDEX IF NOT EXISTS idx_specialists_priority ON specialists(priority);
CREATE INDEX IF NOT EXISTS idx_skills_active ON skills(is_active);
CREATE INDEX IF NOT EXISTS idx_conversation_specialists_conversation ON conversation_specialists(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversation_specialists_specialist ON conversation_specialists(specialist_id);
-- specialist_conversation_history indexes removed: table was dropped in migration v89
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
  -- Both values accepted — see note on messages.role above.
  agent_role TEXT PRIMARY KEY CHECK (agent_role IN ('specialist', 'da-vinci', 'generalist')),
  alias TEXT DEFAULT NULL,
  avatar_key TEXT DEFAULT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Core agent prompts: editable system prompts for generalist
CREATE TABLE IF NOT EXISTS core_agent_prompts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  agent_role TEXT NOT NULL CHECK (agent_role IN ('specialist', 'da-vinci', 'generalist')),
  mode TEXT NOT NULL CHECK (mode IN ('plan', 'build', 'danger')),
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
  source TEXT NOT NULL DEFAULT 'ai',
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
  checkpoint_offset INTEGER NOT NULL DEFAULT 0,
  description_source TEXT NOT NULL DEFAULT 'none',
  last_completed_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Inter-Agent Communication ──────────────────────────────────────────────

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
  context_tokens INTEGER DEFAULT 0,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_turn_usage_session ON turn_usage(session_id);
CREATE INDEX IF NOT EXISTS idx_turn_usage_conversation ON turn_usage(conversation_id);

-- ── Unified Token Usage Log ────────────────────────────────────────────────

-- Single sink for ALL LLM token consumption (chat, grill, council, mpa, audit,
-- and background one-shot claude calls) — powers the by-feature usage breakdown.
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

-- ── Workspace Health: Audit Runs & Results ────────────────────────────────────

-- Audit runs (multiple per workspace — history of up to 10 kept by repository)
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

CREATE INDEX IF NOT EXISTS idx_audit_runs_workspace
  ON audit_runs(workspace_id);

-- Individual auditor results within a run
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

-- Grill sessions: persistent grill evaluation state
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
  plan_json TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_grill_sessions_idea ON grill_sessions(idea_id);
CREATE INDEX IF NOT EXISTS idx_grill_sessions_workspace ON grill_sessions(workspace_id);

-- ── Blueprints: Structured Specification Pipeline ─────────────────────────────

-- Blueprints: top-level entity for the 7-phase spec pipeline
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
    CHECK (status IN ('pending','running','complete','failed')),
  executor_run_id TEXT REFERENCES mpa_runs(id) ON DELETE SET NULL,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bp_tasks_blueprint ON blueprint_tasks(blueprint_id);
CREATE INDEX IF NOT EXISTS idx_bp_tasks_wave ON blueprint_tasks(wave);

-- E2E test runs: track each test execution batch
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
);
CREATE INDEX IF NOT EXISTS idx_e2e_test_runs_workspace ON e2e_test_runs(workspace_id);
CREATE INDEX IF NOT EXISTS idx_e2e_test_runs_status ON e2e_test_runs(status);

-- E2E test results: individual scenario outcomes within a run
CREATE TABLE IF NOT EXISTS e2e_test_results (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  run_id TEXT NOT NULL REFERENCES e2e_test_runs(id) ON DELETE CASCADE,
  scenario_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'passed', 'failed', 'skipped', 'error')),
  duration_ms INTEGER,
  failure_reason TEXT,
  assertion_results TEXT,
  transcript_json TEXT,
  conversation_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_e2e_test_results_run ON e2e_test_results(run_id);
CREATE INDEX IF NOT EXISTS idx_e2e_test_results_scenario ON e2e_test_results(scenario_id);
CREATE INDEX IF NOT EXISTS idx_e2e_test_results_status ON e2e_test_results(status);


