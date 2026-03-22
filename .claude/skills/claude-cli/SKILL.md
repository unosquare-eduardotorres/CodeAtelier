---
name: claude-code-cli
description: >
  Use this skill for ANY Claude Code CLI work — running commands, configuring sessions,
  managing CLAUDE.md files, using slash commands, creating custom skills and commands,
  setting up hooks, configuring MCP servers, managing subagents, using print mode for
  automation, piping and scripting with Claude Code, session management, context compaction,
  worktrees, background tasks, plugins, or troubleshooting CLI issues.
  Trigger whenever the user mentions: claude CLI, Claude Code, slash commands, /compact,
  /clear, /help, /init, /review, /simplify, /batch, CLAUDE.md, .claude directory,
  claude code hooks, MCP server configuration, subagents, print mode, -p flag,
  --system-prompt, custom commands, claude code skills, or any terminal-based Claude workflow.
---

# Claude Code CLI

> **Skill version**: 1.0
> **Last updated**: 2026-03-21
> **Claude Code version covered**: up to v2.1.71+
> **Next review date**: 2026-06-21

Comprehensive reference for using Claude Code CLI effectively — commands, configuration, skills, hooks, MCP, subagents, and automation.

## Installation and setup

```bash
# Install globally (requires Node.js 18+)
npm install -g @anthropic-ai/claude-code

# Navigate to your project
cd your-project

# Start Claude Code
claude

# First run opens browser for authentication (Claude Pro/Max subscription or API key)
```

For API key usage instead of subscription:
```bash
export ANTHROPIC_API_KEY=sk-ant-...
claude
```

Supported platforms: macOS 10.15+, Ubuntu 20.04+/Debian 10+, Windows 10+ (WSL or Git Bash required). Shell compatibility: Bash, Zsh, Fish.

## CLI commands and flags

### Launch commands

```bash
claude                          # Start interactive session in current directory
claude "do something"           # Start with initial prompt
claude -c                       # Continue most recent session
claude -c "keep going"          # Continue with a prompt
claude -r <session-id>          # Resume specific session
claude -r <session-id> "next"   # Resume with a prompt
claude --worktree feature-auth  # Start in isolated git worktree (parallel work)
```

### Non-interactive / print mode (-p)

For scripting, automation, and CI/CD pipelines:

```bash
# Basic print mode — outputs response and exits
claude -p "explain this function"

# JSON output for programmatic parsing
claude -p "list all TODO comments" --output-format json

# Pipe input into Claude
cat error.log | claude -p "explain this error"
git diff | claude -p "review this diff"
tail -f app.log | claude -p "alert me if anomalies appear"

# CI/CD usage
claude -p "if there are new text strings, translate to French and raise a PR"
```

### System prompt customization

Four flags, usable in both interactive and non-interactive modes:

```bash
# Replace the entire system prompt (use rarely — loses built-in capabilities)
claude --system-prompt "You are a security auditor"
claude --system-prompt-file ./prompts/auditor.md

# Append to the system prompt (recommended — preserves built-in capabilities)
claude --append-system-prompt "Always respond in Spanish"
claude --append-system-prompt-file ./prompts/conventions.md
```

`--system-prompt` and `--system-prompt-file` are mutually exclusive. The append flags can combine with either.

### Other useful flags

```bash
claude --model claude-opus-4-6          # Override model
claude --add-dir ~/projects/backend     # Add additional directory to context
claude --verbose                        # Verbose logging
claude --allowedTools "Read,Write,Bash" # Restrict available tools
claude -n "my-session"                  # Name the session for easy resumption
```

## Slash commands (in-session)

Type `/` during a session to see all available commands. These are built-in and cannot be customized:

### Session management

| Command | What it does |
|---------|-------------|
| `/clear` | Clear conversation history, start fresh context |
| `/compact` | Summarize conversation to reduce token usage, preserve key decisions |
| `/help` | Show all available commands |
| `/quit` or `/exit` | End the session |

### Context and model

| Command | What it does |
|---------|-------------|
| `/context` | Show current context usage, skill budget, loaded files |
| `/model` | Switch model mid-session (Opus for deep analysis, Sonnet for speed) |
| `/effort` | Set model effort level (low/medium/high) |
| `/fast` | Switch to Haiku for quick tasks |

### Project and navigation

