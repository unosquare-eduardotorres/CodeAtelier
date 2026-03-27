---
description: "Agent Studio CLI-based agentic runtime architect. Use for ANY work touching the multi-agent orchestration system: Claude CLI subprocess management, stream-json parsing, Generalist/Orchestrator/Specialist pool, IPC streaming, task decomposition, worktree isolation, brain injection, skill matching, or session resume. Trigger when code touches src/main/services/*service.ts, src/main/ipc/chat.ipc.ts, src/main/db/repositories/, src/shared/constants.ts, .claude/agents/*.yml, or system-prompts.ts."
---

# Agent Studio — Agentic Runtime Architect

> **Scope**: Multi-agent orchestration via **Claude CLI subprocesses** (not the Agent SDK) for Agent Studio.
> This skill covers CLI invocation patterns, stream-json parsing, the Generalist → Orchestrator → Specialist pool architecture, known issues, and antipatterns.

---

## 1. Architecture Overview

Agent Studio is an **Electron desktop app** that orchestrates multiple Claude CLI processes as a team of AI agents. It does **NOT** use `@anthropic-ai/claude-agent-sdk`. Instead, it spawns the `claude` binary directly as child processes with `--output-format stream-json`.

```
User ↔ Renderer (React/Zustand)
         ↕ IPC (contextBridge)
      Main Process (Node.js)
         ├── GeneralistService    → long-lived interactive stdin/stdout pipe
         ├── OrchestratorService  → per-message `claude -p` spawns
         └── SpecialistPoolService → parallel/sequential task execution in worktrees
                └── 14 DB-backed specialists
```

**Key principle**: Generalist always runs → detects handoff → Orchestrator decomposes → Specialist pool executes.

---

## 2. Official Documentation Reference

| Topic | URL |
|-------|-----|
| Claude CLI Usage | https://code.claude.com/docs/en/cli-usage |
| CLI Headless Mode | https://code.claude.com/docs/en/headless |
| CLI Subagents | https://code.claude.com/docs/en/sub-agents |
| Permission Modes | https://code.claude.com/docs/en/settings#permission-settings |
| Hooks (CLI) | https://code.claude.com/docs/en/hooks |
| Claude Code Features | https://code.claude.com/docs/en/features-overview |
| Agent SDK Overview | https://platform.claude.com/docs/en/agent-sdk/overview |
| Agent SDK Streaming | https://platform.claude.com/docs/en/agent-sdk/streaming-output |
| Agent SDK Sessions | https://platform.claude.com/docs/en/agent-sdk/sessions |
| Agent SDK Custom Tools | https://platform.claude.com/docs/en/agent-sdk/custom-tools |
| Agent SDK Hooks | https://platform.claude.com/docs/en/agent-sdk/hooks |
| Agent SDK Permissions | https://platform.claude.com/docs/en/agent-sdk/permissions |
| Agent SDK Subagents | https://platform.claude.com/docs/en/agent-sdk/subagents |
| Agent SDK TypeScript Ref | https://platform.claude.com/docs/en/agent-sdk/typescript |
| TS SDK GitHub | https://github.com/anthropics/claude-agent-sdk-typescript |
| TS SDK Issues | https://github.com/anthropics/claude-agent-sdk-typescript/issues |
| TS SDK Changelog | https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md |
| Electron Docs | https://www.electronjs.org/docs/latest/api |

---

## 3. File Map

| File | Purpose |
|------|---------|
| `src/main/services/agent-base.service.ts` | Base class: stream-json parsing, NDJSON buffer, token tracking, env building |
| `src/main/services/generalist.service.ts` | Long-lived interactive Claude CLI, handoff detection, session resume |
| `src/main/services/generalist-prompts.ts` | Generalist system prompt construction |
| `src/main/services/orchestrator.service.ts` | Per-message `claude -p`, task decomposition, skill matching |
| `src/main/services/specialist-pool.service.ts` | Parallel/sequential execution, worktree isolation, retry logic |
| `src/main/services/system-prompts.ts` | PLAN_MODE / BUILD_MODE / DECOMPOSITION system prompts |
| `src/main/services/brain.service.ts` | Persistent project memory (brain context injection) |
| `src/main/services/git-worktree.service.ts` | Create/merge isolated branches for specialist execution |
| `src/main/services/env-utils.ts` | Cross-platform PATH construction for claude CLI discovery |
| `src/main/ipc/chat.ipc.ts` | Chat message handling, stream forwarding, file change tracking |
| `src/main/ipc/agent.ipc.ts` | Agent status IPC handlers |
| `src/main/db/schema.sql` | Full SQLite schema |
| `src/main/db/repositories/*.ts` | Data access: specialist, skill, conversation, worktree, agentSession repos |
| `src/shared/constants.ts` | `IPC_CHANNELS`, `AGENT_IDS` (deprecated), constants |
| `src/shared/types.ts` | All TypeScript interfaces |
| `src/preload/index.ts` | contextBridge API exposure (`window.api`) |
| `.claude/agents/*.yml` | Agent YAML definitions (14 specialists + generalist + orchestrator) |

