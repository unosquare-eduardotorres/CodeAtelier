# Changelog

> Auto-maintained by Agent Studio. Newest entries first.

---

### [COMPLETION] Deep Performance Audit — Wave 4 Token & Latency Optimization

> 2026-03-30

Applied 6 strategies from the post-optimization deep audit (S1-S6 of Wave 4).

**Details:**

- S1: Lowered specialist plan limits — MAX_SPECIALIST_PLAN_TURNS 15→8, MAX_SPECIALIST_PLAN_TOOL_CALLS 25→12 (50-60% latency reduction)
- S2: Compressed GENERALIST_BASE_PROMPT — removed redundant CRITICAL RULE section, Good/Bad table, compressed Conversation style + Large Plan Protocol (4,676→1,990 chars)
- S3: Gated YAML body to build-only — plan-mode specialists get 1-line identity instead of full YAML prompt (-222 tok/plan specialist)
- S4: Compressed SPECIALIST_TASK_SYSTEM_PROMPT — 30 lines to 7 lines (1,289→629 chars, -188 tok/specialist)
- S5: Reordered "When to Answer Directly" BEFORE "When to ALWAYS Hand Off" — attention bias fix so model checks direct-answer path first
- S6: Added extractPlanSpecialistClaudeMdSections() — plan-mode specialists get tech stack only (397 chars vs 4,463 for build)
- Files modified: specialist-pool.service.ts, default-prompts.ts, prompt-builder.ts
- Typecheck: 0 new errors introduced

**Performance impact:**

- Investigation latency: 30-100s → 12-25s estimated
- Investigation tokens: ~3,815 → ~2,685 (-30%)
- Simple Q&A tokens: ~3,815 → ~2,510 (-34%)

---

### [COMPLETION] Performance Optimization — Waves 1-3 (S1-S19 + P4/P6/P7/P8)

> 2026-03-28 to 2026-03-29

Comprehensive prompt optimization across 3 waves targeting token reduction and latency.

**Details:**

- Wave 1 (Quick Wins): Trimmed YAML bodies, compressed generalist prompts, killed rules reminder
- Wave 2 (Prompt Builder): Tighter skill budgets, slim CLAUDE.md extraction, compressed decomposition prompt, plan-mode turn limits
- Wave 3 (Architecture): Single-specialist direct dispatch, no skills in plan mode, generalist direct plan generation
- Smart Prompting: Conditional section injection (S12), answer-directly gate (S14), adaptive per-turn prompt (S17)
- Specialist Speed: Early-exit on investigation report (P8), relevance-filtered memory (P6)
- 22 strategies implemented total
- Files modified: prompt-builder.ts, default-prompts.ts, specialist-pool.service.ts, generalist.service.ts, memory.service.ts

---

### [COMPLETION] SDK Migration & Orchestrator Removal

> 2026-03-24 to 2026-03-28

Migrated from Claude CLI spawn to Claude Agent SDK. Removed OrchestratorService entirely — generalist now directly handles task decomposition and specialist coordination.

**Details:**

- SDKExecutor wraps Claude Agent SDK query() async generator
- sdk-hooks.ts implements per-tool-use approval via ToolApprovalService
- orchestrator.service.ts deleted, orchestrator.ipc.ts renamed to agent-lifecycle.ipc.ts
- All IPC channels migrated from orchestrator naming to agent naming
- Shared types, preload bridge, and renderer updated for new naming
- GeneralistService refactored: extracted pure functions into generalist-utils.ts
- SubAgent spawning via SDK agents parameter in executeWithSubAgents()
- 10 agent YAMLs remain (generalist removed as agent — it's the main process now)

---

### [COMPLETION] Intelligence Layer Upgrade — Sprints 0-3

> 2026-03-24 to 2026-03-28

Implemented the core intelligence layer features from the 10-phase PRD.

**Details:**

- Sprint 0: Database migration system (36 migrations via PRAGMA user_version)
- Sprint 1: Complexity scoring (0-14 scale, haiku/sonnet/opus routing) + cost tracking dashboard
- Sprint 2: Task loop with quality gates (tsc, eslint, test) + anti-abandonment detection with re-engagement
- Sprint 3: File-based artifact chain (.agentstudio/ directories) + human checkpoint UI
- Sprint 4 partial: Progressive skill loading (3 tiers, relevance scoring, 8K hard cap)
- New services: complexity-scorer, task-loop, quality-gate-runner, abandonment-detector, task-artifact, checkpoint
- New IPC: checkpoint.ipc.ts, tool-approval.ipc.ts
- New DB: checkpoint.repository.ts, event.repository.ts

---

### [COMPLETION] Code Atelier Brand Migration

> 2026-03-26

Renaissance theme applied across entire renderer — darker surfaces, bigger fonts, refined typography.

---

### [COMPLETION] Comprehensive Code Audit — Security, Performance & Reliability

> 2026-03-23

Applied 14 fixes from 3-specialist audit (Electron, React, Agentic).

**Details:**

- Critical: validateSender() added to 37 IPC handlers. Path validation on WORKSPACE_READ_FILE/WORKSPACE_WRITE_FILE.
- Medium: Fixed async before-quit, specialist 10min timeout, generalist restart UI notification, Zustand selectors, React.memo on MessageBubble.
- Minor: Component extraction, dead code removal, ErrorBoundary per panel, session map LRU, cross-platform path fix.

---

### [COMPLETION] Brain System & Agent Creation

> 2026-03-22T13:56:37-06:00

Implemented Project Brain persistent memory system and UI polish.

**Details:**

- brain.service.ts: initialize, logCompletion, logDecision, logError, getContext, summarizeConversation, compactIfNeeded
- brain.ipc.ts: 3 IPC handlers (getContext, getState, logDecision)
- Auto-initialize .brain/ on workspace open
- Brain context injected into generalist system prompt after CLAUDE.md

---

### [COMPLETION] New Commands & Chat Enhancements

> 2026-03-22T13:20:29-06:00

Implemented /complete and /close commands, grill session UI, build mode, and specialist pool execution.

---

### [COMPLETION] Questions & Context Persistency

> 2026-03-22T10:47:44-06:00

Added grill mode, context persistence via CLAUDE.md injection, and agent/skill deployment system.

---

### [COMPLETION] Initial commit

> 2026-03-21T20:35:23-06:00

Full Electron + React + TypeScript application scaffold. 80+ source files, 8 database tables, 10 IPC domain modules.

---
