# Hooks, MCP, Subagents, Plugins & Configuration

Advanced Claude Code CLI features — lifecycle hooks, MCP server integration, multi-agent workflows, plugins, and session management.

## Hooks — Lifecycle Automation

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

### Available Hook Points

| Hook           | When it fires                           |
| -------------- | --------------------------------------- |
| `PreFileEdit`  | Before Claude edits a file              |
| `PostFileEdit` | After Claude edits a file               |
| `PreBash`      | Before Claude runs a shell command      |
| `PostBash`     | After Claude runs a shell command       |
| `PreCommit`    | Before Claude creates a git commit      |
| `PostCommit`   | After Claude creates a git commit       |
| `PostCompact`  | After conversation compaction completes |

---

## MCP Server Configuration

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

---

## Subagents and Multi-Agent Workflows

### Spawning Subagents

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

### Worktree Isolation

```bash
# Start in isolated worktree (prevents code changes from interfering)
claude --worktree feature-auth
```

Worktrees are git-managed, auto-cleaned if no changes are made. Also used internally by `/batch`.

---

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

---

## Session Management

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

---

## Configuration Hierarchy

Claude Code configuration has seven layers (most specific wins):

1. **CLAUDE.md** — project instructions (team-shared + personal)
2. **Auto memory** — notes auto-learned from conversations
3. **.claude/rules/** — modular rule files separated by condition
4. **settings.json** — permissions, allowed tools, hooks, env vars
5. **Hooks** — lifecycle automation
6. **Skills** — domain expertise
7. **Plugins** — packaged extensions

### Settings Locations

```
~/.claude/settings.json          # Global user settings
.claude/settings.json            # Project settings (git-tracked)
.claude/settings.local.json      # Local project settings (gitignored)
```
