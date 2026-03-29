---
name: agent-sdk-patterns
description: >
  Agent SDK integration patterns for Agent Studio. Covers SDK query() API usage,
  hook callbacks, session management, StreamChunk mapping, and dual-backend architecture.
---

# Agent SDK Patterns

> **Skill version**: 1.0
> **Last updated**: 2026-03-28

## Architecture: Dual-Backend Pattern

Agent Studio supports two execution backends:

1. **CLI Backend** (Claude Max) — spawns `claude -p` processes, parses NDJSON stdout
2. **SDK Backend** (API Key) — uses `query()` async generator, typed messages

Both backends produce `StreamChunk` objects — the downstream IPC, store, and UI layers
are backend-agnostic.

### SDKExecutor

The `SDKExecutor` class (`src/main/services/sdk-executor.ts`) bridges SDK messages to StreamChunks:

```typescript
const executor = new SDKExecutor()
for await (const chunk of executor.execute(options)) {
  // chunk: StreamChunk — same interface as CLI-based agents
  emit('chunk', chunk)
}
```

### Auth Provider

`authProvider.supportsSDK()` determines which backend to use:
- `true` → SDK path (API key configured)
- `false` → CLI path (Claude Max, default)

## Hook Patterns

SDK hooks are TypeScript functions, not shell scripts:

```typescript
// src/main/services/sdk-hooks.ts
export function createScopeGuard(allowedCwd: string) {
  return async (input) => {
    if (input.tool_name === 'Write') {
      const path = input.tool_input.file_path
      if (!path.startsWith(allowedCwd)) {
        return { decision: 'block', reason: 'Outside scope' }
      }
    }
    return {}
  }
}
```

Benefits over shell hooks:
- Direct access to services (eventLogger, costTracker, DB)
- Type safety — no JSON parsing or exit code conventions
- Testable — standard TypeScript unit tests
- No cross-platform shell compatibility issues

## Session Management

```typescript
// Capture session ID from SDK messages
for await (const msg of query({ ... })) {
  if (msg.type === 'system' && msg.subtype === 'init') {
    sessionId = msg.session_id
  }
}

// Resume later
query({ prompt, options: { resume: sessionId } })
```

## Error Handling

SDK errors surface as exceptions in the async generator:

```typescript
try {
  for await (const msg of query({ ... })) { ... }
} catch (error) {
  // Network errors, auth failures, rate limits
  emit('chunk', { type: 'error', error: error.message })
}
```