---

## 4. Claude CLI Invocation Patterns

### 4.1 Generalist (Interactive, Long-Lived)

```typescript
// generalist.service.ts — start()
const args = [
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--verbose',
  // Mode-dependent permissions:
  ...(isBuildMode
    ? ['--dangerously-skip-permissions']
    : ['--permission-mode', 'plan', '--allowedTools', 'WebSearch,WebFetch']),
  '--system-prompt', fullSystemPrompt,
  ...(resumeSessionId ? ['--resume', resumeSessionId] : [])
]

this.process = spawn('claude', args, {
  cwd: workspacePath,
  env: this.buildEnvWithPath(),
  stdio: ['pipe', 'pipe', 'pipe']
})
```

**Key characteristics**:
- Process stays alive — stdin/stdout pipe open for entire conversation
- Messages sent by writing JSON to `process.stdin`
- Reads NDJSON from stdout line-by-line
- Uses `--resume <session_id>` for conversation continuity
- Auto-compaction at 150K tokens, suggestion at 80K tokens

### 4.2 Orchestrator (Per-Message Spawn)

```typescript
// orchestrator.service.ts — send()
const args = [
  '-p', augmentedMessage,  // <-- prompt flag: exits when done
  '--output-format', 'stream-json',
  '--verbose',
  ...(isBuildMode
    ? ['--dangerously-skip-permissions']
    : ['--permission-mode', 'plan', '--allowedTools', 'WebSearch,WebFetch']),
  '--system-prompt', systemPrompt,
  ...(sessionId ? ['--resume', sessionId] : [])
]

this.process = spawn('claude', args, { cwd: workspacePath, env, stdio: ['pipe', 'pipe', 'pipe'] })
```

**Key characteristics**:
- Fresh process per message (`-p` flag)
- Process dies when response completes
- Performs semantic skill matching before sending
- Session resume for multi-turn continuity within a conversation

### 4.3 Specialist Pool (Parallel Task Execution)

```typescript
// specialist-pool.service.ts — runSpecialistTask()
const args = [
  '-p', taskPrompt,
  '--output-format', 'stream-json',
  '--verbose',
  ...(mode === 'build'
    ? ['--dangerously-skip-permissions']
    : ['--permission-mode', 'plan', '--allowedTools', 'WebSearch,WebFetch']),
  '--system-prompt', fullPrompt
]

const proc = spawn('claude', args, { cwd: taskCwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
```

**Key characteristics**:
- Each specialist runs in its own git worktree (build mode)
- Parallel execution with dependency ordering (topological sort)
- 10-minute timeout per specialist (`SPECIALIST_TIMEOUT_MS`)
- Retry with exponential backoff (2s → 30s, max 2 retries)
- Worktree merged back to main branch on success

---

## 5. Stream-JSON Parsing Engine

### 5.1 NDJSON Format

Claude CLI with `--output-format stream-json` emits newline-delimited JSON. Each line is one event:

```json
{"type":"system","subtype":"init","session_id":"abc123","tools":[...]}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_1","name":"Read","input":{"file_path":"src/main.ts"}}]}}
{"type":"result","subtype":"success","result":"Done","session_id":"abc123","total_cost_usd":0.05,"usage":{"input_tokens":1500,"output_tokens":300}}
```

### 5.2 Buffer Management (AgentBaseService)

```typescript
// Handles partial lines across data events
protected processStdout(data: Buffer): void {
  this.buffer += data.toString('utf-8')
  const lines = this.buffer.split('\n')
  this.buffer = lines.pop() ?? '' // Keep incomplete last line

  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      this.handleStreamEvent(event)
    } catch {
      // Non-JSON line — treat as plain text
      this.emit('chunk', { type: 'text', content: line })
    }
  }
}
```

