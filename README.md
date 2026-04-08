# Agent Studio

> AI-Powered Development Team — running locally on your machine.

Agent Studio is a desktop application that transforms software development by providing a coordinated team of specialist AI agents, orchestrated intelligently, all running locally through your Claude Max subscription via Claude CLI. No API keys. No proxy servers. Just your machine.

## How It Works

```mermaid
flowchart LR
    You([You]) <-->|chat| G["🎨 Da Vinci<br/>(Generalist)"]
    G -->|handoff| O["🎼 Stravinsky<br/>(Orchestrator)"]
    O -->|spawn| S1["⚛️ React Architect"]
    O -->|spawn| S2["⚡ Electron Architect"]
    O -->|spawn| S3["🗄️ DB Architect"]
    O -->|spawn| S4["... +11 more"]

    style G fill:#7c3aed,color:#fff,stroke:#7c3aed
    style O fill:#f59e0b,color:#fff,stroke:#f59e0b
    style S1 fill:#3b82f6,color:#fff,stroke:#3b82f6
    style S2 fill:#3b82f6,color:#fff,stroke:#3b82f6
    style S3 fill:#3b82f6,color:#fff,stroke:#3b82f6
    style S4 fill:#64748b,color:#fff,stroke:#64748b
```

1. **Chat with the Generalist** — a long-lived Claude CLI session that understands your entire codebase
2. **Automatic handoffs** — when a task requires specialized skills, the Generalist delegates to the Orchestrator
3. **Parallel specialists** — the Orchestrator spawns the right specialist agents to work simultaneously

## Agent Team

| Icon | Agent                   | Alias          | Role                                                                    |
| ---- | ----------------------- | -------------- | ----------------------------------------------------------------------- |
| 🎨   | **Generalist**          | **Da Vinci**   | Always-on assistant, read-only codebase analysis, detects handoffs      |
| 🎼   | **Orchestrator**        | **Stravinsky** | Spawned on-demand, coordinates specialists with appropriate permissions |
| ⚛️   | React Architect         |                | Frontend architecture, components, state management                     |
| ⚡   | Electron Architect      |                | Desktop app patterns, IPC, native integration                           |
| 🤖   | Agentic Architect       |                | AI agent design, Claude CLI integration                                 |
| 🟣   | .NET Architect          |                | Backend services, API design                                            |
| 🗄️   | DB Architect            |                | SQLite patterns, schema design, migrations                              |
| 🎨   | UX/UI Specialist        |                | Design system, accessibility, user experience                           |
| 🔀   | Git/GitHub Specialist   |                | Branching, PRs, workflow automation                                     |
| 🚀   | CI/CD DevOps            |                | Build pipelines, packaging, distribution                                |
| ☁️   | Cloud Infrastructure    |                | Deployment, hosting, infrastructure                                     |
| 📝   | Code Planner            |                | Task decomposition, implementation strategy                             |
| 📅   | Execution Planner       |                | Sequencing, dependency resolution                                       |
| 📋   | Requirements Specialist |                | Specification, acceptance criteria                                      |
| 📐   | Docs & Diagrams         |                | Documentation, Mermaid diagrams, design docs                            |
| 🛠️   | Generalist Developer    |                | Full-stack implementation, broad coverage                               |

## Tech Stack

- **Runtime**: Electron 40 (Chromium 144 + Node 24)
- **Frontend**: React 19 + TypeScript 5.9
- **Bundler**: electron-vite 5 (Vite 7)
- **Styling**: Tailwind CSS 4
- **State**: Zustand 5
- **Database**: better-sqlite3 (local SQLite)
- **Packaging**: electron-builder 26
- **Linting**: ESLint 9 + Prettier

## Prerequisites

