---
name: claude-architect
description: >
  Agent Studio multi-agent orchestration: CLI subprocess management, stream-json
  parsing, Generalist/Coordinator/Specialist pool, IPC streaming, task decomposition,
  worktree isolation, brain injection, skill matching. Trigger: agent services,
  coordinator, specialist pool, system-prompts, stream-json, session resume.
---

# Agent Studio — Agentic Runtime Architect

> **Scope**: Multi-agent orchestration via a **dual CLI + SDK backend** for Agent Studio.

---

## 1. Architecture Overview

Agent Studio is an **Electron desktop app** that orchestrates multiple Claude agents as a team. It supports **two execution backends**:

1. **CLI backend** (default, Claude Max) — spawns the `claude` binary directly as child processes with `--output-format stream-json`
2. **SDK backend** (API key mode) — uses `@anthropic-ai/claude-agent-sdk` `query()` for streaming, with the same `StreamChunk` interface

The backend is selected at runtime by `AuthProvider.supportsSDK()`:

- `claude-max` auth mode → CLI path
- `api-key` auth mode with valid key → SDK path

```
User ↔ Renderer (React/Zustand)
         ↕ IPC (contextBridge)
      Main Process (Node.js)
         ├── GeneralistService    → CLI only — long-lived interactive stdin/stdout pipe
         ├── GeneralistService  → CLI or SDK — per-handoff (routed by AuthProvider)
         ├── SpecialistPoolService → CLI or SDK — per-task (routed by AuthProvider)
         └── SDKExecutor          → Agent SDK query() wrapper, yields StreamChunks
                └── 14 DB-backed specialists
```

**Key principle**: Generalist always runs (CLI) → detects handoff → Coordinator decomposes (CLI or SDK) → Specialist pool executes (CLI or SDK).

### 1.1 SDK Executor (`src/main/services/sdk-executor.ts`)

The `SDKExecutor` class wraps `@anthropic-ai/claude-agent-sdk`'s `query()` into an async generator of `StreamChunk` — the same interface as CLI-based agents. This means all downstream code (IPC, renderer) works identically regardless of backend.

Key features:

- **Deduplication**: Tracks `hasStreamedText` / `processedToolIds` to prevent double emission from `stream_event` deltas + `assistant` message replay
- **Scope guard hooks**: Wires `PreToolUse` hooks via `createScopeGuard()` for file-scope and dangerous-command protection
- **AbortController**: Supports cancellation via `AbortController` passed through to `query()`
- **API key passthrough**: Injects workspace-configured API key into `process.env.ANTHROPIC_API_KEY`

---

## 2. Official Documentation Reference

| Topic               | URL                                                            |
| ------------------- | -------------------------------------------------------------- |
| Claude CLI Usage    | https://code.claude.com/docs/en/cli-usage                      |
| CLI Headless Mode   | https://code.claude.com/docs/en/headless                       |
| CLI Subagents       | https://code.claude.com/docs/en/sub-agents                     |
| Permission Modes    | https://code.claude.com/docs/en/settings#permission-settings   |
| Hooks (CLI)         | https://code.claude.com/docs/en/hooks                          |
| Agent SDK Overview  | https://platform.claude.com/docs/en/agent-sdk/overview         |
| Agent SDK Streaming | https://platform.claude.com/docs/en/agent-sdk/streaming-output |
| Electron Docs       | https://www.electronjs.org/docs/latest/api                     |

---

## 3. File Map

