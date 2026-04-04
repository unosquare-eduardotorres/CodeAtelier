# Decisions Log

> Auto-maintained by Agent Studio. Key decisions and rationale.

---

### [DECISION] Two-Layer Architecture — Orchestrator Removed

> 2026-03-28

Collapsed the three-layer model (Generalist → Orchestrator → Specialists) into a two-layer model (Generalist → Specialists). The Generalist now directly handles task decomposition via `decompose()` and specialist coordination via `executeWithSubAgents()` with SDK SubAgent spawning.

**Rationale:** The Orchestrator was a dedicated intermediary that added an unnecessary LLM hop per request — burning tokens on routing that the Generalist could handle directly. Removing it saves ~1,100 tokens and 3s per handoff. The SubAgent orchestration prompt is now 5 lines (312 chars) instead of a full Orchestrator service.

**Supersedes:** "Generalist-First Architecture" decision from 2026-03-21 (which described the Orchestrator as part of the flow).

---

### [DECISION] Claude Agent SDK Replaces CLI Spawn

> 2026-03-25

Migrated from `child_process.spawn` with NDJSON streaming to the Claude Agent SDK `query()` async generator. SDK provides: native SubAgent spawning via `agents` parameter, per-tool-use approval hooks, session management, and structured streaming.

**Rationale:** SDK eliminates the fragile NDJSON parsing layer, provides first-class SubAgent support (no manual process management), and enables tool approval hooks for user control. CLI spawn required custom buffer flushing, exit code handling, and process lifecycle management.

**Supersedes:** "Claude CLI via spawn (not API)" decision from 2026-03-21.

---

### [DECISION] Adaptive Prompt Budgeting by Turn Count

> 2026-03-29

System prompt shrinks as conversation progresses. Turn 1 gets full context (CLAUDE.md + memory + all sections). Turn 2-4 gets standard context. Turn 5+ gets minimal context (no CLAUDE.md — model already has it in conversation history).

**Rationale:** After turn 1, the LLM has already seen the project context. Re-injecting 1,990 chars of CLAUDE.md on every subsequent turn is pure waste. Adaptive budgeting saves ~569 tokens per turn from turn 5 onward.

---

### [DECISION] Specialist Skills Restricted to Build Mode Only

> 2026-03-29

Plan-mode specialists (investigations, analysis) no longer receive skill content. Skills are implementation guides — not needed for read-only analysis.

**Rationale:** Skills like electron-pro (21K chars) and dotnet-architect (19K chars) were being truncated and injected into investigation specialists that only read files. Restricting to build mode saves 571-2,000 tokens per plan-mode specialist.

---

### [DECISION] Performance Target — 30% Token Reduction Verified

> 2026-03-30

Deep audit verified current token usage across all LLM call paths. After Wave 4 optimizations:
- Investigation total: ~3,815 → ~2,685 tokens (-30%)
- Simple Q&A: ~3,815 → ~2,510 tokens (-34%)
- Investigation latency: 30-100s → 12-25s (-66%)
- Specialist BUILD prompt: ~2,398 → ~1,720 tokens (-28%)

**Next target:** Wave 5 strategies (NEW-S1 through NEW-S10) project further reductions to B+ grade. Key remaining bottlenecks: specialist BUILD CLAUDE.md (4,463 chars), skills auto-loading for simple tasks, and unnecessary decomposition LLM calls.

---

### [DECISION] Generalist-First Architecture

> 2026-03-21

User always talks to the Generalist agent. The Generalist handles 80% of interactions directly (Q&A, review, brainstorming). For specialist work, it emits a handoff block and delegates via SDK SubAgents.

**Rationale:** Users expect one chat partner, not a committee.

---

### [DECISION] SQLite via better-sqlite3 (no ORM)

> 2026-03-21

Raw SQL with repository pattern. Each domain entity gets its own repository class with a singleton export.

**Rationale:** Synchronous API, zero setup, single-file database, fast for local-first desktop app.

---

### [DECISION] Git Worktree Isolation for Parallel Agents

> 2026-03-22

Each specialist agent works in its own git worktree branch during parallel execution.

**Rationale:** Prevents file conflicts when multiple specialists edit code simultaneously.

---

### [DECISION] Plan/Build Mode with Session Resume

> 2026-03-22

Plan mode uses `--permission-mode plan` (read-only). Build mode uses full permissions. Mode switch preserves conversation history via session resume.

**Rationale:** Security boundary between read-only analysis and code modification.

---

### [DECISION] Brain as Flat Markdown Files (not DB)

> 2026-03-22

Project brain stored as `.brain/*.md` files in the workspace repo. Append-friendly markdown with periodic compaction.

**Rationale:** Git-trackable, human-readable, portable — brain travels with the repo.

---

### [DECISION] Hybrid Brain: Flat Files + Local Vector Search (Future)

> 2026-03-23

- Tier 1 (.brain/ markdown): Working memory — always injected. Implemented.
- Tier 2 (local vectors): Long-term memory via all-MiniLM-L6-v2 + vectra. Chosen for future phase.
- Tier 3 (cloud vectors): Rejected — contradicts local-first philosophy.

**Rationale:** `.brain/` = "what matters now". Vectors = "what did we decide 3 weeks ago". Zero API cost, fully offline.

---

### [DECISION] Code Audit — Security & Performance Fixes

> 2026-03-23

Applied 14 fixes from 3-specialist audit. Critical: validateSender() added to 37 IPC handlers. Path validation on file read/write. React perf fixes for streaming.

---
