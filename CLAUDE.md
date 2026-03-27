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
- Preload script (`src/preload/index.ts`) is the ONLY bridge between main and renderer — never expose raw `ipcRenderer`
- All file paths use `path.join(__dirname, ...)` — never relative strings
- Renderer imports use `@renderer/` alias (maps to `src/renderer/src/`)
- Use `as const` for constant objects to get literal types

## Project structure

```
AgentStudio/
├── CLAUDE.md                     ← Project context (always loaded)
├── skills/                       ← Runtime-managed skills (DB-backed import/export)
│   └── electron-pro.md           ← Electron skill file (runtime copy)
├── .claude/
│   ├── agents/                   ← Agent YAML definitions (Claude Code native)
│   │   ├── generalist-agent.yml  ← Default entry point for all conversations
│   │   ├── orchestrator.yml
│   │   ├── react-architect.yml
│   │   ├── dotnet-architect.yml
│   │   ├── electron-architect.yml ← Electron app architecture specialist
│   │   ├── agentic-architect.yml
│   │   ├── db-architect.yml      ← Database specialist (SQLite for this project)
│   │   ├── ux-ui-specialist.yml
│   │   ├── git-github-specialist.yml
│   │   ├── requirements-specialist.yml
│   │   ├── code-planner.yml
│   │   ├── execution-planner.yml
│   │   ├── cicd-devops.yml
│   │   ├── cloud-infrastructure.yml
│   │   └── docs-diagrams-specialist.yml ← Documentation & Mermaid diagrams specialist
│   └── skills/                   ← Claude Code native skill discovery
│       ├── electron-pro/
│       │   └── SKILL.md          ← Electron skill (846 lines + references)
│       ├── dotnet-architect/
│       │   ├── SKILL.md          ← .NET/C# architecture skill
│       │   └── references/       ← EF Core, MSBuild, performance, testing
│       ├── claude-cli/
│       │   └── SKILL.md          ← Claude Code CLI integration skill
│       ├── mermaid-diagrams/
│       │   ├── SKILL.md          ← Mermaid diagram generation (23 types + references)
│       │   └── references/       ← Syntax docs per diagram type, theming, troubleshooting
│       └── design-docs/
│           ├── SKILL.md          ← Design document templates & code-to-diagram workflows
│           └── references/       ← Templates (5) + guides (6)
├── Agent-Studio-Project-Plan.md  ← Full project plan and specs
├── electron-builder.yml          ← Packaging configuration
├── electron.vite.config.ts       ← Vite config for main/preload/renderer
├── src/
│   ├── main/                     # Main process (Node.js)
│   │   ├── index.ts              # Entry point — app lifecycle, window creation
│   │   ├── ipc/                  # IPC handler registrations
│   │   │   ├── index.ts          # Barrel export for all IPC handlers
│   │   │   ├── agent.ipc.ts      # Agent status IPC handlers
│   │   │   ├── chat.ipc.ts       # Chat/conversation IPC handlers
│   │   │   └── workspace.ipc.ts  # Workspace management IPC handlers
│   │   ├── services/             # Business logic
│   │   │   ├── agent-base.service.ts        # Shared base class for agent services
│   │   │   ├── generalist.service.ts        # Generalist (default entry point, long-lived)
│   │   │   ├── generalist-prompts.ts        # Generalist system prompt
│   │   │   ├── orchestrator.service.ts      # Orchestrator (on-demand, per-handoff)
│   │   │   ├── system-prompts.ts            # Orchestrator mode system prompts
│   │   │   └── file.service.ts              # File system operations
│   │   └── db/                   # Database layer
│   │       ├── index.ts          # Database initialization
│   │       ├── schema.sql        # SQLite schema
│   │       └── repositories/     # Data access layer
│   ├── preload/                  # Preload scripts — contextBridge only
│   │   ├── index.ts              # exposeInMainWorld('api', ...) + electronAPI
│   │   └── index.d.ts            # Type declarations for renderer access
│   ├── renderer/                 # Frontend code (React) — no Node.js access
│   │   └── src/
│   │       ├── App.tsx           # Root component with routing
│   │       ├── main.tsx          # React entry point
│   │       ├── components/       # UI components (by feature)
│   │       │   ├── agents/       # Agent status & panels
│   │       │   ├── chat/         # Chat interface
│   │       │   ├── common/       # Shared UI components
│   │       │   ├── layout/       # App layout components
│   │       │   └── workspace/    # Workspace management
│   │       ├── hooks/            # Custom React hooks
│   │       │   ├── useAutoScroll.ts
│   │       │   └── useIPC.ts     # IPC communication hook
│   │       ├── store/            # Zustand stores
│   │       │   ├── agent.store.ts
│   │       │   ├── chat.store.ts
│   │       │   └── workspace.store.ts
│   │       ├── types/            # Renderer-specific types
│   │       └── assets/           # Static assets
│   └── shared/                   # Types & constants shared across processes
│       ├── constants.ts          # IPC_CHANNELS, AGENT_IDS, AGENT_META
│       └── types.ts              # Shared TypeScript interfaces
├── resources/                    # App icons, platform-specific assets
├── build/                        # Build resources (entitlements, etc.)
└── package.json
```

