# Decisions Log
> Auto-maintained by Agent Studio. Key decisions and rationale.

---

### [DECISION] Generalist-First Architecture
> 2026-03-21

User always talks to the Generalist agent (long-lived Claude CLI session). The Generalist detects inflection points and hands off to the Orchestrator, which spawns specialists. This avoids multi-agent confusion and keeps a single conversational thread.

**Rationale:** Users expect one chat partner, not a committee. The generalist handles 80% of interactions (Q&A, review, brainstorming) without spawning any processes.

---

### [DECISION] Claude CLI via spawn (not API)
> 2026-03-21

Use Claude CLI (`claude`) via `child_process.spawn` with `--input-format stream-json` and `--output-format stream-json` for NDJSON streaming. No API keys needed — leverages Claude Max subscription.

**Rationale:** Zero configuration for users. No proxy servers. No API key management. Claude CLI handles auth via `claude login`.

---

### [DECISION] SQLite via better-sqlite3 (no ORM)
> 2026-03-21

Raw SQL with repository pattern instead of an ORM like Prisma or TypeORM. Each domain entity gets its own repository class with a singleton export.

**Rationale:** Synchronous API (better-sqlite3 is sync), zero setup, single-file database, fast for local-first desktop app. ORM adds complexity without benefit for 8 tables.

---

### [DECISION] Git Worktree Isolation for Parallel Agents
> 2026-03-22

Each specialist agent works in its own git worktree branch during parallel execution. Worktrees are merged back to the main branch after completion.

**Rationale:** Prevents file conflicts when multiple specialists edit code simultaneously. Git worktrees are lightweight and share the same .git directory.

---

### [DECISION] Plan/Build Mode with CLI Session Resume
> 2026-03-22

Plan mode uses `--permission-mode plan` (read-only). Build mode uses `--dangerously-skip-permissions` (full access). Mode switch kills and re-spawns the CLI process with `--resume sessionId` to preserve conversation history.

**Rationale:** Security boundary between read-only analysis and code modification. Session resume avoids losing context on mode switch.

---

### [DECISION] Brain as Flat Markdown Files (not DB)
> 2026-03-22

Project brain stored as `.brain/*.md` files in the workspace repo, not in SQLite. Files are append-friendly markdown with periodic compaction.

**Rationale:** 1) Git-trackable — team members benefit from shared context. 2) Human-readable — developers can read/edit brain files directly. 3) Simple — no schema migrations needed. 4) Portable — brain travels with the repo.

---
