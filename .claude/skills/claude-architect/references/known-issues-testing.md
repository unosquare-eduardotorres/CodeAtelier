# Known Issues & Testing Guidance

## Claude CLI Issues

| Issue                                 | Impact                 | Workaround                                                       |
| ------------------------------------- | ---------------------- | ---------------------------------------------------------------- |
| CLI not found in PATH                 | Agent fails to spawn   | `buildEnvWithPath()` augments PATH with common install locations |
| Process zombies after crash           | Resource leaks         | Always SIGTERM → 5s → SIGKILL; clear process reference           |
| Rate limiting (429)                   | Specialist fails       | `rateLimitDelayMs: 10000` + retry with backoff                   |
| Partial NDJSON lines                  | JSON parse errors      | Buffer management — keep incomplete last line                    |
| Session file mismatch                 | Resume fails           | Session stored per `cwd`; must resume from same workspace path   |
| `--permission-mode plan` + tool calls | Tools silently blocked | Generalist only gets `WebSearch,WebFetch` in plan mode           |

## Electron / IPC Issues

| Issue                        | Impact              | Workaround                                                |
| ---------------------------- | ------------------- | --------------------------------------------------------- |
| Renderer never exits loading | UI frozen           | ALWAYS send `CHAT_MESSAGE_COMPLETE`, even on error        |
| IPC listener leaks           | Memory growth       | Always return cleanup functions from `window.api.on*()`   |
| contextBridge serialization  | Object methods lost | Only pass plain objects/arrays through IPC                |
| Sender validation bypass     | Security risk       | Always call `validateSender(event)` first in IPC handlers |

## Worktree Issues

| Issue                                  | Impact                 | Workaround                                            |
| -------------------------------------- | ---------------------- | ----------------------------------------------------- |
| Merge conflicts                        | Specialist output lost | Status → `conflict`, log error, manual resolution     |
| Orphaned worktrees                     | Disk space leak        | Prune worktrees on conversation close                 |
| Multiple specialists editing same file | Conflicts on merge     | Dependency ordering; sequential for overlapping files |

## Agent SDK Known Bugs (Reference for Future Migration)

If/when Agent Studio migrates from CLI to SDK, these open issues apply:

| Issue                                       | #                                                                            | Impact                          |
| ------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------- |
| Session JSONL transcript corruption         | [#244](https://github.com/anthropics/claude-agent-sdk-typescript/issues/244) | Corrupted session files         |
| Custom `systemPrompt` ignored               | [#237](https://github.com/anthropics/claude-agent-sdk-typescript/issues/237) | Agent ignores role instructions |
| Effort default silently overridden          | [#214](https://github.com/anthropics/claude-agent-sdk-typescript/issues/214) | Sonnet defaults to "medium"     |
| MCP server zombie processes                 | [#219](https://github.com/anthropics/claude-agent-sdk-typescript/issues/219) | Resource leaks                  |
| Hooks not propagated to subagents           | [#225](https://github.com/anthropics/claude-agent-sdk-typescript/issues/225) | Subagents bypass hooks          |
| Unbounded memory growth (fixed v0.2.51)     | SDK Changelog                                                                | OOM on long sessions            |
| `session.close()` data loss (fixed v0.2.51) | SDK Changelog                                                                | Resume fails                    |

---

## Testing Guidance

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