## Skills

### Available skills

| Skill              | Path                                       | Used by agents                                         |
| ------------------ | ------------------------------------------ | ------------------------------------------------------ |
| `electron-pro`     | `.claude/skills/electron-pro/SKILL.md`     | react-architect, electron-architect, cicd-devops       |
| `dotnet-architect` | `.claude/skills/dotnet-architect/SKILL.md` | dotnet-architect                                       |
| `claude-code-cli`  | `.claude/skills/claude-cli/SKILL.md`       | electron-architect, agentic-architect                  |
| `sqlite-patterns`  | `.claude/skills/sqlite-patterns/SKILL.md`  | db-architect                                           |
| `ui-ux-pro-max`    | `.claude/skills/ui-ux-pro-max/SKILL.md`    | ux-ui-specialist                                       |
| `ui-styling`       | `.claude/skills/ui-styling/SKILL.md`       | ux-ui-specialist                                       |
| `design-system`    | `.claude/skills/design-system/SKILL.md`    | ux-ui-specialist                                       |
| `brand`            | `.claude/skills/brand/SKILL.md`            | ux-ui-specialist                                       |
| `git-workflow`     | `.claude/skills/git-workflow/SKILL.md`     | git-github-specialist                                  |
| `ipc-patterns`     | `.claude/skills/ipc-patterns/SKILL.md`     | react-architect, electron-architect, agentic-architect |
| `mermaid-diagrams` | `.claude/skills/mermaid-diagrams/SKILL.md` | docs-diagrams-specialist                               |
| `design-docs`      | `.claude/skills/design-docs/SKILL.md`      | docs-diagrams-specialist                               |
| `general-dev`      | `.claude/skills/general-dev/SKILL.md`      | generalist-developer                                   |

### Electron skill trigger

When working on ANY task involving Electron or desktop application development — including
but not limited to any of the following terms, APIs, or concepts — ALWAYS read
`.claude/skills/electron-pro/SKILL.md` first and follow its instructions before writing any code:

**Core APIs**: Electron, BrowserWindow, WebContentsView, webContents, app.whenReady, app.on,
app.quit, session, protocol, powerMonitor, globalShortcut, screen

**IPC and bridge**: ipcMain, ipcRenderer, contextBridge, exposeInMainWorld, invoke, handle,
MessagePort, MessageChannelMain, postMessage

**Security**: contextIsolation, nodeIntegration, sandbox, webSecurity, Content-Security-Policy,
CSP, safeStorage, setPermissionRequestHandler, Electron Fuses, will-navigate, setWindowOpenHandler,
certificate pinning

**Preload and processes**: preload script, main process, renderer process, utilityProcess,
process.platform, process.arch, child_process in Electron

**Native OS integration**: Tray, Menu, nativeTheme, dialog, shell.openExternal, Notification,
systemPreferences, nativeImage, TouchBar, dock, taskbar, file associations, protocol handler,
deep link, drag and drop, clipboard, powerSaveBlocker

**Window management**: frameless window, BrowserWindow options, kiosk mode, always on top,
splash screen, window state persistence, multi-window, modal, parent/child windows,
fullscreen, webPreferences

**Packaging and distribution**: electron-builder, electron-forge, asar, ASAR integrity,
code signing, notarize, notarization, DMG, NSIS, AppImage, deb, rpm, Squirrel,
auto-update, electron-updater, autoUpdater, installer, publish

**Build and tooling**: electron-rebuild, electron-vite, @electron/fuses, electron-log,
electron-store, electron-devtools-installer, Electron Fiddle, DevTools, --inspect