### 5.3 Stream Event Types

| Event Type | Subtype | When | Key Fields |
|------------|---------|------|------------|
| `system` | `init` | Session start | `session_id`, `tools[]` |
| `assistant` | — | Claude response | `message.content[]` (text + tool_use blocks) |
| `result` | `success` | Task complete | `result`, `total_cost_usd`, `usage`, `session_id` |
| `result` | `error_*` | Task failed | `error`, `session_id` |

### 5.4 StreamChunk Interface

```typescript
interface StreamChunk {
  type: 'text' | 'tool_use' | 'tool_result' | 'error' | 'status'
  content?: string
  toolName?: string
  toolInput?: string
  error?: string
}
```

### 5.5 Tool Input Summarization

```typescript
// agent-base.service.ts — summarizeToolInput()
function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':  return input.description || input.command || ''
    case 'Read':  return input.file_path || ''
    case 'Write':
    case 'Edit':  return input.file_path || ''
    case 'Grep':  return `/${input.pattern}/` + (input.path ? ` in ${input.path}` : '')
    case 'Glob':  return input.pattern || ''
    case 'WebSearch': return input.query || ''
    case 'WebFetch':  return input.url || ''
    default: return ''
  }
}
```

---

## 6. Agent Lifecycle & Handoff

### 6.1 Generalist Handoff Detection

The generalist detects structured markdown code fences and emits events:

```typescript
const HANDOFF_REGEX = /```handoff\n([\s\S]*?)```/
const GRILL_SUMMARY_REGEX = /```grill-summary\n([\s\S]*?)```/
```

**Handoff block schema**:
```json
{
  "summary": "User wants to build a React component...",
  "specialists": ["react-architect", "electron-architect"],
  "mode": "build"
}
```

**Flow**: Generalist emits `handoff` event → IPC sends `CHAT_HANDOFF` to renderer → UI transitions to plan execution → Orchestrator spawns.

### 6.2 Orchestrator Task Decomposition

```typescript
// Uses DECOMPOSITION_SYSTEM_PROMPT
// Returns structured JSON:
interface TaskPlan {
  tasks: DecomposedTask[]
}

interface DecomposedTask {
  id: string           // e.g. "t1"
  specialist: string   // e.g. "react-architect"
  description: string
  dependsOn: string[]  // e.g. ["t1"] — dependency ordering
}
```

### 6.3 Skill Matching

```typescript
// orchestrator.service.ts — matchSkill()
// Semantic matching: message text → active skills
const matchedSkill = await this.matchSkill(message, activeSkills)
// Augments prompt with skill context + specialist routing
```

### 6.4 Session Management

```typescript
// Session persistence per conversation:
// Generalist: sessionMap = Map<conversationId, claudeSessionId>
// Orchestrator: sessionMap = Map<conversationId, claudeSessionId>

// Resume with: --resume <sessionId>
// Session ID captured from stream-json result events
// Stored in conversation.claude_session_id (DB)
```

---

## 7. Specialist Pool Execution

### 7.1 Execution Modes

```typescript
await pool.executeSequential(tasks, mode)  // One at a time, dependency-ordered
await pool.executeParallel(tasks, mode)    // Respecting deps, max parallelism
```

### 7.2 Worktree Isolation (Build Mode)

```
For each specialist task:
  1. gitWorktreeService.create() → isolated branch + directory
  2. Spawn `claude -p` in worktree directory
  3. On success: merge worktree → main branch
  4. On failure: abandon worktree (status: 'abandoned')
  5. Track in agent_worktrees table
```

**Worktree statuses**: `active` → `merging` → `merged` | `conflict` | `abandoned` | `pruned`

### 7.3 Retry Strategy

```typescript
const RETRY_CONFIG = {
  maxRetries: 2,              // 3 total attempts
  baseDelayMs: 2000,          // 2s initial delay
  maxDelayMs: 30000,          // 30s max delay
  backoffMultiplier: 2,       // Exponential backoff
  retryableExitCodes: [1, 137, 143], // General error, SIGKILL, SIGTERM
  rateLimitDelayMs: 10000     // Longer delay for rate-limited retries
}
```

### 7.4 Timeout & Graceful Shutdown

```typescript
const SPECIALIST_TIMEOUT_MS = 10 * 60 * 1000  // 10 minutes
const SIGKILL_GRACE_MS = 5000                   // 5s grace after SIGTERM
// Flow: SIGTERM → wait 5s → SIGKILL → clear reference → emit error
```