| Command | What it does |
|---------|-------------|
| `/init` | Generate a CLAUDE.md by analyzing your project structure |
| `/add-dir <path>` | Add additional directory to context |
| `/vim` | Toggle vim-style editing mode |
| `/terminal-setup` | Configure Shift+Enter for multi-line input |

### Code workflow

| Command | What it does |
|---------|-------------|
| `/review` | Review code, diffs, or pull requests |
| `/simplify` | 3-agent quality review pipeline before PRs (architecture, duplication, performance) |
| `/batch` | Run large-scale changes in parallel across worktrees, auto-creates PRs |
| `/rewind` | Undo recent changes — choose conversation-only or code-only rollback |
| `/debug` | Troubleshoot current session issues |
| `/plan` | Create an implementation plan before coding |

### Shell commands

```bash
# Run shell commands directly with ! prefix (bypasses conversational mode, saves tokens)
> !npm test
> !git status
> !ls -la src/
```

## CLAUDE.md — project memory

Claude Code automatically reads `CLAUDE.md` on every session. It works in a hierarchy:

```
~/.claude/CLAUDE.md              # Global — applies to all projects
./CLAUDE.md                      # Project root — shared with team via git
./CLAUDE.local.md                # Project local — gitignored, personal preferences
./src/CLAUDE.md                  # Directory-level — applies when working in src/
```

All levels are merged. More specific files override general ones.

### What to put in CLAUDE.md

- Tech stack and framework versions
- Coding conventions (formatting, naming, patterns)
- Build and test commands (`npm test`, `npm run build`)
- Architecture decisions and directory structure
- Common gotchas specific to your project
- Skill routing instructions ("when doing X, read skills/X.md")

### Auto memory

Claude Code also builds automatic memory from conversations, stored in `~/.claude/projects/<project>/memory/`. These are learnings Claude picks up (build commands, debugging insights) without you writing anything.

### Generate CLAUDE.md

```bash
# Let Claude analyze your project and generate a starter CLAUDE.md
claude
> /init
```

Always refine the generated file with project-specific conventions.

## Custom skills (recommended over legacy commands)

Skills are the current recommended format, replacing `.claude/commands/`. They support slash-command invocation AND autonomous invocation by Claude.

### File structure

```
.claude/skills/
└── review-security/
    ├── SKILL.md          # Required — frontmatter + instructions
    └── references/       # Optional — detailed reference docs
        └── owasp-top10.md
```

### SKILL.md format

```markdown
---
name: review-security
description: Run a security-focused code review. Use when reviewing code for
  vulnerabilities, checking auth implementations, or auditing dependencies.
allowed-tools: Read, Grep, Glob
model: claude-opus-4-6
---

Analyze the codebase for security vulnerabilities including:
1. SQL injection risks
2. XSS vulnerabilities
3. Exposed credentials
4. Insecure configurations

Check OWASP Top 10 patterns. Reference `references/owasp-top10.md` for details.
```

### Frontmatter options

| Field | Purpose |
|-------|---------|
| `name` | Becomes the /slash-command name |
| `description` | Helps Claude decide when to auto-invoke + shown in /help |
| `allowed-tools` | Restrict which tools the skill can use |
| `model` | Override model when skill is invoked |
| `effort` | Override effort level |
| `disable-model-invocation: true` | Only user can invoke (for side-effect skills like /deploy) |
| `user-invocable: false` | Only Claude can invoke (background knowledge skills) |
| `isolation: worktree` | Run in isolated git worktree |

### Skill scopes

```
.claude/skills/          # Project skills — shared with team via git
~/.claude/skills/        # Personal skills — available in all projects
```

### Skill budget

Skill descriptions consume context. Budget scales at 2% of context window (fallback: 16,000 chars). Run `/context` to check if skills are being excluded. Override with:
```bash
export SLASH_COMMAND_TOOL_CHAR_BUDGET=32000
```

## Hooks — lifecycle automation

Hooks run shell commands at specific points in Claude's lifecycle. They execute deterministically (not LLM-decided).

### Configuration

In `.claude/settings.json` or `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostFileEdit": {
      "command": "npx prettier --write $CLAUDE_FILE_PATH",
      "description": "Auto-format after every file edit"
    },
    "PreCommit": {
      "command": "npm run lint && npm run test",
      "description": "Lint and test before committing"
    },
    "PostCompact": {
      "command": "echo 'Context compacted at $(date)'",
      "description": "Log compaction events"
    }
  }
}
```

### Available hook points