**Common task descriptions**: desktop app, cross-platform app, native module, system tray icon,
context menu, file dialog, save dialog, open dialog, app icon, about panel, crash report,
GPU acceleration, background throttling, startup performance, ESM in Electron

## What NOT to do

- Do not use `require()` in the renderer process — use the preload + contextBridge pattern
- Do not use `remote` module — it was removed in Electron 14
- Do not use `ipcRenderer.sendSync()` — it blocks the renderer
- Do not expose raw `ipcRenderer.send` or `ipcRenderer.on` via contextBridge
- Do not use `shell.openExternal()` with unvalidated URLs
- Do not bundle `node_modules` into the renderer — electron-vite handles this

## Key commands

```bash
npm run dev           # Start in development mode with HMR
npm run dev:restart   # Kill existing Electron/Vite processes and restart dev mode
npm run build         # Typecheck + build for production
npm run build:mac     # Build + package for macOS
npm run build:win     # Build + package for Windows
npm run build:linux   # Build + package for Linux
npm run typecheck     # Run TypeScript type checking (node + web)
npm run lint          # Run ESLint
npm run format        # Run Prettier
```

> **Restart convention:** When asked to "restart the app", always run `npm run dev:restart` — it kills any existing Electron/Vite PIDs before starting fresh.

## Architecture notes

- **Generalist-first architecture**: User <-> Generalist (always) -> Orchestrator (on demand) -> Specialists
- **Generalist**: Long-lived interactive Claude CLI session, always read-only (`--permission-mode plan`). Handles chat, brainstorming, code review. Detects inflection points and hands off to orchestrator via structured handoff blocks.
- **Orchestrator**: Spawned on-demand when generalist detects implementation work. Uses `claude -p` per handoff with mode-appropriate permissions.
- **16 agents** (1 generalist entry point + 1 orchestrator + 14 specialists) — agent YAMLs in `.claude/agents/`, specialist data in DB
- **IPC pattern**: Renderer calls `window.api.invoke(channel, ...args)` -> preload forwards via `ipcRenderer.invoke` -> main handles via `ipcMain.handle`
- **Streaming**: Chat messages stream via `ipcRenderer.on` with cleanup functions returned by `window.api.on()`
- **Database**: SQLite via `better-sqlite3`, schema in `src/main/db/schema.sql`, repositories in `src/main/db/repositories/`
- **State**: Zustand stores in `src/renderer/src/store/` — one per domain (agent, chat, workspace)
- **Git integration**: `simple-git` library for Git operations in the main process
- **Fast mode**: User-facing preference in workspace settings. Only affects the generalist (long-lived Claude CLI session). Specialist agents (`claude -p` one-shot processes) are NOT sessions and operate independently of fast mode. Rate limit fallback is detected in GeneralistService stderr handler and surfaced as a status notification.
- **Extended thinking budgets**: `MAX_THINKING_TOKENS` env var set per specialist process based on model tier (Opus=31999, Sonnet=10000, Haiku=0). Defined in `THINKING_BUDGETS` constant in `src/shared/constants.ts`.

## Error handling patterns

- **IPC handlers**: `validateSender(event)` first, then manual input validation with `throw new Error()`
- **Streaming errors**: Send error chunk via `CHAT_MESSAGE_CHUNK`, then always send `CHAT_MESSAGE_COMPLETE`
- **Service errors**: try-catch with `log.error()`, emit error events, update status to 'failed'
- **Process errors**: Handle both 'error' and 'exit' events, flush NDJSON buffer on exit
- **Graceful shutdown**: SIGTERM → 5s timeout → SIGKILL → clear process reference
- **DB errors**: try-catch around operations, log.error and send error chunk to renderer
- **Always send messageComplete**: Even on error — the UI needs it to exit loading state

## Deprecation notes

- `AGENT_IDS` in `src/shared/constants.ts` — `@deprecated`, use DB specialists instead
- `AGENT_META` in `src/shared/constants.ts` — `@deprecated`, use DB specialists instead
- Do not add new references to these deprecated constants

## Electron documentation reference

When debugging Electron-specific issues or implementing new features, consult the official docs:

- **API reference**: https://www.electronjs.org/docs/latest/api/{module-name}
- **Tutorials**: https://www.electronjs.org/docs/latest/tutorial/{topic}
- **Breaking changes**: https://www.electronjs.org/docs/latest/breaking-changes
- **Blog**: https://www.electronjs.org/blog
- **GitHub issues**: https://github.com/electron/electron/issues
