# Project State

> Auto-maintained by Agent Studio. Last updated: 2026-03-22T19:00:00.000Z

## Current Phase

Core Application — Feature Complete (MVP+)

## Completed Items

- Initial Electron + React + TypeScript scaffold (electron-vite, Tailwind CSS 4)
- SQLite database with better-sqlite3 (8 tables: workspaces, conversations, messages, specialists, skills, specialist_skills, conversation_file_changes, agent_worktrees, agent_sessions, ideas)
- 14 agent YAML definitions in .claude/agents/ (generalist + orchestrator + 12 specialists)
- 7 skills deployed in .claude/skills/ (electron-pro, dotnet-architect, claude-cli, sqlite-patterns, tailwind-ux, git-workflow, ipc-patterns)
- Generalist-first architecture: User <-> Generalist (always) -> Orchestrator (on-demand) -> Specialists
- Streaming chat with NDJSON Claude CLI integration (--input-format stream-json, --output-format stream-json)
- Plan/Build mode toggle with permission-mode switching and --resume session support
- Handoff protocol: generalist detects implementation work -> structured handoff block -> orchestrator spawns specialists
- Grill Mode: interview-driven requirements refinement with grill-summary blocks
- Task decomposition + parallel/sequential specialist execution via SpecialistPoolService
- Git worktree isolation per specialist agent (create, merge, mergeAll, abandon, prune)
- /complete command: branch creation, commit, push, PR URL return, cleanup
- /close command: conversation summary to brain, worktree pruning, data deletion
- File change tracking per conversation (conversation_file_changes table)
- Agent Sync: YAML <-> DB bidirectional sync with diff review UI
- Workspace activation: deploy agents/skills to target workspace with CLAUDE.md generation
- Pixel Office: isometric pixel art visualization of agent activity with canvas rendering
- Settings pages: Agents list, Skills list, Agent detail/YAML editor, Skill detail, Sync review modal
- Token usage tracking with agent_sessions table and TokenUsagePage
- Ideas system: capture, grill, convert to conversations
- Project Brain: persistent .brain/ directory with changelog, decisions, errors, project state
- Brain context injection into generalist system prompt for cross-session memory
- Context compaction: auto-compact brain files at 500 lines, keep most recent 300
- Brain Settings page: management UI for .brain/ files with file cards, progress bars, compact, toggle

## Pending Items

- Jest test setup and initial test coverage
- CI/CD pipeline configuration
- Auto-update (electron-updater) integration
- Code signing and notarization for macOS distribution
- **Long-term memory via local vector search (Tier 2 brain enhancement)**
  - Local embedding model (all-MiniLM-L6-v2 via ONNX Runtime, ~90MB, CPU-only)
  - Local file-based vector DB (vectra by Microsoft — TypeScript, no server)
  - Store: chunked conversation history, architecture decisions, error resolutions, code references
  - Query: embed user message locally (~5ms) → search top-5 relevant chunks → inject into prompt
  - Settings toggle: enable/disable semantic search per workspace
  - Auto-index on /complete, /close, brain feed ingest
  - Storage: `.brain/vectors/` directory (git-ignorable)
  - Zero API keys, fully offline — aligns with Agent Studio philosophy
- Comprehensive code audit fixes (E3/E4 CSP improvements, R4/R5/R6 component decomposition, A5 build-mode permission scoping, A6 handoff regex robustness)