- [Node.js](https://nodejs.org/) 24+
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) installed and authenticated
- [Claude Max subscription](https://www.anthropic.com/pricing) (provides the underlying AI)

## Getting Started

### Install dependencies

```bash
npm install
```

### Run in development mode

```bash
npm run dev
```

This starts the app with hot module replacement. To kill existing processes and restart cleanly:

```bash
npm run dev:restart
```

### Build for production

```bash
# macOS
npm run build:mac

# Windows
npm run build:win

# Linux
npm run build:linux
```

### Other commands

```bash
npm run typecheck    # TypeScript type checking
npm run lint         # ESLint
npm run format       # Prettier formatting
```

## Project Structure

```
src/
├── main/              # Main process (Node.js)
│   ├── index.ts       # App lifecycle, window creation
│   ├── ipc/           # IPC handler modules (20+ domains)
│   ├── services/      # Business logic (orchestrator, specialist pool, brain)
│   └── db/            # SQLite database (schema, repositories)
├── preload/           # Secure bridge (contextBridge only)
├── renderer/src/      # React frontend (no Node.js access)
│   ├── components/    # Feature-based: agents/, chat/, welcome/, settings/, workspace/
│   ├── store/         # Zustand stores (agent, chat, workspace, etc.)
│   └── hooks/         # Custom hooks (useAutoScroll, useVoiceInput)
└── shared/            # Cross-process types + IPC channel constants

.claude/
├── agents/            # 16 agent YAML definitions
└── skills/            # 17 skill modules (SKILL.md + references/)
```

## Architecture

### IPC Communication

All communication between the renderer (UI) and main (Node.js) process goes through a typed IPC layer:

```mermaid
sequenceDiagram
    participant R as Renderer (React)
    participant P as Preload (Bridge)
    participant M as Main Process (Node.js)

    Note over R,M: Request / Response
    R->>P: window.api.invoke(channel, data)
    P->>M: ipcRenderer.invoke(channel, data)
    M-->>P: return result
    P-->>R: return result

    Note over R,M: Streaming (e.g. chat messages)
    M-)P: webContents.send(channel, chunk)
    P-)R: ipcRenderer.on(channel, callback)
```

- Channels defined in `src/shared/constants.ts` — no magic strings
- Preload is the **only** bridge — `contextIsolation` is always enabled
- Request-response via `invoke`/`handle`; streaming via event listeners

### Agent Execution Model

```mermaid
flowchart TD
    User([User message]) --> G

    subgraph Always On
        G["🎨 Da Vinci (Generalist)<br/><i>long-lived claude session</i><br/>read-only · plan mode"]
    end

    G -->|detects handoff| O

    subgraph On Demand
        O["🎼 Stravinsky (Orchestrator)<br/><i>claude -p per handoff</i><br/>mode-appropriate permissions"]
    end

    O -->|spawns| pool

    subgraph pool [Specialist Pool — parallel]
        S1["⚛️ React Architect<br/>Opus · 31,999 think tokens"]
        S2["🗄️ DB Architect<br/>Sonnet · 10,000 think tokens"]
        S3["🎨 UX/UI Specialist<br/>Haiku · 0 think tokens"]
    end

    S1 -->|result| O
    S2 -->|result| O
    S3 -->|result| O
    O -->|aggregated response| G
    G -->|reply| User

    style G fill:#7c3aed,color:#fff,stroke:#7c3aed
    style O fill:#f59e0b,color:#fff,stroke:#f59e0b
    style S1 fill:#3b82f6,color:#fff,stroke:#3b82f6
    style S2 fill:#3b82f6,color:#fff,stroke:#3b82f6
    style S3 fill:#3b82f6,color:#fff,stroke:#3b82f6
```

- **Generalist**: Long-lived `claude` CLI session in `--permission-mode plan` (read-only)
- **Orchestrator**: Spawned per handoff via `claude -p` with mode-appropriate permissions
- **Specialists**: One-shot `claude -p` commands, run in parallel
- **Thinking budgets**: Opus = 31,999 tokens, Sonnet = 10,000, Haiku = 0

### Electron Process Model

```mermaid
flowchart LR
    subgraph Electron
        direction TB
        Main["Main Process<br/>(Node.js)"]
        Preload["Preload Script<br/>(contextBridge)"]
        Renderer["Renderer Process<br/>(React + Zustand)"]
    end

    subgraph Storage
        DB[(SQLite<br/>better-sqlite3)]
    end

    subgraph External
        CLI["Claude CLI<br/>(child_process)"]
    end

    Renderer <-->|IPC| Preload
    Preload <-->|IPC| Main
    Main <--> DB
    Main <-->|spawn / stdin·stdout| CLI

    style Renderer fill:#3b82f6,color:#fff,stroke:#3b82f6
    style Preload fill:#8b5cf6,color:#fff,stroke:#8b5cf6
    style Main fill:#059669,color:#fff,stroke:#059669
    style DB fill:#d97706,color:#fff,stroke:#d97706
    style CLI fill:#dc2626,color:#fff,stroke:#dc2626
```

### Database

Local SQLite via better-sqlite3 with a repository pattern. Schema defined in `src/main/db/schema.sql`, inline migrations in `src/main/db/index.ts`.

## IDE Setup

- [VS Code](https://code.visualstudio.com/) with [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)
- TypeScript strict mode is enforced project-wide
- Import alias `@renderer/` maps to `src/renderer/src/`

## License

Proprietary. All rights reserved.
