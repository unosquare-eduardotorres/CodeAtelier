---
name: claude-code-cli
description: >
  Claude Code CLI patterns: commands, sessions, CLAUDE.md, slash commands, skills,
  hooks, MCP servers, subagents, print mode, piping, compaction, worktrees, plugins.
  Trigger: claude CLI, slash command, skill setup, hook config, MCP, session management.
---

# Claude Code CLI

> **Skill version**: 1.0
> **Last updated**: 2026-03-21
> **Claude Code version covered**: up to v2.1.71+

## Installation and Setup

```bash
npm install -g @anthropic-ai/claude-code   # Requires Node.js 18+
cd your-project && claude                   # Start — first run opens browser for auth
```

For API key: `export ANTHROPIC_API_KEY=sk-ant-... && claude`

Supported: macOS 10.15+, Ubuntu 20.04+/Debian 10+, Windows 10+ (WSL/Git Bash). Shells: Bash, Zsh, Fish.

## CLI Commands and Flags

### Launch Commands

```bash
claude                          # Start interactive session
claude "do something"           # Start with initial prompt
claude -c                       # Continue most recent session
claude -c "keep going"          # Continue with a prompt
claude -r <session-id>          # Resume specific session
claude --worktree feature-auth  # Start in isolated git worktree
```

### Non-Interactive / Print Mode (-p)

```bash
claude -p "explain this function"                    # Basic print mode
claude -p "list all TODO comments" --output-format json   # JSON output
cat error.log | claude -p "explain this error"       # Pipe input
git diff | claude -p "review this diff"              # Diff review
```

### System Prompt Customization

```bash
claude --system-prompt "You are a security auditor"          # Replace entire prompt
claude --system-prompt-file ./prompts/auditor.md             # Replace from file
claude --append-system-prompt "Always respond in Spanish"    # Append (recommended)
claude --append-system-prompt-file ./prompts/conventions.md  # Append from file
```

### Other Flags

```bash
claude --model claude-opus-4-6          # Override model
claude --add-dir ~/projects/backend     # Add directory to context
claude --verbose                        # Verbose logging
claude --allowedTools "Read,Write,Bash" # Restrict tools
claude -n "my-session"                  # Name the session
```

## Slash Commands (In-Session)

| Command            | What it does                                                         |
| ------------------ | -------------------------------------------------------------------- |
| `/clear`           | Clear conversation history, start fresh context                      |
| `/compact`         | Summarize conversation to reduce token usage                         |
| `/context`         | Show current context usage, skill budget, loaded files               |
| `/model`           | Switch model mid-session                                             |
| `/effort`          | Set effort level (low/medium/high)                                   |
| `/fast`            | Switch to Haiku for quick tasks                                      |
| `/init`            | Generate CLAUDE.md by analyzing project                              |
| `/review`          | Review code, diffs, or pull requests                                 |
| `/simplify`        | 3-agent quality review pipeline                                      |
| `/batch`           | Run large-scale changes in parallel across worktrees                 |
| `/rewind`          | Undo recent changes                                                  |
| `/plan`            | Create an implementation plan                                        |

Shell commands: `> !npm test` (bypasses conversational mode, saves tokens)

## CLAUDE.md — Project Memory

Claude Code reads `CLAUDE.md` on every session, merged hierarchically:

```
~/.claude/CLAUDE.md              # Global — all projects
./CLAUDE.md                      # Project root — shared via git
./CLAUDE.local.md                # Project local — gitignored
./src/CLAUDE.md                  # Directory-level — applies in src/
```

**What to include**: Tech stack, coding conventions, build/test commands, architecture decisions, common gotchas, skill routing.

Auto memory: `~/.claude/projects/<project>/memory/` — auto-learned from conversations.

Generate starter: `claude` then `/init`

## Custom Skills

Skills are the recommended format (replacing `.claude/commands/`). Support slash-command AND autonomous invocation.

```
.claude/skills/
└── review-security/
    ├── SKILL.md          # Required — frontmatter + instructions
    └── references/       # Optional — detailed reference docs
```

### Frontmatter Options

| Field                            | Purpose                                                  |
| -------------------------------- | -------------------------------------------------------- |
| `name`                           | Becomes the /slash-command name                          |
| `description`                    | Helps Claude decide when to auto-invoke                  |
| `allowed-tools`                  | Restrict which tools the skill can use                   |
| `model`                          | Override model when skill is invoked                     |
| `effort`                         | Override effort level                                    |
| `disable-model-invocation: true` | Only user can invoke (side-effect skills like /deploy)   |
| `user-invocable: false`          | Only Claude can invoke (background knowledge skills)     |
| `isolation: worktree`            | Run in isolated git worktree                             |

### Skill Budget

Descriptions consume context at 2% of context window (fallback: 16,000 chars). Check with `/context`. Override: `export SLASH_COMMAND_TOOL_CHAR_BUDGET=32000`

> **Hooks, MCP servers, subagents, plugins, session management, and configuration**: See `references/hooks-mcp-subagents.md`
> **Common recipes, programmatic CLI usage from Electron, and troubleshooting**: See `references/recipes-programmatic.md`