| Hook | When it fires |
|------|--------------|
| `PreFileEdit` | Before Claude edits a file |
| `PostFileEdit` | After Claude edits a file |
| `PreBash` | Before Claude runs a shell command |
| `PostBash` | After Claude runs a shell command |
| `PreCommit` | Before Claude creates a git commit |
| `PostCommit` | After Claude creates a git commit |
| `PostCompact` | After conversation compaction completes |

## MCP server configuration

MCP (Model Context Protocol) connects Claude Code to external services:

```bash
# Add MCP server via CLI
claude mcp add my-server -e API_KEY=sk-xxx -- npx -y @example/mcp-server

# Add with project scope (shared with team)
claude mcp add my-server --scope project -- python3 servers/my_server.py

# Add with OAuth credentials (for servers like Slack)
claude mcp add slack-server --client-id xxx --client-secret yyy -- npx @slack/mcp-server

# List configured servers
claude mcp list

# Remove a server
claude mcp remove my-server
```

MCP servers are configured in settings (global or per-project). They extend Claude's capabilities with external tools — databases, GitHub, Jira, Slack, Google Drive, etc.

## Subagents and multi-agent workflows

### Spawning subagents

Claude can spawn specialist subagents for parallel work:

```
.claude/agents/
└── reviewer.yml
```

```yaml
---
name: reviewer
description: Use for thorough code reviews
model: sonnet
color: orange
---

You are an expert code reviewer. Focus on security, performance, and maintainability.
```

Claude invokes subagents when tasks match their descriptions. Subagents run in parallel for tasks like:
- Multi-file code review
- Running tests across modules
- Parallel refactoring

### Worktree isolation

```bash
# Start in isolated worktree (prevents code changes from interfering)
claude --worktree feature-auth
```

Worktrees are git-managed, auto-cleaned if no changes are made. Also used internally by `/batch`.

## Plugins

Plugins package skills, hooks, MCP servers, and agents for distribution:

```bash
# Install from marketplace
claude plugin install formatter@my-marketplace

# Install to project scope (shared with team)
claude plugin install formatter@my-marketplace --scope project

# List installed plugins
claude plugin list

# Remove a plugin
claude plugin remove formatter
```

Plugin structure:
```
my-plugin/
├── .claude-plugin/
│   └── plugin.json       # Plugin metadata
├── skills/               # Skills provided by plugin
├── agents/               # Subagents provided by plugin
├── hooks/                # Hooks provided by plugin
└── servers/              # MCP servers provided by plugin
```

## Session management

```bash
# List past sessions
claude --list

# Resume last session
claude -c

# Resume specific session by ID
claude -r <session-id>

# Teleport a remote session to local terminal
claude --teleport <session-id>

# Name sessions for easy identification
claude -n "refactor-auth"
```

Sessions auto-save with full message history and tool state. Conversations persist across surfaces (terminal, VS Code, desktop app, web).

## Configuration hierarchy

Claude Code configuration has seven layers (most specific wins):