### 7.5 Events Emitted

| Event | Payload | When |
|-------|---------|------|
| `taskProgress` | `TaskExecutionProgress` | Task status change |
| `taskChunk` | `{ taskId, specialist, chunk }` | Streaming output per task |
| `allComplete` | void | All tasks finished |

---

## 8. Database Layer (SQLite)

### 8.1 Key Tables

| Table | Purpose |
|-------|---------|
| `workspaces` | Registered projects with repo paths and settings |
| `conversations` | Chat sessions (mode: plan/build, claude_session_id) |
| `messages` | Chat messages (role: user/coordinator/specialist/generalist) |
| `agent_sessions` | Token tracking per agent execution (type, pid, status, token_usage) |
| `specialists` | DB-backed agent definitions (agent_id, display_name, prompt, priority) |
| `skills` | Importable .MD skill files (name, description, filename, is_active) |
| `specialist_skills` | Many-to-many junction (specialist ↔ skill) |
| `agent_worktrees` | Git worktree tracking for parallel execution |
| `conversation_file_changes` | File modifications per conversation (for selective commits) |
| `ideas` | Quick-capture work items (draft → grilling → completed) |

### 8.2 Repository Pattern

```typescript
// Every domain has a repository in src/main/db/repositories/
specialistRepository.findActive()
skillRepository.findActive()
conversationRepository.findByWorkspace(workspaceId)
worktreeRepository.create(...)
agentSessionRepository.create(agentType, { pid, conversationId, workspaceId })
agentSessionRepository.complete(sessionId, status, tokenUsage)
```

---

## 9. IPC Streaming Architecture

### 9.1 Message Flow

```
Renderer: window.api.sendMessage({ conversationId, text, attachments })
    ↓ ipcRenderer.invoke(IPC_CHANNELS.CHAT_SEND, args)
Preload: forwards to main process
    ↓ ipcMain.handle(IPC_CHANNELS.CHAT_SEND, handler)
Main: generalistService.send(text, conversationId)
    ↓ Writes JSON to claude process stdin
Claude: Responds via stdout NDJSON
    ↓ Parsed by AgentBaseService
Main: mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, chunk)
    ↓
Renderer: window.api.onMessageChunk(callback) — real-time UI update
```

### 9.2 Critical IPC Channels

```typescript
// src/shared/constants.ts
IPC_CHANNELS.CHAT_SEND              // Send user message
IPC_CHANNELS.CHAT_MESSAGE_CHUNK     // Stream response chunk
IPC_CHANNELS.CHAT_MESSAGE_COMPLETE  // Signal response finished (MUST always fire)
IPC_CHANNELS.CHAT_HANDOFF           // Generalist detected handoff
IPC_CHANNELS.CHAT_TASK_PLAN         // Orchestrator produced task plan
IPC_CHANNELS.CHAT_EXECUTE_PLAN      // User approved plan execution
IPC_CHANNELS.CHAT_TASK_PROGRESS     // Specialist task status update
IPC_CHANNELS.CHAT_STOP              // User cancelled
IPC_CHANNELS.CHAT_COMPACT           // Trigger context compaction
```

### 9.3 Event Cleanup Pattern

```typescript
// Renderer — always return cleanup function
const cleanup = window.api.onMessageChunk((chunk) => { /* handle */ })
// On unmount:
cleanup()
```

---

## 10. System Prompt Injection

### 10.1 Generalist Prompt Assembly

```
getGeneralistSystemPrompt(mode)
  + "\n\n---\n\n## Workspace Project Context (from CLAUDE.md)\n\n" + CLAUDE.md content
  + "\n\n---\n\n## Project Brain (Persistent Memory)\n\n" + brainService.getContext()
```

### 10.2 Orchestrator Prompt Assembly

```
PLAN_MODE_SYSTEM_PROMPT or BUILD_MODE_SYSTEM_PROMPT
  + workspace CLAUDE.md
  + Skill match context (semantic matching)
  + Specialist routing instructions
```

### 10.3 Specialist Prompt Assembly

```
SPECIALIST_TASK_SYSTEM_PROMPT
  + workspace CLAUDE.md
  + specialist.prompt (from DB)
  + Task description with dependency context
```

### 10.4 Agent YAML Definitions

