# Project: Agent Studio

## Overview

Agent Studio is an Electron desktop application that provides an AI-powered team of specialist agents,
coordinated by an intelligent orchestrator, running locally on the developer's machine.
It leverages the Claude Max subscription through Claude CLI, requiring no API keys or proxy servers.

See `Agent-Studio-Project-Plan.md` for full project architecture, milestones, and specs.

## Tech stack

- **Runtime**: Electron 40 (Chromium 144 + Node 24)
- **Frontend**: React 19 + TypeScript 5.9
- **Bundler**: electron-vite 5 (Vite 7 under the hood)
- **Styling**: Tailwind CSS 4
- **Packaging**: electron-builder 26
- **State management**: Zustand 5
- **Database**: better-sqlite3 (local SQLite)
- **Testing**: Jest (unit)
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
│   ├── services/   # Business logic (generalist, orchestrator, specialist-pool, file, brain)
│   └── db/         # SQLite via better-sqlite3 (schema.sql, repositories/)
├── preload/        # contextBridge only (index.ts + index.d.ts)
├── renderer/src/   # React frontend — no Node.js access
│   ├── components/ # By feature: agents/, chat/, common/, layout/, workspace/
│   ├── store/      # Zustand: agent.store, chat.store, workspace.store
│   └── hooks/      # useAutoScroll, useIPC
└── shared/         # Cross-process types (types.ts) + IPC channels (constants.ts)

.claude/
├── agents/         # 16 agent YAMLs (generalist + orchestrator + 14 specialists)
└── skills/         # 17 skill directories (SKILL.md + optional references/)
```

## Skills

### Available skills

| Skill              | Path                                       | Used by agents                                         |
| ------------------ | ------------------------------------------ | ------------------------------------------------------ |
| `electron-pro`     | `.claude/skills/electron-pro/SKILL.md`     | react-architect, electron-architect, cicd-devops       |
| `dotnet-architect` | `.claude/skills/dotnet-architect/SKILL.md` | dotnet-architect                                       |
| `claude-code-cli`  | `.claude/skills/claude-cli/SKILL.md`       | electron-architect, agentic-architect                  |
| `claude-architect` | `.claude/skills/claude-architect/SKILL.md` | agentic-architect                                      |
| `sqlite-patterns`  | `.claude/skills/sqlite-patterns/SKILL.md`  | db-architect                                           |
| `supabase-architect` | `.claude/skills/supabase-architect/SKILL.md` | db-architect (external projects only)               |
| `ui-ux-pro-max`    | `.claude/skills/ui-ux-pro-max/SKILL.md`    | ux-ui-specialist                                       |
| `design`           | `.claude/skills/design/SKILL.md`           | ux-ui-specialist                                       |
| `design-system`    | `.claude/skills/design-system/SKILL.md`    | ux-ui-specialist                                       |
| `brand`            | `.claude/skills/brand/SKILL.md`            | ux-ui-specialist                                       |
| `banner-design`    | `.claude/skills/banner-design/SKILL.md`    | ux-ui-specialist                                       |
| `slides`           | `.claude/skills/slides/SKILL.md`           | ux-ui-specialist                                       |
| `git-workflow`     | `.claude/skills/git-workflow/SKILL.md`     | git-github-specialist                                  |
| `ipc-patterns`     | `.claude/skills/ipc-patterns/SKILL.md`     | react-architect, electron-architect, agentic-architect |
| `mermaid-diagrams` | `.claude/skills/mermaid-diagrams/SKILL.md` | docs-diagrams-specialist                               |
| `design-docs`      | `.claude/skills/design-docs/SKILL.md`      | docs-diagrams-specialist                               |
| `general-dev`      | `.claude/skills/general-dev/SKILL.md`      | generalist-developer                                   |

### Electron skill trigger

When working on ANY Electron/desktop task, ALWAYS read `.claude/skills/electron-pro/SKILL.md` first.
**Trigger terms**: Electron, BrowserWindow, WebContentsView, ipcMain, ipcRenderer, contextBridge,
contextIsolation, nodeIntegration, sandbox, CSP, preload, utilityProcess, Tray, Menu, nativeTheme,
dialog, shell.openExternal, Notification, frameless window, electron-builder, electron-forge, asar,
code signing, notarize, auto-update, electron-updater, electron-vite, electron-rebuild, desktop app,
cross-platform app, system tray, context menu, file dialog.

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

- **Generalist-first**: User ↔ Generalist (always) → Orchestrator (on demand) → Specialists
- **Generalist**: Long-lived Claude CLI session, read-only (`--permission-mode plan`). Detects handoffs.
- **Orchestrator**: Spawned on-demand via `claude -p` per handoff with mode-appropriate permissions.
- **16 agents**: 1 generalist + 1 orchestrator + 14 specialists — YAMLs in `.claude/agents/`, data in DB
- **IPC**: `window.api.invoke()` → preload `ipcRenderer.invoke` → main `ipcMain.handle`
- **Streaming**: `ipcRenderer.on` with cleanup functions from `window.api.on()`
- **Database**: SQLite, schema in `schema.sql`, repository pattern in `repositories/`
- **State**: Zustand stores — one per domain (agent, chat, workspace)
- **Fast mode**: Affects generalist only (long-lived session). Specialists are one-shot `claude -p`.
- **Thinking budgets**: `MAX_THINKING_TOKENS` env var per specialist (Opus=31999, Sonnet=10000, Haiku=0)

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

## Electron documentation

- **API**: https://www.electronjs.org/docs/latest/api/{module-name}
- **Tutorials**: https://www.electronjs.org/docs/latest/tutorial/{topic}
- **Breaking changes**: https://www.electronjs.org/docs/latest/breaking-changes