| File                                           | Purpose                                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/main/services/agent-base.service.ts`      | Base class: stream-json parsing, NDJSON buffer, token tracking, env building |
| `src/main/services/generalist.service.ts`      | Long-lived interactive Claude CLI, handoff detection, session resume         |
| `src/main/services/generalist-prompts.ts`      | Generalist system prompt construction                                        |
| `src/main/services/generalist.service.ts`      | Per-message CLI or SDK, task decomposition, skill matching                   |
| `src/main/services/specialist-pool.service.ts` | Parallel/sequential execution, worktree isolation, retry logic               |
| `src/main/services/sdk-executor.ts`            | Agent SDK query() wrapper — yields StreamChunks like CLI path                |
| `src/main/services/sdk-hooks.ts`               | PreToolUse scope guard + dangerous command guard for SDK path                |
| `src/main/services/auth-provider.ts`           | Auth mode detection, API key management, supportsSDK() gate                  |
| `src/main/services/system-prompts.ts`          | PLAN_MODE / BUILD_MODE / DECOMPOSITION system prompts                        |
| `src/main/services/brain.service.ts`           | Persistent project memory (brain context injection)                          |
| `src/main/services/git-worktree.service.ts`    | Create/merge isolated branches for specialist execution                      |
| `src/main/services/env-utils.ts`               | Cross-platform PATH construction for claude CLI discovery                    |
| `src/main/ipc/chat.ipc.ts`                     | Chat message handling, stream forwarding, file change tracking               |
| `src/main/db/schema.sql`                       | Full SQLite schema                                                           |
| `src/main/db/repositories/*.ts`                | Data access: specialist, skill, conversation, worktree, agentSession repos   |
| `src/shared/constants.ts`                      | `IPC_CHANNELS`, constants                                                    |
| `src/shared/types.ts`                          | All TypeScript interfaces                                                    |
| `.claude/agents/*.yml`                         | Agent YAML definitions (14 specialists + generalist + coordinator)           |

---

## 4. CLI Invocation Patterns

### 4.1 Generalist (Interactive, Long-Lived)

```typescript
const args = [
  '--output-format',
  'stream-json',
  '--input-format',
  'stream-json',
  '--verbose',
  ...(isBuildMode
    ? ['--dangerously-skip-permissions']
    : ['--permission-mode', 'plan', '--allowedTools', 'WebSearch,WebFetch']),
  '--system-prompt',
  fullSystemPrompt,
  ...(resumeSessionId ? ['--resume', resumeSessionId] : [])
]
this.process = spawn('claude', args, {
  cwd: workspacePath,
  env: this.buildEnvWithPath(),
  stdio: ['pipe', 'pipe', 'pipe']
})
```

- Process stays alive — stdin/stdout pipe open for entire conversation
- Uses `--resume <session_id>` for conversation continuity
- Auto-compaction at 150K tokens, suggestion at 80K tokens

### 4.2 Coordinator (Per-Message Spawn)

```typescript
const args = [
  '-p',
  augmentedMessage,
  '--output-format',
  'stream-json',
  '--verbose',
  ...(isBuildMode
    ? ['--dangerously-skip-permissions']
    : ['--permission-mode', 'plan', '--allowedTools', 'WebSearch,WebFetch']),
  '--system-prompt',
  systemPrompt,
  ...(sessionId ? ['--resume', sessionId] : [])
]
this.process = spawn('claude', args, { cwd: workspacePath, env, stdio: ['pipe', 'pipe', 'pipe'] })
```

- Fresh process per message (`-p` flag), dies when response completes
- Performs semantic skill matching before sending

### 4.3 Specialist Pool (Parallel Task Execution)

- Each specialist runs in its own git worktree (build mode)
- Parallel execution with dependency ordering (topological sort)
- 10-minute timeout, retry with exponential backoff (2s → 30s, max 2 retries)
- Worktree merged back to main branch on success

> **Detailed stream-json parsing, handoff, and pool execution**: See `references/stream-json-lifecycle.md`
> **Database, IPC streaming, prompts, and constants**: See `references/ipc-db-prompts.md`
> **Known issues and testing guidance**: See `references/known-issues-testing.md`

---

## 5. Antipatterns — Do NOT Do These

### CLI & Process Management

- **AP-1**: Not handling both `error` and `exit` events on child processes
- **AP-2**: Forgetting to flush the NDJSON buffer on process exit
- **AP-3**: Not sending `CHAT_MESSAGE_COMPLETE` on error paths (freezes UI)
- **AP-4**: Using `ipcRenderer.sendSync()` (blocks renderer)
- **AP-5**: Exposing raw `ipcRenderer` via contextBridge
- **AP-6**: Spawning claude without `buildEnvWithPath()`
- **AP-7**: Hardcoding agent IDs instead of using DB specialists

### Execution & Orchestration

- **AP-8**: Running specialists without worktree isolation in build mode
- **AP-9**: Ignoring task dependency ordering (topological sort)
- **AP-10**: Not tracking token usage per agent session
- **AP-11**: Skipping skill matching in coordinator
- **AP-12**: Not injecting brain context into system prompts
- **AP-13**: Mutating shared state across parallel specialist executions
- **AP-14**: Using `--dangerously-skip-permissions` in plan mode

---

## 6. Development Checklist

When modifying the agentic runtime, verify:

- [ ] Every `spawn()` has `error` + `exit` handlers with SIGTERM → SIGKILL flow
- [ ] NDJSON buffer flushed on process exit, partial lines preserved across data events
- [ ] `CHAT_MESSAGE_COMPLETE` sent on ALL code paths (success, error, timeout, abort)
- [ ] New IPC channels added to `IPC_CHANNELS` in `src/shared/constants.ts`
- [ ] `validateSender(event)` called first in all IPC handlers
- [ ] `createDbSession()` on spawn, `completeDbSession()` on exit
- [ ] Worktree created before specialist spawn, merged/abandoned after completion
- [ ] Token usage extracted from result events, persisted to `agent_sessions`
- [ ] Session ID captured from result, stored in sessionMap + DB
- [ ] All `window.api.on*()` return unsubscribe functions
- [ ] System prompts include brain context when enabled
- [ ] `buildEnvWithPath()` used for all claude process spawns
- [ ] Plan mode → `--permission-mode plan`; Build → `--dangerously-skip-permissions`
- [ ] All DB access through repository classes, never direct SQL in services