```yaml
# .claude/agents/react-architect.yml
---
name: react-architect
description: React/TypeScript specialist...
model: sonnet
tools: [Read, Write, Edit, Bash, Grep, Glob, WebSearch]
skills: [electron-pro, ipc-patterns]
---

You are a React specialist...
```

---

## 11. Key Constants

```typescript
// Generalist
RESPONSE_TIMEOUT_MS = 60_000              // 1 min first-chunk timeout
COMPACT_SUGGEST_THRESHOLD = 80_000        // Suggest compaction at 80K tokens
COMPACT_AUTO_THRESHOLD = 150_000          // Auto-compact at 150K tokens

// Specialist Pool
SPECIALIST_TIMEOUT_MS = 10 * 60 * 1000   // 10 min per specialist
SIGKILL_GRACE_MS = 5000                   // 5s SIGTERM → SIGKILL
RETRY_CONFIG.maxRetries = 2              // 3 total attempts
RETRY_CONFIG.baseDelayMs = 2000          // 2s initial delay
RETRY_CONFIG.maxDelayMs = 30000          // 30s max delay
RETRY_CONFIG.rateLimitDelayMs = 10000    // 10s for rate limits

// Orchestrator
MAX_SESSION_MAP_SIZE = 100               // Evict oldest sessions
```

---

## 12. Known Issues & Workarounds

### 12.1 Claude CLI Issues

| Issue | Impact | Workaround |
|-------|--------|------------|
| CLI not found in PATH | Agent fails to spawn | `buildEnvWithPath()` augments PATH with common install locations |
| Process zombies after crash | Resource leaks | Always SIGTERM → 5s → SIGKILL; clear process reference |
| Rate limiting (429) | Specialist fails | `rateLimitDelayMs: 10000` + retry with backoff |
| Partial NDJSON lines | JSON parse errors | Buffer management — keep incomplete last line |
| Session file mismatch | Resume fails | Session stored per `cwd`; must resume from same workspace path |
| `--permission-mode plan` + tool calls | Tools silently blocked | Generalist only gets `WebSearch,WebFetch` in plan mode |

### 12.2 Electron / IPC Issues

| Issue | Impact | Workaround |
|-------|--------|------------|
| Renderer never exits loading | UI frozen | ALWAYS send `CHAT_MESSAGE_COMPLETE`, even on error |
| IPC listener leaks | Memory growth | Always return cleanup functions from `window.api.on*()` |
| contextBridge serialization | Object methods lost | Only pass plain objects/arrays through IPC |
| Sender validation bypass | Security risk | Always call `validateSender(event)` first in IPC handlers |

### 12.3 Worktree Issues

| Issue | Impact | Workaround |
|-------|--------|------------|
| Merge conflicts | Specialist output lost | Status → `conflict`, log error, manual resolution |
| Orphaned worktrees | Disk space leak | Prune worktrees on conversation close |
| Multiple specialists editing same file | Conflicts on merge | Dependency ordering; sequential for overlapping files |

### 12.4 Agent SDK Known Bugs (Reference for Future Migration)

If/when Agent Studio migrates from CLI to SDK, these open issues apply:

| Issue | # | Impact |
|-------|---|--------|
| Session JSONL transcript corruption | [#244](https://github.com/anthropics/claude-agent-sdk-typescript/issues/244) | Corrupted session files |
| Custom `systemPrompt` ignored | [#237](https://github.com/anthropics/claude-agent-sdk-typescript/issues/237) | Agent ignores role instructions |
| Effort default silently overridden | [#214](https://github.com/anthropics/claude-agent-sdk-typescript/issues/214) | Sonnet defaults to "medium" |
| MCP server zombie processes | [#219](https://github.com/anthropics/claude-agent-sdk-typescript/issues/219) | Resource leaks |
| Hooks not propagated to subagents | [#225](https://github.com/anthropics/claude-agent-sdk-typescript/issues/225) | Subagents bypass hooks |
| Unbounded memory growth (fixed v0.2.51) | SDK Changelog | OOM on long sessions |
| `session.close()` data loss (fixed v0.2.51) | SDK Changelog | Resume fails |

---

## 13. Antipatterns — Do NOT Do These

### 13.1 CLI & Process Management

**AP-1: Not handling both `error` and `exit` events on child processes**
Every spawned `claude` process MUST have both `error` and `exit` handlers. Missing one causes unhandled exceptions or zombie processes.

**AP-2: Forgetting to flush the NDJSON buffer on process exit**
When the process exits, `this.buffer` may contain a partial line. Always flush in the `exit` handler.

**AP-3: Not sending `CHAT_MESSAGE_COMPLETE` on error paths**
The renderer waits for this event to exit loading state. Missing it freezes the UI. Every error path must send it.

**AP-4: Using `ipcRenderer.sendSync()`**
This blocks the renderer process. Always use `ipcRenderer.invoke()` / `ipcMain.handle()`.

**AP-5: Exposing raw `ipcRenderer` via contextBridge**
Security violation. Only expose specific methods through `window.api`.

**AP-6: Spawning claude without `buildEnvWithPath()`**
The claude binary may not be in the default PATH. Always use the augmented env.

**AP-7: Hardcoding agent IDs instead of using DB specialists**
`AGENT_IDS` in constants.ts is deprecated. Use `specialistRepository.findActive()`.

### 13.2 Execution & Orchestration

**AP-8: Running specialists without worktree isolation in build mode**
Parallel specialists editing the same repo without isolation causes merge conflicts and data corruption.

**AP-9: Ignoring task dependency ordering**
Always topological sort before execution. Running dependent tasks before their dependencies produces incorrect results.

**AP-10: Not tracking token usage per agent session**
Every agent execution must create a DB session via `createDbSession()` and complete it via `completeDbSession()`. Missing this breaks analytics.

**AP-11: Skipping skill matching in orchestrator**
The orchestrator must attempt semantic skill matching before dispatching to specialists. Without it, specialists lack domain context.

**AP-12: Not injecting brain context into system prompts**
Brain service provides persistent project memory. Skipping `brainService.getContext()` produces lower-quality agent output.

**AP-13: Mutating shared state across parallel specialist executions**
Each specialist runs in isolation. Never share mutable state between concurrent specialist processes.

**AP-14: Using `--dangerously-skip-permissions` in plan mode**
Plan mode is explicitly read-only. Build mode uses skip-permissions. Mixing these breaks the security model.

---

## 14. Development Checklist

When modifying the agentic runtime, verify:

- [ ] **Process cleanup**: Every `spawn()` has `error` + `exit` handlers with SIGTERM → SIGKILL flow
- [ ] **NDJSON buffer**: Buffer flushed on process exit, partial lines preserved across data events
- [ ] **CHAT_MESSAGE_COMPLETE**: Sent on ALL code paths (success, error, timeout, abort)
- [ ] **IPC channels**: New channels added to `IPC_CHANNELS` in `src/shared/constants.ts`
- [ ] **Sender validation**: `validateSender(event)` called first in all IPC handlers
- [ ] **DB session tracking**: `createDbSession()` on spawn, `completeDbSession()` on exit
- [ ] **Worktree lifecycle**: Created before specialist spawn, merged/abandoned after completion
- [ ] **Token tracking**: Usage extracted from result events, persisted to `agent_sessions`
- [ ] **Session resume**: `session_id` captured from result, stored in sessionMap + DB
- [ ] **Cleanup functions**: All `window.api.on*()` return unsubscribe functions
- [ ] **Brain injection**: System prompts include brain context when enabled
- [ ] **Env PATH**: `buildEnvWithPath()` used for all claude process spawns
- [ ] **Mode consistency**: Plan mode → `--permission-mode plan`; Build → `--dangerously-skip-permissions`
- [ ] **Repository pattern**: All DB access through repository classes, never direct SQL in services

---

## 15. Testing Guidance

### Unit Tests

- Mock `spawn()` to return canned NDJSON sequences
- Test `processStdout()` buffer management with partial lines
- Test `summarizeToolInput()` for all tool types
- Test topological sort for dependency ordering
- Test retry logic with various exit codes
- Test handoff regex detection with edge cases

### Integration Tests

- Verify generalist auto-restart on process crash
- Verify worktree create → execute → merge lifecycle
- Verify session resume produces `--resume` flag
- Verify `CHAT_MESSAGE_COMPLETE` fires on all error paths
- Verify parallel specialist execution respects dependency graph

### Smoke Tests

- Generalist plan mode: send message, receive streaming response
- Orchestrator decomposition: verify JSON task plan structure
- Specialist pool: execute 2+ tasks in parallel with worktree isolation
- Mode switch: plan → build → verify permission flags change
- Token tracking: verify `agent_sessions` records created and completed
