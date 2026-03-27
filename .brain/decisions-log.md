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

### [DECISION] Hybrid Brain: Flat Files + Local Vector Search (Future)

> 2026-03-23

Evaluated three tiers of knowledge persistence:

- **Tier 1 (.brain/ markdown):** Compact curated working memory — always injected into system prompt. Already implemented.
- **Tier 2 (local vectors):** Long-term searchable memory using local embedding model (all-MiniLM-L6-v2 via ONNX) + local file-based vector DB (vectra). Selective retrieval — only top-K relevant chunks per query. **Chosen for next phase.**
- **Tier 3 (cloud vectors — Pinecone/Weaviate):** Rejected for now — requires API keys and network, contradicts Agent Studio's local-first, no-API-key philosophy.

**Key insight:** `.brain/` = "what matters now" (working memory). Vectors = "what did we decide 3 weeks ago about X" (long-term memory). They complement each other.

**Cost analysis:** Local embedding ~5ms/query, vector search ~2ms/query. Zero API cost. ~90MB model bundled with app. No network calls.

**Rationale:** Keeps Agent Studio fully offline and API-key-free while enabling semantic search across all past conversations, decisions, and code architecture. Toggle in settings allows users to opt in/out per workspace.

---

### [DECISION] Code Audit — Security & Performance Fixes Applied

> 2026-03-23

Applied comprehensive 3-specialist code audit (Electron, React, Agentic):

- **Security (Critical):** Added `validateSender()` to 37 unprotected IPC handlers across 4 modules. Added path validation for `WORKSPACE_READ_FILE`/`WORKSPACE_WRITE_FILE` (allowlist: `.claude/`, `skills/`, `CLAUDE.md`).
- **Reliability:** Fixed async `before-quit` handler (Electron doesn't await async — now uses `event.preventDefault()` + guard). Added 10-min timeout to specialist processes (SIGTERM → SIGKILL escalation).
- **Performance:** Zustand individual selectors in MessageList, React.memo on MessageBubble, extracted OrchestratorDot component.
- **Observability:** Generalist restart now notifies UI, skill truncation logged, orchestrator session map bounded (100 max with LRU eviction).
- **Cleanup:** Removed dead `waitForReady()`, added ErrorBoundary per feature panel, minimal production menu (preserves Cmd+C/V/X/Z).

**Rationale:** Security hardening was critical — `workspace-deploy.ipc.ts` had 18 handlers with zero sender validation, including arbitrary file read/write. React perf fixes reduce unnecessary re-renders during streaming.

---