1. **CLAUDE.md** — project instructions (team-shared + personal)
2. **Auto memory** — notes auto-learned from conversations
3. **.claude/rules/** — modular rule files separated by condition
4. **settings.json** — permissions, allowed tools, hooks, env vars
5. **Hooks** — lifecycle automation
6. **Skills** — domain expertise
7. **Plugins** — packaged extensions

### Settings locations

```
~/.claude/settings.json          # Global user settings
.claude/settings.json            # Project settings (git-tracked)
.claude/settings.local.json      # Local project settings (gitignored)
```

## Common patterns and recipes

### TDD workflow
```
> "Write a failing test for the user registration endpoint"
> !npm test                    # See it fail
> "Now write the code to make it pass"
> !npm test                    # See it pass
```

### Quick debugging
```
> "Here's the error: [paste stack trace]. Find the cause and fix it"
```

### PR preparation
```
> /simplify                    # 3-agent review pipeline
> "Create a PR with a summary of all changes"
```

### Multi-repo work
```
> /add-dir ~/projects/backend
> /add-dir ~/projects/shared-types
> "Update the User type in shared-types and ensure backend and frontend are consistent"
```

### Context management for long sessions
```
> /compact                     # When context is getting large
> /context                     # Check current usage
> /clear                       # Nuclear option — fresh start
```

## Programmatic CLI Usage (from Electron)

When using Claude CLI programmatically from an Electron main process (as Agent Studio does), follow these patterns:

### Long-lived interactive session

For agents that maintain ongoing conversation (e.g., generalist):

```bash
claude --output-format stream-json --input-format stream-json --verbose \
  --permission-mode plan --allowedTools "WebSearch,WebFetch" \
  --system-prompt "..."
```

- Write JSON prompts to stdin, read NDJSON responses from stdout
- Use `--resume <session-id>` for conversation continuity across restarts
- Process is kept alive for the lifetime of the conversation

### One-shot execution

For ephemeral tasks (e.g., orchestrator handoffs, specialist work):

```bash
claude -p "task description" --system-prompt "..." \
  --output-format stream-json --verbose \
  --dangerously-skip-permissions  # only in build/implementation mode
```

- Process exits after producing output
- Parse NDJSON from stdout for streaming progress

### Key stream-json event types

| Event type | Purpose | Key fields |
|------------|---------|------------|
| `system` | Session initialization | Extract `session_id` for resumption |
| `assistant` | Model response | `content` array with text/tool_use blocks |
| `content_block_start` | Start of a content block | `content_block.type` (text, tool_use) |
| `content_block_delta` | Streaming content | `delta.text` for text, `delta.partial_json` for tool input |
| `content_block_stop` | End of a content block | Block index reference |
| `message_start` | Message begins | `message.usage` for input token count |
| `message_delta` | Message metadata update | `usage.output_tokens` for running count |
| `message_stop` | Message complete | Final signal |
| `result` | Final output | `usage` stats, `is_error` flag |
| `error` | Error occurred | `error.message` |
| `user` | Tool results | `content` array with `tool_result` blocks |

### Environment requirements

```typescript
// Delete CLAUDECODE to avoid nested session errors
delete process.env.CLAUDECODE;

// Ensure claude binary is discoverable
const extraPaths = ['/usr/local/bin', '/opt/homebrew/bin', `${os.homedir()}/.local/bin`];
process.env.PATH = [...extraPaths, process.env.PATH].join(':');
```

### Token tracking

Track token usage from streaming events for compaction decisions:
- `message_start` → `message.usage.input_tokens` (prompt tokens)
- `message_delta` → `usage.output_tokens` (completion tokens, cumulative)
- Suggest `/compact` at 80K total tokens
- Auto-compact at 150K total tokens

## Troubleshooting

| Problem | Solution |
|---------|---------|
| "Context limit reached" | Run `/compact` to summarize and free space |
| Skill not triggering | Run `/context` to check if skill is within budget. Check description matches the task |
| Permission denied on file edit | Check `.claude/settings.json` for `allowedTools` restrictions |
| MCP server not connecting | Run `claude mcp list` to verify config. Check server process is running |
| Slow responses | Switch to Sonnet with `/model` or `/fast` for quick tasks |
| Lost work after crash | Run `claude -c` to resume last session — auto-saved |
| Claude using cat/sed instead of Read/Edit | Add to CLAUDE.md: "Use Read, Edit, Glob, Grep tools instead of bash equivalents" |

---

## Skill sources and refresh guide

### Primary sources

| Source | URL | What to extract |
|--------|-----|-----------------|
| Claude Code overview | https://docs.claude.com/en/docs/claude-code/overview | New features, surfaces, capabilities |
| CLI reference | https://docs.claude.com/en/docs/claude-code/cli-reference | New flags, changed syntax |
| Interactive mode | https://docs.claude.com/en/docs/claude-code/interactive-mode | New shortcuts, slash commands |
| Slash commands / Skills | https://docs.claude.com/en/docs/claude-code/slash-commands | New commands, skill format changes |
| Hooks reference | https://docs.claude.com/en/docs/claude-code/hooks | New hook points |
| Plugins reference | https://docs.claude.com/en/docs/claude-code/plugins-reference | Plugin schema changes |
| SDK slash commands | https://docs.claude.com/en/docs/claude-code/sdk/sdk-slash-commands | SDK integration updates |
| Claude Code changelog | https://docs.claude.com/en/release-notes/claude-code | **Critical** — new features, breaking changes |
| Claude Code GitHub repo | https://github.com/anthropics/claude-code | CHANGELOG.md, new releases |

### Version history

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-03-21 | Initial creation from official docs, CLI reference, interactive mode, skills docs, hooks, MCP, plugins, changelog. Covers commands, flags, slash commands, CLAUDE.md hierarchy, custom skills with frontmatter, hooks lifecycle, MCP configuration, subagents, worktrees, plugins, session management, configuration layers, common patterns, and troubleshooting. |
