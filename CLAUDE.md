# Project: Code Atelier

## Overview

Code Atelier is an Electron desktop application. Each workspace runs exactly one of two equivalent AI roles — **DaVinci** (the default expert partner) or a **Project Specialist** (an LLM-tailored expert built from the workspace's stack and CLAUDE.md). Both roles share the same execution pipeline — same MCP toolbox, same plan/build mode rules, same memory + intent pipelines. Only the identity prompt differs. Everything runs locally via Claude CLI backed by a Claude Max subscription; no API keys, no proxy servers.

## Tech stack

- **Runtime**: Electron 42 (Chromium 148 + Node 24)
- **Frontend**: React 19 + TypeScript 6
- **Bundler**: electron-vite 5 (Vite 7 under the hood)
- **Styling**: Tailwind CSS 4
- **Packaging**: electron-builder 26
- **State management**: Zustand 5
- **Database**: better-sqlite3 (local SQLite)
- **Testing**: tsx test-runner (custom harness, node:assert/strict) + Playwright (E2E)
- **Linting**: ESLint 9 + Prettier

## Conventions

- TypeScript strict mode everywhere
- All IPC channels defined in `src/shared/constants.ts` (`IPC_CHANNELS`) — no magic strings
- Agent IDs defined in `src/shared/constants.ts` (`AGENT_IDS`) — single source of truth
- Never disable `contextIsolation` or enable `nodeIntegration`
- Always use `ipcRenderer.invoke` / `ipcMain.handle` for request-response IPC
- Preload script (`src/preload/index.ts`) is the ONLY bridge — never expose raw `ipcRenderer`
- All file paths use `path.join(__dirname, ...)` — never relative strings
- Renderer imports use `@renderer/` alias (maps to `src/renderer/src/`)
- Use `as const` for constant objects to get literal types

## Project structure

```
src/
├── main/           # Main process (Node.js) — app lifecycle, IPC handlers, services, DB
│   ├── index.ts    # Entry point — window creation, app lifecycle
│   ├── ipc/        # IPC handler registrations (agent, chat, workspace, etc.)
│   ├── services/   # Business logic (role adapters, prompt assembly, MCP config, specialist builder)
│   │   └── role-adapters/ # DaVinciRoleAdapter, ProjectSpecialistRoleAdapter
│   └── db/         # SQLite via better-sqlite3 (schema.sql, repositories/)
│       └── migrations/ # Extracted complex migrations (project-specialist, drop-mcp-columns)
├── preload/        # contextBridge only (index.ts + index.d.ts)
├── renderer/src/   # React frontend — no Node.js access
│   ├── components/ # By feature: agents/, chat/, common/, layout/, workspace/
│   ├── store/      # Zustand: agent.store, chat.store, workspace.store
│   └── hooks/      # useAutoScroll, useIPC
└── shared/         # Cross-process types (types.ts) + IPC channels (constants.ts)

.claude/
└── skills/         # SKILL.md directories (each may include references/)
```

## Skills

### Available skills

| Skill                | Path                                         | Purpose                                                          |
| -------------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| `electron-pro`       | `.claude/skills/electron-pro/SKILL.md`       | Electron 42 IPC, security model, windowing, packaging            |
| `dotnet-architect`   | `.claude/skills/dotnet-architect/SKILL.md`   | .NET solution layout, project conventions, common patterns       |
| `claude-code-cli`    | `.claude/skills/claude-cli/SKILL.md`         | Claude CLI flags, modes, output streams, exit codes              |
| `claude-architect`   | `.claude/skills/claude-architect/SKILL.md`   | High-level Claude integration patterns                           |
| `agent-sdk-patterns` | `.claude/skills/agent-sdk-patterns/SKILL.md` | Claude Agent SDK control flow, MCP server wiring, tool callbacks |
| `sqlite-patterns`    | `.claude/skills/sqlite-patterns/SKILL.md`    | better-sqlite3 schema design, migrations, transactional queries  |
| `supabase-architect` | `.claude/skills/supabase-architect/SKILL.md` | Supabase RLS, edge functions, auth flows (external workspaces)   |
| `ui-ux-pro-max`      | `.claude/skills/ui-ux-pro-max/SKILL.md`      | UX heuristics, interaction design, accessibility checks          |
| `design`             | `.claude/skills/design/SKILL.md`             | Visual hierarchy, typography, color, spacing                     |
| `design-system`      | `.claude/skills/design-system/SKILL.md`      | Token systems, component contracts, theming                      |
| `brand`              | `.claude/skills/brand/SKILL.md`              | Brand voice, identity, tone of voice                             |
| `banner-design`      | `.claude/skills/banner-design/SKILL.md`      | Hero / banner / promo layout patterns                            |
| `slides`             | `.claude/skills/slides/SKILL.md`             | Slide deck structure, narrative arcs, density rules              |
| `git-workflow`       | `.claude/skills/git-workflow/SKILL.md`       | Branching, PR conventions, conventional commits                  |
| `ipc-patterns`       | `.claude/skills/ipc-patterns/SKILL.md`       | Electron IPC contract design, channel naming, error propagation  |
| `mermaid-diagrams`   | `.claude/skills/mermaid-diagrams/SKILL.md`   | Mermaid syntax for architecture, sequence, state diagrams        |
| `design-docs`        | `.claude/skills/design-docs/SKILL.md`        | Design-doc structure, decision records, diagrams-as-code         |
| `general-dev`        | `.claude/skills/general-dev/SKILL.md`        | General software-engineering practices for any stack             |
| `testing-specialist` | `.claude/skills/testing-specialist/SKILL.md` | Test strategy, harness usage, coverage targets                   |
| `planner`            | `.claude/skills/planner/SKILL.md`            | Plan-mode framing, breakdown patterns, scoping discipline        |
| `security`           | `.claude/skills/security/SKILL.md`           | Threat modeling, secret handling, supply-chain hygiene           |
| `infrastructure`     | `.claude/skills/infrastructure/SKILL.md`     | Containerization, Terraform, CI/CD, deployment topology          |
| `coding-discipline`  | `.claude/skills/coding-discipline/SKILL.md`  | Always-on coding principles: think first, simplicity, surgical changes |

### Electron skill trigger

When working on ANY Electron/desktop task, ALWAYS read `.claude/skills/electron-pro/SKILL.md` first.
**Trigger terms**: Electron, BrowserWindow, WebContentsView, ipcMain, ipcRenderer, contextBridge,
contextIsolation, nodeIntegration, sandbox, CSP, preload, utilityProcess, Tray, Menu, nativeTheme,
dialog, shell.openExternal, Notification, frameless window, electron-builder, electron-forge, asar,
code signing, notarize, auto-update, electron-updater, electron-vite, electron-rebuild, desktop app,
cross-platform app, system tray, context menu, file dialog.

## Design System — Code Atelier Brand

All UI work follows the **Code Atelier** brand system. Full spec: `docs/CodeAtelier/Code-Atelier-Brand-System.md`.
Detailed implementation rules are in the UX/UI specialist agent (`.claude/agents/ux-ui-specialist.yml`).
PR checklist: `docs/CodeAtelier/design-checklist.md`.

## What NOT to do

- Do not use `require()` in renderer — use preload + contextBridge
- Do not use `remote` module (removed in Electron 14)
- Do not use `ipcRenderer.sendSync()` — blocks renderer
- Do not expose raw `ipcRenderer.send` or `ipcRenderer.on` via contextBridge
- Do not use `shell.openExternal()` with unvalidated URLs
- Do not bundle `node_modules` into renderer — electron-vite handles this

## Key commands

```bash
npm run dev           # Development mode with HMR
npm run dev:restart   # Kill existing processes and restart dev
npm run build         # Typecheck + production build
npm run build:mac     # Package for macOS
npm run build:win     # Package for Windows
npm run build:linux   # Package for Linux
npm run typecheck     # TypeScript type checking
npm run lint          # ESLint
npm run format        # Prettier
```

> **Restart convention:** "restart the app" → always `npm run dev:restart`

## Architecture notes

- **Two role adapters, one execution pipeline**
  - `DaVinciRoleAdapter` — default per workspace, long-lived AgentSession.
  - `ProjectSpecialistRoleAdapter` — bound to one workspace, LLM-tailored system prompt.
  - Both share `buildWorkspaceMcpConfig`, `intentDetector.detectAll`, `memoryRepository`, `prompt-assembly-helpers`.
- **Two executor backends: CLI (Claude Max subscription) and OpenCode (local LLMs via Ollama/oMLX).** `ExecutorBackend = 'cli' | 'opencode'`.
- **No handoffs, no orchestrator, no sub-agents.** `Agent` and `ToolSearch` tools are blocked globally.
- **Tool execution runs unattended in build mode** (`permissionMode: 'bypassPermissions'`). Safety relies on the workspace scope guard + `disallowedTools` (Agent, ToolSearch, ExitPlanMode, AskUserQuestion). No in-app permission popup.
- **IPC**: `window.api.invoke()` → preload `ipcRenderer.invoke` → main `ipcMain.handle`.
- **Streaming**: `ipcRenderer.on` with cleanup functions from `window.api.on()`.
- **Database**: SQLite, `schema.sql`, 72 versioned migrations, repository pattern.
- **State**: Zustand stores, one per domain.
- **MCP toolbox** (workspace-scoped, flag-gated): code-graph, semantic-search, git-context, checkpoint-context, github-context, control-actions.

## Error handling patterns

- **IPC handlers**: `validateSender(event)` first, then validate inputs, `throw new Error()`
- **Streaming**: Error chunk via `CHAT_MESSAGE_CHUNK`, then ALWAYS `CHAT_MESSAGE_COMPLETE`
- **Services**: try-catch + `log.error()`, emit error events, status → 'failed'
- **Processes**: Handle both 'error' and 'exit', flush NDJSON buffer, SIGTERM → 5s → SIGKILL
- **DB**: try-catch, log.error, send error chunk to renderer
- **Always send messageComplete** — even on error, UI depends on it

## Deprecation notes

- `AGENT_IDS` and `AGENT_META` in `src/shared/constants.ts` — `@deprecated`, use DB specialists
- Do not add new references to these deprecated constants
- `specialists.mcp_config` / `specialists.mcp_overrides` — dropped in schema v72. MCP availability is workspace-scoped now (`workspace.settingsJson` flags).
- `@anthropic-ai/claude-agent-sdk` — removed entirely. All execution goes through CLI or OpenCode.
- `Agent` tool — blocked globally; the architecture no longer delegates.

## Electron documentation

- **API**: https://www.electronjs.org/docs/latest/api/{module-name}
- **Tutorials**: https://www.electronjs.org/docs/latest/tutorial/{topic}
- **Breaking changes**: https://www.electronjs.org/docs/latest/breaking-changes
