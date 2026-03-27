# Stream-JSON Parsing & Agent Lifecycle

Detailed reference for NDJSON parsing, agent handoff, and specialist pool execution patterns.

## Stream-JSON Parsing Engine

### NDJSON Format

Claude CLI with `--output-format stream-json` emits newline-delimited JSON. Each line is one event:

```json
{"type":"system","subtype":"init","session_id":"abc123","tools":[...]}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_1","name":"Read","input":{"file_path":"src/main.ts"}}]}}
{"type":"result","subtype":"success","result":"Done","session_id":"abc123","total_cost_usd":0.05,"usage":{"input_tokens":1500,"output_tokens":300}}
```

### Buffer Management (AgentBaseService)

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

### Stream Event Types

| Event Type  | Subtype   | When            | Key Fields                                        |
| ----------- | --------- | --------------- | ------------------------------------------------- |
| `system`    | `init`    | Session start   | `session_id`, `tools[]`                           |
| `assistant` | —         | Claude response | `message.content[]` (text + tool_use blocks)      |
| `result`    | `success` | Task complete   | `result`, `total_cost_usd`, `usage`, `session_id` |
| `result`    | `error_*` | Task failed     | `error`, `session_id`                             |

### StreamChunk Interface

```typescript
interface StreamChunk {
  type: 'text' | 'tool_use' | 'tool_result' | 'error' | 'status'
  content?: string
  toolName?: string
  toolInput?: string
  error?: string
}
```

### Tool Input Summarization

```typescript
// agent-base.service.ts — summarizeToolInput()
function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return input.description || input.command || ''
    case 'Read':
      return input.file_path || ''
    case 'Write':
    case 'Edit':
      return input.file_path || ''
    case 'Grep':
      return `/${input.pattern}/` + (input.path ? ` in ${input.path}` : '')
    case 'Glob':
      return input.pattern || ''
    case 'WebSearch':
      return input.query || ''
    case 'WebFetch':
      return input.url || ''
    default:
      return ''
  }
}
```

---

## Agent Lifecycle & Handoff

### Generalist Handoff Detection

The generalist detects structured markdown code fences and emits events:

````typescript
const HANDOFF_REGEX = /```handoff\n([\s\S]*?)```/
const GRILL_SUMMARY_REGEX = /```grill-summary\n([\s\S]*?)```/
````

**Handoff block schema**:

```json
{
  "summary": "User wants to build a React component...",
  "specialists": ["react-architect", "electron-architect"],
  "mode": "build"
}
```

**Flow**: Generalist emits `handoff` event → IPC sends `CHAT_HANDOFF` to renderer → UI transitions to plan execution → Orchestrator spawns.

### Orchestrator Task Decomposition

```typescript
// Uses DECOMPOSITION_SYSTEM_PROMPT
// Returns structured JSON:
interface TaskPlan {
  tasks: DecomposedTask[]
}

interface DecomposedTask {
  id: string // e.g. "t1"
  specialist: string // e.g. "react-architect"
  description: string
  dependsOn: string[] // e.g. ["t1"] — dependency ordering
}
```

### Skill Matching

```typescript
// orchestrator.service.ts — matchSkill()
// Semantic matching: message text → active skills
const matchedSkill = await this.matchSkill(message, activeSkills)
// Augments prompt with skill context + specialist routing
```

### Session Management

```typescript
// Session persistence per conversation:
// Generalist: sessionMap = Map<conversationId, claudeSessionId>
// Orchestrator: sessionMap = Map<conversationId, claudeSessionId>

// Resume with: --resume <sessionId>
// Session ID captured from stream-json result events
// Stored in conversation.claude_session_id (DB)
```

---

## Specialist Pool Execution

### Execution Modes

```typescript
await pool.executeSequential(tasks, mode) // One at a time, dependency-ordered
await pool.executeParallel(tasks, mode) // Respecting deps, max parallelism
```

### Worktree Isolation (Build Mode)

```
For each specialist task:
  1. gitWorktreeService.create() → isolated branch + directory
  2. Spawn `claude -p` in worktree directory
  3. On success: merge worktree → main branch
  4. On failure: abandon worktree (status: 'abandoned')
  5. Track in agent_worktrees table
```

**Worktree statuses**: `active` → `merging` → `merged` | `conflict` | `abandoned` | `pruned`

### Retry Strategy

```typescript
const RETRY_CONFIG = {
  maxRetries: 2, // 3 total attempts
  baseDelayMs: 2000, // 2s initial delay
  maxDelayMs: 30000, // 30s max delay
  backoffMultiplier: 2, // Exponential backoff
  retryableExitCodes: [1, 137, 143], // General error, SIGKILL, SIGTERM
  rateLimitDelayMs: 10000 // Longer delay for rate-limited retries
}
```

### Timeout & Graceful Shutdown

```typescript
const SPECIALIST_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes
const SIGKILL_GRACE_MS = 5000 // 5s grace after SIGTERM
// Flow: SIGTERM → wait 5s → SIGKILL → clear reference → emit error
```

### Events Emitted

| Event          | Payload                         | When                      |
| -------------- | ------------------------------- | ------------------------- |
| `taskProgress` | `TaskExecutionProgress`         | Task status change        |
| `taskChunk`    | `{ taskId, specialist, chunk }` | Streaming output per task |
| `allComplete`  | void                            | All tasks finished        |
