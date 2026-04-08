# Project State

> Auto-maintained by Agent Studio. Last updated: 2026-03-30T22:00:00.000Z

## Current Phase

Post-MVP Re-Architecture — Performance Optimization & Intelligence Layer Upgrade

## Architecture (Current)

- **Two-layer model:** User ↔ Generalist → Specialists (SDK SubAgents)
- **No Orchestrator** — removed March 28. Generalist directly decomposes tasks and spawns specialists.
- **Claude Agent SDK** — replaced CLI spawn with SDK `query()` async generator + SubAgent spawning via `agents` parameter.
- **10 specialist agents** in .claude/agents/ (generalist-developer, platform-architect, platform-engineer, frontend-architect, data-architect, dotnet-architect, design-specialist, dx-specialist, testing-specialist, planner)
- **22 skills** deployed in .claude/skills/
- **36 database migrations** via PRAGMA user_version tracking

## Completed Items

### Foundation (March 21-22)

- Electron 40 + React 19 + TypeScript 5.9 scaffold (electron-vite 5, Tailwind CSS 4)
- SQLite database with better-sqlite3 (repository pattern, 36 migrations)
- Streaming chat via Claude Agent SDK
- Plan/Build mode toggle with permission-mode switching
- Grill Mode: interview-driven requirements refinement
- Task decomposition + parallel/sequential specialist execution via SpecialistPoolService
- Git worktree isolation per specialist agent
- /complete command: branch creation, commit, push, PR URL return, cleanup
- /close command: conversation summary to brain, worktree pruning, data deletion
- Agent Sync: YAML ↔ DB bidirectional sync with diff review UI
- Workspace activation: deploy agents/skills to target workspace with CLAUDE.md generation
- Pixel Office: isometric pixel art visualization of agent activity
- Settings pages: Agents, Skills, Agent detail/YAML editor, Skill detail, Sync review modal
- Token usage tracking with agent_sessions table and TokenUsagePage
- Ideas system: capture, grill, convert to conversations
- Project Brain: persistent .brain/ directory with changelog, decisions, errors, project state
- Brain context injection into generalist system prompt for cross-session memory
- Context compaction: auto-compact brain files at 500 lines

### SDK Migration & Orchestrator Removal (March 24-28)

- Claude Agent SDK integration replacing CLI spawn (SDKExecutor, sdk-hooks)
- OrchestratorService fully removed — generalist absorbs orchestration
- orchestrator.ipc.ts renamed to agent-lifecycle.ipc.ts
- IPC channels migrated from orchestrator naming to agent naming
- Shared types updated (IPC channel map, TaskPlan JSDoc)
- Preload bridge methods renamed to agent API
- Renderer components updated: status references, settings, identity/icons
- GeneralistService refactored: extracted pure functions into generalist-utils.ts
- SubAgent spawning via SDK `agents` parameter in executeWithSubAgents()
- Tool approval system (tool-approval.service.ts, tool-approval.ipc.ts, sdk-hooks.ts)

### Intelligence Layer (Sprint 0-4 — March 24-28)

- F000: Database migration system (36 migrations, PRAGMA user_version)
- F001: Complexity scoring & model routing (complexity-scorer.service.ts, tiers haiku/sonnet/opus)
- F002: Task loop with quality gates (task-loop.service.ts, quality-gate-runner.service.ts)
- F003: Anti-abandonment detection (abandonment-detector.service.ts, re-engagement prompts)
- F004: File-based agent communication chain (task-artifact.service.ts, .agentstudio/ directories)
- F005: Cost tracking dashboard (TokenUsagePage.tsx, BudgetWarningBanner.tsx)
- F006: Human checkpoint UI (checkpoint.service.ts, checkpoint.ipc.ts, checkpoint.repository.ts)
- F007: Progressive skill loading (3 tiers, relevance scoring, 8K hard cap)

### Performance Optimization (Waves 1-3 — March 28-30)

