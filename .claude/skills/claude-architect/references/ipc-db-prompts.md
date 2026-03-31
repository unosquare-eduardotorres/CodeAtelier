# IPC, Database, System Prompts & Constants

Reference for the database layer, IPC streaming architecture, system prompt injection, and key runtime constants.

## Database Layer (SQLite)

### Key Tables

| Table                       | Purpose                                                                |
| --------------------------- | ---------------------------------------------------------------------- |
| `workspaces`                | Registered projects with repo paths and settings                       |
| `conversations`             | Chat sessions (mode: plan/build, claude_session_id)                    |
| `messages`                  | Chat messages (role: user/coordinator/specialist/generalist)           |
| `agent_sessions`            | Token tracking per agent execution (type, pid, status, token_usage)    |
| `specialists`               | DB-backed agent definitions (agent_id, display_name, prompt, priority) |
| `skills`                    | Importable .MD skill files (name, description, filename, is_active)    |
| `specialist_skills`         | Many-to-many junction (specialist ↔ skill)                             |
| `agent_worktrees`           | Git worktree tracking for parallel execution                           |
| `conversation_file_changes` | File modifications per conversation (for selective commits)            |
| `ideas`                     | Quick-capture work items (draft → grilling → completed)                |

### Repository Pattern

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

## IPC Streaming Architecture

### Message Flow

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

### Critical IPC Channels

```typescript
// src/shared/constants.ts
IPC_CHANNELS.CHAT_SEND // Send user message
IPC_CHANNELS.CHAT_MESSAGE_CHUNK // Stream response chunk
IPC_CHANNELS.CHAT_MESSAGE_COMPLETE // Signal response finished (MUST always fire)
IPC_CHANNELS.CHAT_HANDOFF // Generalist detected handoff
IPC_CHANNELS.CHAT_TASK_PLAN // Coordinator produced task plan
IPC_CHANNELS.CHAT_EXECUTE_PLAN // User approved plan execution
IPC_CHANNELS.CHAT_TASK_PROGRESS // Specialist task status update
IPC_CHANNELS.CHAT_STOP // User cancelled
IPC_CHANNELS.CHAT_COMPACT // Trigger context compaction
```

### Event Cleanup Pattern

```typescript
// Renderer — always return cleanup function
const cleanup = window.api.onMessageChunk((chunk) => {
  /* handle */
})
// On unmount:
cleanup()
```

---

## System Prompt Injection

### Generalist Prompt Assembly

```
getGeneralistSystemPrompt(mode)
  + "\n\n---\n\n## Workspace Project Context (from CLAUDE.md)\n\n" + CLAUDE.md content
  + "\n\n---\n\n## Project Brain (Persistent Memory)\n\n" + brainService.getContext()
```

### Coordinator Prompt Assembly

```
PLAN_MODE_SYSTEM_PROMPT or BUILD_MODE_SYSTEM_PROMPT
  + workspace CLAUDE.md
  + Skill match context (semantic matching)
  + Specialist routing instructions
```

### Specialist Prompt Assembly

```
SPECIALIST_TASK_SYSTEM_PROMPT
  + workspace CLAUDE.md
  + specialist.prompt (from DB)
  + Task description with dependency context
```

### Agent YAML Definitions

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

## Key Constants

```typescript
// Generalist
RESPONSE_TIMEOUT_MS = 60_000 // 1 min first-chunk timeout
COMPACT_SUGGEST_THRESHOLD = 80_000 // Suggest compaction at 80K tokens
COMPACT_AUTO_THRESHOLD = 150_000 // Auto-compact at 150K tokens

// Specialist Pool
SPECIALIST_TIMEOUT_MS = 10 * 60 * 1000 // 10 min per specialist
SIGKILL_GRACE_MS = 5000 // 5s SIGTERM → SIGKILL
RETRY_CONFIG.maxRetries = 2 // 3 total attempts
RETRY_CONFIG.baseDelayMs = 2000 // 2s initial delay
RETRY_CONFIG.maxDelayMs = 30000 // 30s max delay
RETRY_CONFIG.rateLimitDelayMs = 10000 // 10s for rate limits

// Coordinator
MAX_SESSION_MAP_SIZE = 100 // Evict oldest sessions
```
