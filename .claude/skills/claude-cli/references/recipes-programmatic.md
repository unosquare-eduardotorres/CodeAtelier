# Recipes, Programmatic Usage & Troubleshooting

Common CLI patterns, programmatic usage from Electron, and troubleshooting guide.

## Common Patterns and Recipes

### TDD Workflow

```
> "Write a failing test for the user registration endpoint"
> !npm test                    # See it fail
> "Now write the code to make it pass"
> !npm test                    # See it pass
```

### Quick Debugging

```
> "Here's the error: [paste stack trace]. Find the cause and fix it"
```

### PR Preparation

```
> /simplify                    # 3-agent review pipeline
> "Create a PR with a summary of all changes"
```

### Multi-Repo Work

```
> /add-dir ~/projects/backend
> /add-dir ~/projects/shared-types
> "Update the User type in shared-types and ensure backend and frontend are consistent"
```

### Context Management for Long Sessions

```
> /compact                     # When context is getting large
> /context                     # Check current usage
> /clear                       # Nuclear option — fresh start
```

---

## Programmatic CLI Usage (from Electron)

When using Claude CLI programmatically from an Electron main process (as Agent Studio does), follow these patterns:

### Long-Lived Interactive Session

For agents that maintain ongoing conversation (e.g., generalist):

```bash
claude --output-format stream-json --input-format stream-json --verbose \
  --permission-mode plan --allowedTools "WebSearch,WebFetch" \
  --system-prompt "..."
```

- Write JSON prompts to stdin, read NDJSON responses from stdout
- Use `--resume <session-id>` for conversation continuity across restarts
- Process is kept alive for the lifetime of the conversation

### One-Shot Execution

For ephemeral tasks (e.g., orchestrator handoffs, specialist work):

```bash
claude -p "task description" --system-prompt "..." \
  --output-format stream-json --verbose \
  --dangerously-skip-permissions  # only in build/implementation mode
```

- Process exits after producing output
- Parse NDJSON from stdout for streaming progress

### Key Stream-JSON Event Types

| Event type            | Purpose                  | Key fields                                                 |
| --------------------- | ------------------------ | ---------------------------------------------------------- |
| `system`              | Session initialization   | Extract `session_id` for resumption                        |
| `assistant`           | Model response           | `content` array with text/tool_use blocks                  |
| `content_block_start` | Start of a content block | `content_block.type` (text, tool_use)                      |
| `content_block_delta` | Streaming content        | `delta.text` for text, `delta.partial_json` for tool input |
| `content_block_stop`  | End of a content block   | Block index reference                                      |
| `message_start`       | Message begins           | `message.usage` for input token count                      |
| `message_delta`       | Message metadata update  | `usage.output_tokens` for running count                    |
| `message_stop`        | Message complete         | Final signal                                               |
| `result`              | Final output             | `usage` stats, `is_error` flag                             |
| `error`               | Error occurred           | `error.message`                                            |
| `user`                | Tool results             | `content` array with `tool_result` blocks                  |

### Environment Requirements

```typescript
// Delete CLAUDECODE to avoid nested session errors
delete process.env.CLAUDECODE

// Ensure claude binary is discoverable
const extraPaths = ['/usr/local/bin', '/opt/homebrew/bin', `${os.homedir()}/.local/bin`]
process.env.PATH = [...extraPaths, process.env.PATH].join(':')
```

### Token Tracking

Track token usage from streaming events for compaction decisions:

- `message_start` → `message.usage.input_tokens` (prompt tokens)
- `message_delta` → `usage.output_tokens` (completion tokens, cumulative)
- Suggest `/compact` at 80K total tokens
- Auto-compact at 150K total tokens

---

## Troubleshooting

| Problem                                   | Solution                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| "Context limit reached"                   | Run `/compact` to summarize and free space                                            |
| Skill not triggering                      | Run `/context` to check if skill is within budget. Check description matches the task |
| Permission denied on file edit            | Check `.claude/settings.json` for `allowedTools` restrictions                         |
| MCP server not connecting                 | Run `claude mcp list` to verify config. Check server process is running               |
| Slow responses                            | Switch to Sonnet with `/model` or `/fast` for quick tasks                             |
| Lost work after crash                     | Run `claude -c` to resume last session — auto-saved                                   |
| Claude using cat/sed instead of Read/Edit | Add to CLAUDE.md: "Use Read, Edit, Glob, Grep tools instead of bash equivalents"      |

---

## Skill Sources and Refresh Guide

### Primary Sources

| Source                  | URL                                                                | What to extract                               |
| ----------------------- | ------------------------------------------------------------------ | --------------------------------------------- |
| Claude Code overview    | https://docs.claude.com/en/docs/claude-code/overview               | New features, surfaces, capabilities          |
| CLI reference           | https://docs.claude.com/en/docs/claude-code/cli-reference          | New flags, changed syntax                     |
| Interactive mode        | https://docs.claude.com/en/docs/claude-code/interactive-mode       | New shortcuts, slash commands                 |
| Slash commands / Skills | https://docs.claude.com/en/docs/claude-code/slash-commands         | New commands, skill format changes            |
| Hooks reference         | https://docs.claude.com/en/docs/claude-code/hooks                  | New hook points                               |
| Plugins reference       | https://docs.claude.com/en/docs/claude-code/plugins-reference      | Plugin schema changes                         |
| SDK slash commands      | https://docs.claude.com/en/docs/claude-code/sdk/sdk-slash-commands | SDK integration updates                       |
| Claude Code changelog   | https://docs.claude.com/en/release-notes/claude-code               | **Critical** — new features, breaking changes |
| Claude Code GitHub repo | https://github.com/anthropics/claude-code                          | CHANGELOG.md, new releases                    |
