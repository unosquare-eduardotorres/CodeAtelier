# AI & Claude Topics in Agent Studio — Presentation Guide

**Purpose:** Training material covering every Claude/AI concept used (or planned) in Agent Studio.
**Last updated:** 2026-03-26

---

## Table of Contents

1. [Claude Models & Tiers](#1-claude-models--tiers)
2. [Claude CLI Integration](#2-claude-cli-integration)
3. [Agent Architecture](#3-agent-architecture)
4. [Specialists](#4-specialists)
5. [Skills System](#5-skills-system)
6. [CLAUDE.md — Project Context Files](#6-claudemd--project-context-files)
7. [Agent YAML Definitions](#7-agent-yaml-definitions)
8. [System Prompts & Prompt Engineering](#8-system-prompts--prompt-engineering)
9. [Conversation Modes (Plan vs Build)](#9-conversation-modes-plan-vs-build)
10. [Task Decomposition & Complexity Scoring](#10-task-decomposition--complexity-scoring)
11. [Streaming & Output Formats](#11-streaming--output-formats)
12. [Context Window Management & Compaction](#12-context-window-management--compaction)
13. [Token Tracking & Usage Analytics](#13-token-tracking--usage-analytics)
14. [Brain System (Persistent Memory)](#14-brain-system-persistent-memory)
15. [Memory Protocol (In-Conversation)](#15-memory-protocol-in-conversation)
16. [Handoff Protocol](#16-handoff-protocol)
17. [Grill Mode (Decision Extraction)](#17-grill-mode-decision-extraction)
18. [Git Worktree Isolation](#18-git-worktree-isolation)
19. [Workspace Activation & Deployment](#19-workspace-activation--deployment)
20. [Ideas System](#20-ideas-system)
21. [Mermaid Diagram Generation](#21-mermaid-diagram-generation)
22. [Planned / Not Yet Implemented](#22-planned--not-yet-implemented)

---

## 1. Claude Models & Tiers

Agent Studio uses **three Claude model tiers**, each selected based on task complexity:

| Model | ID in Code | Used For |
|-------|-----------|----------|
| **Haiku** | `claude-haiku-4-20250414` | Fast, cheap tasks: brain feed summarization, simple sub-tasks (complexity 0-4) |
| **Sonnet** | `claude-sonnet-4-20250514` | Default model: workspace activation, CLAUDE.md generation, moderate sub-tasks (complexity 5-8), generalist chat, orchestrator |
| **Opus** | (via complexity scoring) | Complex sub-tasks: architecture changes, security-sensitive work, refactors (complexity 9-14) |

**Where models are configured:**
- `src/shared/constants.ts` — `ACTIVATION_MODEL_ID` (Sonnet) and `BRAIN_FEED_MODEL_ID` (Haiku)
- Agent YAML frontmatter — `model: sonnet` or `model: claude-sonnet-4-6`
- Decomposition system prompt — dynamic model assignment based on complexity scoring

**Key concept:** The system doesn't just pick one model — it uses **complexity scoring** to route each sub-task to the cheapest model that can handle it. Simple config changes get Haiku; architecture refactors get Opus.

---

## 2. Claude CLI Integration

Agent Studio does **not** use the Anthropic API directly. It spawns **Claude CLI processes** (`claude` command) as child processes.

### Two execution patterns:

| Pattern | CLI Flags | Used By |
|---------|-----------|---------|
| **Interactive session** | `claude --output-format stream-json --input-format stream-json` | Generalist (long-lived, stdin/stdout conversation) |
| **Print mode (one-shot)** | `claude -p "prompt" --output-format stream-json` | Orchestrator, Specialists, Brain Feed, Skill activation |

### Key CLI flags used:
- `--output-format stream-json` — NDJSON streaming for real-time UI updates
- `--output-format text` — Plain text output for decomposition and summarization
- `--permission-mode plan` — Read-only mode (no file writes)
- `--permission-mode default` — Full access mode (build mode)
- `--allowedTools WebSearch,WebFetch` — Restrict tool access per agent
- `--model <id>` — Override the default model
- `--system-prompt <prompt>` — Inject system prompt for one-shot calls

### Authentication:
- Uses **Claude Max subscription** via `claude login` (OAuth)
- No API keys needed — the CLI handles auth
- One-time login persists across all spawned agent processes

**Key files:** `generalist.service.ts`, `orchestrator.service.ts`, `specialist-pool.service.ts`, `brain-feed.service.ts`

---

## 3. Agent Architecture

Agent Studio follows a **generalist-first, hierarchical delegation** model:

```
User <--always--> Generalist (long-lived session)
                      |
                      | (detects implementation work)
                      v
                  Orchestrator (on-demand, per-handoff)
                      |
                      | (decomposes into sub-tasks)
                      v
              Specialist Pool (parallel execution)
           /      |       |      \
      react   dotnet   db    electron  ...
```

### Three agent layers:

| Layer | Count | Lifecycle | Process Type |
|-------|-------|-----------|-------------|
| **Generalist** | 1 | Long-lived (entire workspace session) | Interactive `claude` with stdin/stdout |
| **Orchestrator** | 1 | On-demand (per handoff) | `claude -p` per message |
| **Specialists** | 14 | On-demand (per sub-task) | `claude -p` per task, isolated worktrees |

### The 16 agents:

1. `generalist-agent` — Default entry point, handles chat/Q&A/review
2. `orchestrator` — Coordinates specialists, decomposes tasks
3. `react-architect` — React/TypeScript frontend
4. `dotnet-architect` — .NET/C# backend
5. `electron-architect` — Electron desktop app
6. `agentic-architect` — AI agent architecture
7. `db-architect` — Database (SQLite/PostgreSQL)
8. `ux-ui-specialist` — UX/UI design
9. `git-github-specialist` — Git workflows
10. `requirements-specialist` — Business analysis/user stories
11. `code-planner` — Code structure planning
12. `execution-planner` — Sprint/task planning
13. `cicd-devops` — CI/CD pipelines
14. `cloud-infrastructure` — Cloud architecture
15. `docs-diagrams-specialist` — Documentation & Mermaid diagrams

**Key files:** `.claude/agents/*.yml`, `src/main/services/generalist.service.ts`, `src/main/services/orchestrator.service.ts`, `src/main/services/specialist-pool.service.ts`

---

## 4. Specialists

Specialists are the **worker agents** that execute actual tasks. They are stored in the database and synced to workspace `.claude/agents/` directories.

### Specialist lifecycle:
1. Defined as YAML in `.claude/agents/`
2. Discovered and imported into SQLite via `agent-sync.service.ts`
3. Deployed to target workspace via `workspace-deploy.service.ts`
4. Spawned as `claude -p` processes by `specialist-pool.service.ts`
5. Each runs in an isolated Git worktree (build mode)

### Database record includes:
- `id`, `name`, `description`, `prompt` (system prompt)
- `tools` (permitted CLI tools)
- `skills` (linked skill names)
- `model` (default model tier)
- `isActive` (deployed to current workspace or not)

### Execution strategies:
- **Sequential** — Tasks run one after another (safe, no merge conflicts)
- **Parallel** — Independent tasks run concurrently in separate worktrees (fast, needs dependency ordering)

**Key files:** `src/main/db/repositories/specialist.repository.ts`, `src/main/services/specialist-pool.service.ts`, `src/main/services/agent-sync.service.ts`

---

## 5. Skills System

Skills are **knowledge files** that augment agent capabilities. They contain domain expertise, best practices, and reference material.

### Skill structure:
```
.claude/skills/
  electron-pro/
    SKILL.md            <-- Main skill file (frontmatter + content)
    references/
      advanced-patterns.md
      packaging-and-native.md
      sources.md
```

### Available skills (13 total):

| Skill | Lines | Used By |
|-------|-------|---------|
| `electron-pro` | 846+ | react-architect, electron-architect, cicd-devops |
| `dotnet-architect` | Large | dotnet-architect |
| `claude-cli` | Large | electron-architect, agentic-architect |
| `sqlite-patterns` | Medium | db-architect |
| `ui-ux-pro-max` | Medium | ux-ui-specialist |
| `ui-styling` | Medium | ux-ui-specialist |
| `design-system` | Medium | ux-ui-specialist |
| `brand` | Medium | ux-ui-specialist |
| `git-workflow` | Medium | git-github-specialist |
| `ipc-patterns` | Medium | react-architect, electron-architect, agentic-architect |
| `mermaid-diagrams` | Large (23 diagram types + references) | docs-diagrams-specialist |
| `design-docs` | Large (5 templates + 6 guides) | docs-diagrams-specialist |
| `general-dev` | Medium | generalist-developer |
| `tailwind-ux` | Medium | (UI styling) |

### How skills are injected:
1. Skill content is read from `.claude/skills/<name>/SKILL.md`
2. Concatenated with the specialist's system prompt
3. Injected via `--system-prompt` when spawning the specialist process
4. The agent gets the skill knowledge as part of its context

### Skill activation flow:
- `skill.service.ts` validates, imports, and activates skills
- Uses `claude -p` with Sonnet model to generate CLAUDE.md integration
- Skills are synced to workspaces via `workspace-deploy.service.ts`

**Key files:** `src/main/services/skill.service.ts`, `src/main/db/repositories/skill.repository.ts`, `.claude/skills/*/SKILL.md`

---

## 6. CLAUDE.md — Project Context Files

`CLAUDE.md` is the **project instruction file** that Claude CLI automatically reads when starting a session in a directory. It's the most important context mechanism.

### What it contains:
- Project overview and tech stack
- Coding conventions and patterns
- Project structure
- Available skills and their triggers
- What NOT to do (anti-patterns)
- Key commands (dev, build, test)
- Architecture notes
- Error handling patterns

### How Agent Studio uses it:
1. **Reads** existing workspace CLAUDE.md to understand the project (`scanWorkspaceClaude`)
2. **Generates** CLAUDE.md content for new workspaces using AI (Sonnet model)
3. **Updates** CLAUDE.md when agents/skills are deployed (`addToClaudeMd`) or removed (`removeFromClaudeMd`)
4. **Feeds** CLAUDE.md content into the Brain system for persistent memory (`feedFromClaudeMd`)
5. **Confirms** generated CLAUDE.md with the user before writing (`confirmClaudeMd`)

### Generation flow:
- Scans the workspace (tree listing, key files)
- Sends to Claude Sonnet with a structured prompt
- User reviews and confirms
- Written to `{workspace}/CLAUDE.md`

**Key files:** `src/main/services/workspace-deploy.service.ts` (methods: `activateAgents`, `confirmClaudeMd`, `addToClaudeMd`, `removeFromClaudeMd`)

---

## 7. Agent YAML Definitions

Each agent is defined as a YAML file in `.claude/agents/` with a specific structure:

```yaml
---
name: react-architect
description: >
  Frontend React/TypeScript specialist...
model: sonnet
tools: [Read, Write, Edit, Bash, Grep, Glob, WebSearch, WebFetch]
skills:
  - electron-pro
  - ipc-patterns
---

You are a React/TypeScript architecture specialist...
(system prompt body in markdown)
```

### YAML frontmatter fields:
| Field | Purpose |
|-------|---------|
| `name` | Agent identifier (matches specialist ID) |
| `description` | What triggers this agent and what it handles |
| `model` | Default Claude model (`sonnet`, `claude-sonnet-4-6`, etc.) |
| `tools` | Permitted Claude CLI tools (Read, Write, Edit, Bash, Grep, Glob, WebSearch, WebFetch, Agent) |
| `skills` | Skill names to load (references `.claude/skills/<name>/SKILL.md`) |

### Special case — Orchestrator:
The orchestrator uses the `Agent()` tool to delegate to other agents:
```yaml
tools: [Agent(react-architect, dotnet-architect, ...), Read, Grep, Glob]
```

**Key files:** `.claude/agents/*.yml` (15 files)

---

## 8. System Prompts & Prompt Engineering

Agent Studio uses multiple layers of system prompts:

### Prompt layers (from most general to most specific):

| Layer | Source | Injected How |
|-------|--------|-------------|
| **Mode prompt** | `system-prompts.ts` | `PLAN_MODE_SYSTEM_PROMPT` or `BUILD_MODE_SYSTEM_PROMPT` |
| **Agent YAML body** | `.claude/agents/*.yml` | The markdown content after the YAML frontmatter |
| **Skill content** | `.claude/skills/*/SKILL.md` | Concatenated with specialist prompt |
| **Workspace CLAUDE.md** | `{workspace}/CLAUDE.md` | Auto-read by Claude CLI |
| **Brain context** | `.brain/` files | Injected as additional context |
| **Decomposition prompt** | `system-prompts.ts` | `DECOMPOSITION_SYSTEM_PROMPT` — includes complexity scoring rubric |
| **Specialist task prompt** | `system-prompts.ts` | `SPECIALIST_TASK_SYSTEM_PROMPT` — focus instructions |

### Generalist-specific prompts (`generalist-prompts.ts`):
- `BASE_PROMPT` — Core personality, handoff protocol, grill mode, memory protocol
- `PLAN_MODE_SECTION` — Read-only boundaries
- `BUILD_MODE_SECTION` — Full access + when to hand off vs do directly
- `getGeneralistSystemPrompt(mode)` — Combines mode section + base prompt

### Key prompt engineering patterns used:
- **Structured output blocks** — `handoff`, `grill-summary`, `memory`, `plan` fenced code blocks
- **Role assignment** — "You are a senior software architect in Plan mode"
- **Boundary definition** — Explicit lists of what agents CAN and CANNOT do
- **Few-shot examples** — JSON schemas in decomposition prompt
- **Scoring rubrics** — Complexity dimensions with numeric ranges

---

## 9. Conversation Modes (Plan vs Build)

Agent Studio supports two operational modes that change agent permissions:

| Aspect | Plan Mode | Build Mode |
|--------|-----------|------------|
| **File access** | Read-only | Read + Write + Edit |
| **Commands** | None | Full bash access |
| **CLI flag** | `--permission-mode plan` | (default permissions) |
| **Generalist tools** | `WebSearch, WebFetch` only | Full tool access |
| **Use case** | Q&A, code review, brainstorming | Implementation, running commands |

### Mode switching:
- The `ConversationMode` type is `'plan' | 'build'`
- Generalist can switch modes via `switchMode()` method
- Mode affects both the system prompt and the CLI flags passed
- Specialists in plan mode get `--permission-mode plan`
- Specialists in build mode get isolated worktrees for safe execution

**Key files:** `src/shared/types.ts` (ConversationMode), `src/main/services/generalist.service.ts` (switchMode), `src/main/services/generalist-prompts.ts`

---

## 10. Task Decomposition & Complexity Scoring

When the orchestrator receives a handoff, it decomposes the work into sub-tasks with **automatic complexity scoring**.

### Decomposition flow:
1. Generalist detects implementation work and emits a `handoff` block
2. Orchestrator calls `decompose()` — spawns `claude -p` with `DECOMPOSITION_SYSTEM_PROMPT`
3. Claude returns structured JSON with tasks + complexity scores
4. System routes each task to the appropriate model tier

### Complexity scoring dimensions:

| Dimension | Range | Criteria |
|-----------|-------|----------|
| `filesAffected` | 0-3 | 1 file=0, 2-3=1, 4-6=2, 7+=3 |
| `estimatedLines` | 0-3 | <50=0, 50-150=1, 150-300=2, 300+=3 |
| `newDependencies` | 0-2 | 0 deps=0, 1-2=1, 3+=2 |
| `taskType` | 0-3 | docs/config=0, test=1, implementation=2, architecture/refactor=3 |
| `riskFlags` | 0-3 | +1 each for: security-sensitive, external integration, breaking change |

### Model routing:
| Total Score | Tier | Model |
|-------------|------|-------|
| 0-4 | Simple | Haiku |
| 5-8 | Moderate | Sonnet |
| 9-14 | Complex | Opus |

### Execution strategies:
- **Sequential** — Tasks with dependencies run in order
- **Parallel** — Independent tasks run concurrently (topologically sorted)
- Orchestrator uses `topologicalSort()` to determine execution waves

**Key files:** `src/main/services/system-prompts.ts` (DECOMPOSITION_SYSTEM_PROMPT), `src/main/services/orchestrator.service.ts` (decompose, matchSkill, topologicalSort)

---

## 11. Streaming & Output Formats

Agent Studio streams Claude CLI output in real-time to the UI using **NDJSON (Newline-Delimited JSON)**.

### Stream event types:

| Event Type | Content |
|------------|---------|
| `text` | Text content blocks (streamed token by token) |
| `tool_use` | Tool invocation (Read, Write, Bash, etc.) with input/output |
| `tool_result` | Result from a tool execution |
| `result` | Final message with token usage statistics |
| `system` | System events (session init, subagent activity) |
| `error` | Error messages |

### Stream processing pipeline:
1. Claude CLI writes NDJSON to stdout
2. `agent-base.service.ts` buffers partial lines and parses complete JSON lines
3. `processStreamEvent()` routes each event type to handlers
4. Events are forwarded via Electron IPC to the renderer
5. React components update in real-time (chat messages, tool activity, agent status)

### Buffer handling:
- NDJSON lines can arrive split across `data` events
- Each agent maintains a line buffer that accumulates partial data
- Complete lines (ending with `\n`) are parsed; remainder stays in buffer
- Buffer is flushed on process exit

**Key files:** `src/main/services/agent-base.service.ts` (handleOutput, processStreamEvent), `src/main/ipc/chat.ipc.ts`

---

## 12. Context Window Management & Compaction

Claude has a ~200K token context window. Agent Studio actively manages this:

### Thresholds:
| Level | Tokens | Action |
|-------|--------|--------|
| **Suggest** | 80,000 | Emit `compactNeeded` event with `level: 'suggest'` |
| **Critical** | 150,000 | Emit `compactNeeded` event with `level: 'critical'` (auto-compact) |

### Compaction:
- Sends `/compact` command to the Claude CLI process
- Claude summarizes the entire conversation into a concise context summary
- Resets the suggestion flag so it can re-trigger after compaction
- Brain context uses `~4 chars per token` estimate for size calculations

### Brain file compaction:
- Brain markdown files (changelog, decisions, errors) have a `MAX_LINES` limit
- When exceeded, `compactIfNeeded()` trims older entries
- Keeps the most recent entries within the line budget

**Key files:** `src/main/services/generalist.service.ts` (compact, COMPACT_SUGGEST_THRESHOLD, COMPACT_AUTO_THRESHOLD), `src/main/services/brain.service.ts` (compactIfNeeded)

---

## 13. Token Tracking & Usage Analytics

Every agent session records token usage:

### What's tracked:
- `token_usage` — Total tokens consumed per session
- `agent_type` — Which agent consumed them
- `started_at` / `ended_at` — Session duration
- `status` — running, completed, failed, terminated
- `conversation_id` / `workspace_id` — Context

### TokenSummary interface:
```typescript
interface TokenSummary {
  totalTokens: number
  sessionCount: number
  byAgent: { agentType: string; totalTokens: number; sessionCount: number }[]
}
```

### How it works:
- `agent-base.service.ts` parses `result` events from stream-json for token counts
- `agent-session.repository.ts` stores sessions in SQLite
- `token.ipc.ts` exposes token data to the renderer
- UI can display per-agent and per-workspace token consumption

**Key files:** `src/main/db/repositories/agent-session.repository.ts`, `src/main/ipc/token.ipc.ts`, `src/main/services/agent-base.service.ts`

---

## 14. Brain System (Persistent Memory)

The Brain is a **file-based persistent memory** system stored in `{workspace}/.brain/`.

### Brain files:
| File | Purpose |
|------|---------|
| `project-state.md` | Current project snapshot (tech stack, architecture, active work) |
| `changelog.md` | Log of completed work (what was done, when, by which agent) |
| `decisions-log.md` | Architecture and design decisions |
| `errors-resolutions.md` | Errors encountered and how they were resolved |

### Brain operations:
- `initialize()` — Creates `.brain/` with template files
- `logCompletion()` — Appends completed-work entries
- `logDecision()` — Records architecture decisions
- `logError()` — Records errors and resolutions
- `updateProjectState()` — Updates the project snapshot
- `getContext()` — Reads all brain files, returns combined context for injection
- `summarizeConversation()` — Uses AI to summarize a conversation into brain entries
- `syncIdeasToProjectState()` — Syncs approved ideas into the project state

### Brain Feed (AI-powered ingestion):
The `brain-feed.service.ts` uses Claude (Haiku model) to automatically populate brain files from:
1. **CLAUDE.md** — Extracts project state and decisions from the project context file
2. **Codebase** — Scans file tree + key files, AI-generates project summaries
3. **Documents** — Parses uploaded docs (DOCX, PDF, etc.) and extracts relevant info

### Caching:
- Brain context is cached per workspace with a 30-second TTL
- Cache is invalidated on any write operation

**Key files:** `src/main/services/brain.service.ts`, `src/main/services/brain-feed.service.ts`, `src/main/ipc/brain.ipc.ts`

---

## 15. Memory Protocol (In-Conversation)

The generalist can emit **memory blocks** during conversation to persist learnings:

```json
{"type": "user", "title": "Preferred testing approach", "content": "User prefers integration tests over unit tests with real DB, not mocks"}
```

### Memory types:
| Type | Scope | Example |
|------|-------|---------|
| `user` | Cross-workspace | "User prefers Zustand over Redux" |
| `feedback` | Cross-workspace | "Don't use default exports in this project" |
| `project` | Per-workspace | "Architecture uses vertical slice pattern" |
| `reference` | Per-workspace | "API docs at https://..." |

### When memories are emitted:
- User states a preference or convention
- User corrects the agent's approach
- Architecture decisions are made
- Project-specific patterns are discovered

**Key files:** `src/main/services/generalist-prompts.ts` (Memory Protocol section)

---

## 16. Handoff Protocol

The handoff protocol is how the generalist delegates work to specialists:

### Handoff block structure:
```json
{
  "action": "handoff",
  "summary": "Brief summary of what needs to be done",
  "decisions": ["Decided to use Zustand over Redux"],
  "constraints": ["Must maintain backward compatibility"],
  "filesDiscussed": ["src/main/services/memory.service.ts"],
  "specialists": ["react-architect", "db-architect"],
  "mode": "build"
}
```

### Detection flow:
1. Generalist's response is parsed by `detectHandoff()` in `generalist.service.ts`
2. If a `handoff` fenced code block is found, a `HandoffEvent` is emitted
3. The orchestrator receives the handoff and calls `decompose()` to break it into sub-tasks
4. Specialists are spawned based on the decomposition result

### Mode in handoff:
- `"mode": "plan"` — Specialists analyze and produce plans (read-only)
- `"mode": "build"` — Specialists make actual code changes (write access, worktrees)

**Key files:** `src/main/services/generalist.service.ts` (detectHandoff), `src/main/services/generalist-prompts.ts` (Handoff Protocol)

---

## 17. Grill Mode (Decision Extraction)

Grill mode is an **interview-driven approach** for resolving ambiguity before implementation:

### How it works:
1. User sends `[GRILL MODE ACTIVATED]`
2. Generalist reviews all prior conversation context
3. Identifies every unresolved decision, ambiguity, or dependency
4. Asks questions one at a time with recommended answers
5. Explores the codebase to answer questions when possible
6. When all branches are resolved, emits a `grill-summary` block:

```json
{
  "summary": "Brief overview of all resolved decisions",
  "proposedTasks": [
    {"title": "Task title", "description": "What to implement"}
  ]
}
```

### Detection:
- `detectGrillSummary()` in `generalist.service.ts` parses the grill-summary block
- Emits a `GrillCompleteEvent` with the summary and proposed tasks

**Key files:** `src/main/services/generalist.service.ts` (detectGrillSummary), `src/main/services/generalist-prompts.ts` (Grill Mode Protocol)

---

## 18. Git Worktree Isolation

Specialists in build mode work in **isolated Git worktrees** to prevent file conflicts:

### Flow:
1. Task is assigned to a specialist
2. `git-worktree.service.ts` creates a worktree: `git worktree add .claude/worktrees/{name} -b agent/{name}`
3. Specialist's `claude -p` process runs with `cwd` set to the worktree
4. On completion, changes are merged back to the main branch
5. Worktree is pruned after merge

### Merge handling:
- `merge()` — Merges a single worktree branch back
- `mergeAll()` — Merges all completed worktrees
- Conflict detection via `MergeConflict` interface
- `getDiff()` — Shows changes made in a worktree
- `.gitignore` is auto-updated to exclude `.claude/worktrees/`

**Key files:** `src/main/services/git-worktree.service.ts`, `src/main/services/specialist-pool.service.ts` (createWorktreeAndSpawn)

---

## 19. Workspace Activation & Deployment

When a user opens a workspace, Agent Studio "activates" it — deploying agents, skills, and CLAUDE.md:

### Activation flow:
1. **Scan** — Read existing `.claude/` directory status
2. **Deploy agents** — Copy YAML files from master `.claude/agents/` to workspace
3. **Deploy skills** — Copy skill directories from master `.claude/skills/` to workspace
4. **Generate CLAUDE.md** — AI-generate project context (using Sonnet model)
5. **User confirms** — Review and approve the generated CLAUDE.md
6. **Initialize Brain** — Create `.brain/` directory with template files
7. **Feed Brain** — AI-summarize CLAUDE.md and codebase into brain files

### Sync service (`agent-sync.service.ts`):
- `computeDiff()` — Compares master agents/skills vs workspace deployed state
- `applySync()` — Deploys/removes agents and skills based on diff
- `autoSyncNewEntries()` — Auto-imports newly discovered agents/skills
- `createSpecialistFromAgent()` — Creates DB specialist record from YAML definition
- `syncSkillAssignments()` — Links skills to specialists based on YAML `skills:` field

**Key files:** `src/main/services/workspace-deploy.service.ts`, `src/main/services/agent-sync.service.ts`

---

## 20. Ideas System

Ideas are a lightweight brainstorming capture feature:

- Users can create ideas during conversations
- Ideas are stored in SQLite (`idea.repository.ts`)
- Approved ideas are synced into the Brain's `project-state.md` via `syncIdeasToProjectState()`
- Ideas bridge the gap between conversation and implementation

**Key files:** `src/main/db/repositories/idea.repository.ts`, `src/main/ipc/idea.ipc.ts`, `src/main/services/brain.service.ts` (syncIdeasToProjectState)

---

## 21. Mermaid Diagram Generation

Agent Studio renders Mermaid diagrams natively in the chat UI:

### System prompt integration:
- Both Plan and Build mode system prompts instruct agents to use mermaid diagrams
- Supported types: flowchart, sequenceDiagram, classDiagram, stateDiagram, erDiagram, gantt, mindmap, gitgraph

### Mermaid skill:
- `.claude/skills/mermaid-diagrams/SKILL.md` — Comprehensive reference for 23+ diagram types
- Includes references for every diagram type, theming, configuration, and troubleshooting

### Server-side rendering:
- `mermaid.service.ts` renders Mermaid to SVG server-side using the mermaid library + jsdom
- `docs.ipc.ts` exposes `renderMermaid` IPC channel

**Key files:** `src/main/services/mermaid.service.ts`, `.claude/skills/mermaid-diagrams/SKILL.md`

---

## 22. Planned / Not Yet Implemented

These features are referenced in the project plan or skill files but are **not yet built**:

### From the Project Plan:

| Feature | Status | Description |
|---------|--------|-------------|
| **Monaco Diff Viewer** | Planned (Phase 3) | Side-by-side code diff viewer using Monaco Editor |
| **Plan Viewer / Task Board** | Planned (Phase 3) | Drag-and-drop task board with dependency graph visualization |
| **D3.js Dependency Graph** | Planned (Phase 3) | DAG visualization of task dependencies |
| **PR Creation Flow** | Planned (Phase 3) | Automated PR description generation + GitHub integration via Octokit |
| **xterm.js Terminal** | Planned (Phase 2) | Live terminal output from agent processes |
| **File Watcher (chokidar)** | Planned | Watch workspace files for changes, trigger re-analysis |
| **Agent-to-Agent Messaging** | Planned (Phase 2) | Filesystem-based inbox for inter-agent communication |
| **Search Across Conversations** | Planned (Phase 4) | Full-text search across chat history |
| **Export & Reporting** | Planned (Phase 4) | Export conversations as Markdown/PDF |
| **Onboarding Wizard** | Planned (Phase 4) | First-run setup flow |
| **Cloud Infrastructure Panel** | Planned (Phase 4) | View cloud resources from the app |
| **Keyboard Shortcuts / Command Palette** | Planned (Phase 4) | Cmd+K command palette |

### From Skill Files (dotnet-architect):

| Feature | Status | Description |
|---------|--------|-------------|
| **RAG (Retrieval-Augmented Generation)** | Referenced in skills | Document retrieval + embedding comparison for AI context |
| **Vector Search / Embeddings** | Referenced in skills | `Microsoft.Extensions.VectorData.Abstractions` (MEVD) |
| **Pinecone / pgvector** | Not referenced | Could be used for vector storage if RAG is implemented |

### Potential Future Enhancements:

| Feature | Description |
|---------|-------------|
| **Auto Memory (Dream Architecture)** | Claude Code's 4-layer memory system — referenced in user's MEMORY.md as future implementation target |
| **MCP Server Integration** | Model Context Protocol servers for extended tool access — mentioned in agentic-architect skill |
| **Token Budget Management** | Per-workspace token budgets with enforcement — mentioned in project plan |
| **Agent Retry with Backoff** | Auto-retry failed agents with exponential backoff — planned in Phase 2 |
| **Crash Reporting** | Automatic crash reports and session recovery — planned in Phase 4 |

---

## Quick Reference: File Map

| Concept | Key Files |
|---------|-----------|
| Models & constants | `src/shared/constants.ts` |
| Types & interfaces | `src/shared/types.ts` |
| Generalist service | `src/main/services/generalist.service.ts` |
| Generalist prompts | `src/main/services/generalist-prompts.ts` |
| Orchestrator service | `src/main/services/orchestrator.service.ts` |
| System prompts | `src/main/services/system-prompts.ts` |
| Specialist pool | `src/main/services/specialist-pool.service.ts` |
| Agent base class | `src/main/services/agent-base.service.ts` |
| Brain service | `src/main/services/brain.service.ts` |
| Brain feed service | `src/main/services/brain-feed.service.ts` |
| Skill service | `src/main/services/skill.service.ts` |
| Workspace deploy | `src/main/services/workspace-deploy.service.ts` |
| Agent sync | `src/main/services/agent-sync.service.ts` |
| Git worktrees | `src/main/services/git-worktree.service.ts` |
| Agent YAMLs | `.claude/agents/*.yml` (15 files) |
| Skill files | `.claude/skills/*/SKILL.md` (13+ skills) |
| Project plan | `Agent-Studio-Project-Plan.md` |
| CLAUDE.md | `CLAUDE.md` (project root) |