- S1: Trimmed all 10 agent YAML bodies to 2-4 lines
- S2: Compressed generalist prompts (GENERALIST_BASE_PROMPT: 4,676→1,990 chars)
- S3: Tighter skill budgets + 8K hard cap in buildSkillContent
- S4: Slim CLAUDE.md extraction for specialists (plan: 397 chars, build: 4,463 chars)
- S5: Compressed DECOMPOSITION_SYSTEM_PROMPT
- S6: Replaced resumed-session RULES_REMINDER with 1-line mode indicator
- S7: Single-specialist direct dispatch (skip decomposition for 1-specialist handoffs)
- S8: Stricter plan-mode limits (MAX_SPECIALIST_PLAN_TURNS: 15→8, MAX_SPECIALIST_PLAN_TOOL_CALLS: 25→12)
- S9: No skills injected in plan mode — specialists don't need implementation guides for read-only analysis
- S10: Generalist generates plans directly (no handoff for plan generation)
- S11: Slim CLAUDE.md for generalist (progressive injection by mode)
- S12: Conditional section injection (ask-question, memory, image — keyword-triggered)
- S13: Compressed build-mode verbosity
- S14: "When to Answer Directly" complexity gate (≤3 tool calls → answer, else handoff)
- S15: Ultra-light investigation mode
- S16: Eliminated orchestration double-prompt
- S17: Adaptive system prompt (per-turn budget tiers: full→standard→minimal)
- S19: Streaming short-circuit on handoff detection
- P4: Rewritten handoff rules with ≤3 tool-call complexity gate
- P6: Relevance-filtered memory injection (keyword scoring)
- P7/P8: Early-exit on investigation report detection in specialist stream
- SPECIALIST_TASK_SYSTEM_PROMPT compressed from 1,289→629 chars
- YAML body gated to build-only (plan mode gets 1-line specialist identity)
- Plan-mode specialist CLAUDE.md reduced to tech stack only (397 chars)

### UI & Design (March 26-30)

- Code Atelier brand migration — Renaissance theme, darker surfaces, bigger fonts
- TaskPlanCard UX label split for plan vs build modes
- Role-aware streaming pipeline — thinking indicator shows correct agent identity

## Pending Items

### Tier 1: Performance — Immediate (2h)

- **NEW-S1**: Full single-specialist direct dispatch (skip decomposition for ALL 1-specialist handoffs, not just gated)
- **NEW-S2**: Slash specialist BUILD CLAUDE.md (4,463→~800 chars) — specialists don't need full conventions for focused tasks
- **NEW-S3**: Skills opt-in with complexity gate — only load skills when task complexity ≥5
- **NEW-S5**: Memory budget scaled by turn count (turn 1: 5000, turn 3+: 2000, turn 6+: 0)

### Tier 2: Architecture — Near-Term (8-12h)

- **Phase 1**: RepoMapper MCP integration — ranked file lists for specialist context (blocks Phase 4)
- **F008**: Scope Enforcement Layer — post-execution validation of file changes against task scope
- **NEW-S7**: Ask user before specialist — opt-in specialist spawning to eliminate unnecessary spawns
- **NEW-S8**: Collapse orchestration hop — single-task plans go directly to SpecialistPoolService
- **NEW-S6**: Merge redundant PLAN_MODE/BUILD_MODE sections in default-prompts.ts

### Tier 3: Future Features (20-30h)

- **Phase 4**: Validated file-ranked context (blocked by Phase 1 / RepoMapper MCP)
- **F009**: Declarative Hooks System — user-defined automation hooks in .agentstudio/hooks.yaml
- **F010**: Deep Agent Personas & Bug Council — 5 diagnostic agents for persistent failures
- **Tier 2 Brain**: Long-term memory via local vector search (all-MiniLM-L6-v2 + vectra)
- **NEW-S9**: Prompt caching via SDK cache_control (50-80% savings on repeat turns)
- CI/CD pipeline configuration
- Auto-update (electron-updater) integration
- Code signing and notarization for macOS distribution
