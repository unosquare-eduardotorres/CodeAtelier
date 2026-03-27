# Changelog

> Auto-maintained by Agent Studio. Newest entries first.

---

### [COMPLETION] Comprehensive Code Audit — Security, Performance & Reliability

> 2026-03-23

Applied 14 fixes from 3-specialist audit (Electron, React, Agentic).

**Details:**

- 🔴 Critical: validateSender() added to 37 IPC handlers (workspace-deploy, sync, token, update). Path validation on WORKSPACE_READ_FILE/WORKSPACE_WRITE_FILE.
- 🟡 Medium: Fixed async before-quit, specialist 10min timeout, generalist restart UI notification, Zustand selectors, React.memo on MessageBubble, minimal production menu.
- 🟢 Minor: OrchestratorDot extraction, skill truncation logging, dead code removal, ErrorBoundary per panel, orchestrator session map LRU, cross-platform path fix.
- Files modified: 10 files across main process, renderer, and services.

---

### [COMPLETION] Initial commit

> 2026-03-21T20:35:23-06:00

Full Electron + React + TypeScript application scaffold with electron-vite, Tailwind CSS 4, Zustand state management, better-sqlite3 database, and core IPC architecture.

**Details:**

- Commit: c21d9e3
- 80+ source files across main, preload, renderer, shared layers
- Complete database schema with 8 tables
- 10 IPC domain modules (workspace, chat, agent, orchestrator, specialist, skill, workspace-deploy, sync, worktree, pixel-office)
- React UI: ChatPanel, MessageBubble, MessageInput, MessageList, ChatSidebar, AgentMonitor, PixelOffice

---

### [COMPLETION] Questions & Context Persistency

> 2026-03-22T10:47:44-06:00

Added grill mode for requirements refinement, context persistence via CLAUDE.md injection, and agent/skill deployment system.

**Details:**

- Commits: 5c9ee32, ca8df5c
- 14 agent YAML definitions deployed to .claude/agents/
- 7 skill files with SKILL.md references
- IPC patterns skill (304 lines) for cross-process communication guidance
- Workspace activation: auto-generate CLAUDE.md from agent/skill analysis
- Agent sync service: detect YAML <-> DB drift

---

### [COMPLETION] New Commands & Chat Enhancements

> 2026-03-22T13:20:29-06:00

Implemented /complete and /close commands, grill session UI, build mode with dangerously-skip-permissions, and specialist pool execution.

**Details:**

- Commit: 1c45c9e
- /complete: branch creation, git add/commit/push, PR URL, conversation cleanup
- /close: stop agents, prune worktrees, delete conversation data
- Grill result card UI component (GrillResultCard.tsx)
- Build mode: --dangerously-skip-permissions flag for full CLI access
- SpecialistPoolService: parallel and sequential task execution
- Compaction suggestion UI (token threshold detection)

---

### [COMPLETION] Chat Sidebar & Layout Polish

> 2026-03-22T13:34:04-06:00

Improved chat sidebar, pixel office layout generation, and conversation list UX.

**Details:**

- Commit: bcf4b25
- ChatSidebar conversation list improvements
- Pixel office layout generator script refactored

---

### [COMPLETION] Brain System & Agent Creation

> 2026-03-22T13:56:37-06:00

Implemented Project Brain persistent memory system and UI polish.

**Details:**

- Commit: f2696cb
- brain.service.ts: initialize, logCompletion, logDecision, logError, getContext, summarizeConversation, compactIfNeeded
- brain.ipc.ts: 3 IPC handlers (getContext, getState, logDecision)
- Auto-initialize .brain/ on workspace open
- Auto-log to brain on /complete, /close, task execution finish
- Brain context injected into generalist system prompt after CLAUDE.md
- BrainEntry type in shared/types.ts

---

### [COMPLETION] Workspace Brain Init Hook

> 2026-03-22T13:56:53-06:00

Connected brain initialization to workspace open lifecycle.

**Details:**

- Commit: 5e95134
- workspace.ipc.ts: brainService.initialize(workspace.repoPath) after auto-sync

---
