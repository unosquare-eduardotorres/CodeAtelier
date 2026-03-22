# Agent Studio — Project Plan

**AI-Powered Software Development Desktop Application**
Orchestrator + 11 Specialist Agents | Electron + React + Claude CLI

**Version:** 1.0
**Date:** March 2026
**Classification:** Confidential

---

## Table of Contents

- [1. Executive Summary](#1-executive-summary)
- [2. System Architecture](#2-system-architecture)
  - [2.1 Architecture Overview](#21-architecture-overview)
  - [2.2 Technology Stack Detail](#22-technology-stack-detail)
  - [2.3 Data Flow Architecture](#23-data-flow-architecture)
- [3. Agent System Design](#3-agent-system-design)
  - [3.1 Orchestrator Agent (Coordinator)](#31-orchestrator-agent-coordinator)
  - [3.2 Specialist Agent Definitions](#32-specialist-agent-definitions)
  - [3.3 Agent Interaction Patterns](#33-agent-interaction-patterns)
- [4. UI/UX Design](#4-uiux-design)
  - [4.1 Main Layout](#41-main-layout)
  - [4.2 Key UI Workflows](#42-key-ui-workflows)
- [5. Data Model](#5-data-model)
  - [5.1 Core Tables](#51-core-tables)
- [6. Implementation Phases](#6-implementation-phases)
  - [6.1 Phase 1: Foundation (Weeks 1–3)](#61-phase-1-foundation-weeks-13)
  - [6.2 Phase 2: Agent Pool (Weeks 4–6)](#62-phase-2-agent-pool-weeks-46)
  - [6.3 Phase 3: Planning and Review (Weeks 7–10)](#63-phase-3-planning-and-review-weeks-710)
  - [6.4 Phase 4: Polish and Advanced Features (Weeks 11–14)](#64-phase-4-polish-and-advanced-features-weeks-1114)
- [7. Project Structure](#7-project-structure)
- [8. Agent Definition Examples](#8-agent-definition-examples)
  - [8.1 Orchestrator Agent](#81-orchestrator-agent)
  - [8.2 React Architect Agent](#82-react-architect-agent)
- [9. Risk Assessment and Mitigations](#9-risk-assessment-and-mitigations)
- [10. Prerequisites and Setup](#10-prerequisites-and-setup)
  - [10.1 System Requirements](#101-system-requirements)
  - [10.2 Initial Setup Steps](#102-initial-setup-steps)
- [11. Success Metrics](#11-success-metrics)
- [12. Next Steps](#12-next-steps)

---

## 1. Executive Summary

Agent Studio is a desktop application that transforms software development by providing an AI-powered team of specialist agents, coordinated by an intelligent orchestrator, running locally on the developer's machine. It leverages the Claude Max subscription through Claude CLI, requiring no API keys or proxy servers.

The application enables developers to chat with a coordinator agent that understands their entire codebase, delegate tasks to 11 specialist agents running in parallel, generate comprehensive execution plans, review and approve code changes with visual diffs, and manage the full Git workflow including branch creation and pull requests — all from a single unified interface.

**Key Value Proposition:**

- **Local-first:** Runs on your desktop, accesses your filesystem and Git repos directly
- **No proxy/API key:** Uses Claude Max subscription via Claude CLI authentication
- **11 specialist agents** covering the full software development lifecycle
- **Real-time agent monitoring** with task tracking and execution plans
- **Full Git integration:** branching, commits, PRs, and diff visualization
- **Multi-workspace support** for managing multiple projects

---

## 2. System Architecture

Agent Studio follows a layered architecture with four principal tiers: the Electron desktop shell, the React UI layer, the Node.js backend services, and the Claude CLI agent pool. Communication between layers uses Electron IPC (UI to backend) and child process stdio streams (backend to agents).

### 2.1 Architecture Overview

| Layer | Technology | Responsibility |
|-------|-----------|----------------|
| Presentation | React 18 + TypeScript | All UI panels, state management, user interactions |
| Desktop Shell | Electron 30+ | Window management, native menus, filesystem access, IPC bridge |
| Backend Services | Node.js (Electron main process) | Agent lifecycle management, Git operations, file services, task tracking |
| Agent Pool | Claude CLI (child processes) | 11 specialist agents + 1 orchestrator, each as isolated Claude Code sessions |
| Persistence | SQLite + filesystem | Workspaces, tasks, chat history, execution plans, agent logs |

### 2.2 Technology Stack Detail

#### 2.2.1 Frontend

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Framework | React 18 + TypeScript | Component model, ecosystem, type safety |
| State Management | Zustand | Lightweight, no boilerplate, supports slices for complex state |
| Diff Viewer | Monaco Editor (via @monaco-editor/react) | Same engine as VS Code; native diff view, syntax highlighting for 50+ languages |
| Styling | Tailwind CSS | Utility-first, rapid prototyping, consistent design tokens |
| Terminal Emulation | xterm.js | Display real-time agent CLI output streams |
| Drag-and-Drop | react-dropzone | File attachments (docs, images, PDFs) |
| Markdown Rendering | react-markdown + remark-gfm | Render agent responses with code blocks, tables, links |
| Task Board | Custom + dnd-kit | Draggable task cards for execution plans |
| Icons | Lucide React | Consistent, lightweight icon set |
| Routing | React Router v6 | Workspace-level navigation |

#### 2.2.2 Backend (Electron Main Process)

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Node.js 20+ (Electron bundled) | Native child_process for agent spawning |
| Database | better-sqlite3 | Synchronous, fast, no server needed, great Electron support |
| Git Operations | simple-git | Programmatic Git: clone, branch, commit, diff, worktree management |
| GitHub Integration | octokit/rest | PR creation, repo management via GitHub API |
| File Parsing | mammoth (docx), pdf-parse (PDF), xlsx (Excel), sharp (images) | Extract text from attached files for agent context injection |
| Process Management | Custom AgentProcessManager | Spawn, monitor, communicate with, and terminate Claude CLI processes |
| IPC Protocol | Electron ipcMain/ipcRenderer | Typed, bidirectional communication between UI and backend |
| File Watcher | chokidar | Watch workspace files for changes, trigger re-analysis |

#### 2.2.3 Agent Infrastructure

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Agent Runtime | Claude CLI (claude command) | Native Claude Code process, full tool access, authenticated via Max subscription |
| Agent Definitions | .claude/agents/ YAML files | Declarative agent configuration with system prompts, tool permissions, and skills |
| Isolation | Git worktrees | Each agent operates in its own worktree to prevent file conflicts |
| Inter-Agent Comms | Filesystem-based message passing | Agents write to shared inbox directories; orchestrator reads and routes |
| Auth | claude login (OAuth) | One-time login, session persists across all spawned agents |

### 2.3 Data Flow Architecture

The following describes how data flows through the system for a typical user interaction:

1. **User Input:** User types a message in the Chat Panel or selects an action from the Plan Viewer.
2. **IPC Transport:** Message is sent via Electron IPC from the React renderer process to the Node.js main process.
3. **Orchestrator Analysis:** The Orchestrator Service (a persistent Claude CLI session) receives the message, analyzes it, and produces a delegation plan as structured JSON.
4. **Agent Spawning:** The Agent Process Manager spawns the required specialist agents as child processes, each in its own Git worktree, with the appropriate sub-question injected.
5. **Parallel Execution:** Specialists work concurrently. Their stdout streams are captured and forwarded in real-time to the Agent Monitor panel via IPC.
6. **Result Collection:** As each agent completes, its output is collected by the Process Manager and stored in the Task Tracker (SQLite).
7. **Synthesis:** The Orchestrator receives all specialist outputs and produces a synthesized response, including any code changes, plan updates, or recommendations.
8. **UI Update:** The synthesized response is sent back to the Chat Panel. Code changes appear in the Diff Viewer. Task statuses update in the Plan Viewer. Agent statuses update in the Agent Monitor.
9. **Git Capture:** All code modifications are tracked in the worktree. The user can review diffs, approve changes, create a branch, and open a PR from the Git Panel.

---

## 3. Agent System Design

The agent system consists of one Orchestrator (Coordinator) agent and 11 Specialist agents. Each specialist is defined as a YAML file in the `.claude/agents/` directory with a focused system prompt, specific tool permissions, and optional skill references.

### 3.1 Orchestrator Agent (Coordinator)

The Orchestrator is the central intelligence of the system. It maintains a persistent session, receives all user messages, and decides which specialists to engage. It never writes code directly — it delegates, coordinates, and synthesizes.

**Orchestrator Responsibilities:**

- Analyze user intent and break complex requests into specialist-sized subtasks
- Select the minimum set of specialists needed (not all 11 for every request)
- Write focused sub-questions tailored to each specialist's domain
- Manage task dependencies (e.g., Requirements before Code Planner before Execution Planner)
- Synthesize specialist outputs into coherent, unified recommendations
- Resolve contradictions between specialist recommendations
- Maintain conversation context across the full chat session
- Produce structured execution plans when requested

### 3.2 Specialist Agent Definitions

Each specialist agent has a unique focus area, system prompt, and set of permitted tools. Below is the complete specification for all 11 agents:

#### 3.2.1 React Frontend Architect

| Attribute | Value |
|-----------|-------|
| **Agent ID** | `react-architect` |
| **Icon / Color** | ⚛️ Cyan (#61DAFB) |
| **Domain** | Frontend architecture, React ecosystem, component design, state management |
| **System Prompt Focus** | Component architecture patterns (atomic design, compound components), state management strategy (Zustand, Redux, React Query), routing patterns (Next.js App Router, React Router), performance optimization (code splitting, lazy loading, memoization, React Compiler), accessibility (WCAG 2.1 AA), design system integration, micro-frontend patterns, testing strategy (Vitest, Testing Library, Playwright) |
| **Permitted Tools** | Read files, write files, execute bash (npm, build tools), search codebase |
| **Skills** | frontend-conventions, react-patterns, accessibility-standards |

#### 3.2.2 .NET Backend Architect

| Attribute | Value |
|-----------|-------|
| **Agent ID** | `dotnet-architect` |
| **Icon / Color** | 🟣 Purple (#512BD4) |
| **Domain** | .NET/C# backend, API design, middleware, microservices |
| **System Prompt Focus** | Clean Architecture / Vertical Slice patterns, ASP.NET Core middleware pipeline, Entity Framework Core (migrations, query optimization, change tracking), dependency injection patterns, authentication/authorization (IdentityServer, JWT, OAuth 2.0), microservices (MassTransit, gRPC, API gateways), CQRS + MediatR, background services (Hangfire, hosted services), health checks, rate limiting, caching (Redis, IMemoryCache), logging (Serilog), unit testing (xUnit, NSubstitute, Bogus) |
| **Permitted Tools** | Read files, write files, execute bash (dotnet CLI), search codebase |
| **Skills** | dotnet-conventions, api-design-patterns, ef-core-patterns |

#### 3.2.3 Agentic Claude Architect

| Attribute | Value |
|-----------|-------|
| **Agent ID** | `agentic-architect` |
| **Icon / Color** | 🤖 Amber (#D97706) |
| **Domain** | Claude-based agentic systems, multi-agent coordination, prompt engineering |
| **System Prompt Focus** | Orchestrator/worker patterns, prompt engineering for agents (system prompts, tool definitions), tool use design and MCP server integration, context window management and token optimization, multi-agent coordination patterns (fan-out, pipeline, hierarchy), Claude Code subagents and agent teams, structured output parsing (JSON mode), error handling and retry strategies, agent observability and logging, safety guardrails and sandboxing |
| **Permitted Tools** | Read files, write files, execute bash, search codebase |
| **Skills** | agentic-patterns, prompt-engineering, mcp-integration |

#### 3.2.4 PostgreSQL Architect

| Attribute | Value |
|-----------|-------|
| **Agent ID** | `postgres-architect` |
| **Icon / Color** | 🐘 Blue (#336791) |
| **Domain** | Database schema design, query optimization, PostgreSQL-specific features |
| **System Prompt Focus** | Schema design (normalization, denormalization trade-offs), indexing strategies (B-tree, GIN, GiST, BRIN, partial indexes, covering indexes), query optimization (EXPLAIN ANALYZE, CTEs, window functions, lateral joins), migration strategies (zero-downtime migrations, blue-green), partitioning (range, list, hash), replication (streaming, logical), connection pooling (PgBouncer, Supavisor), JSONB patterns, full-text search, row-level security, PostgreSQL extensions (pg_stat_statements, pg_trgm, PostGIS, pgvector), backup/recovery (pg_dump, WAL archiving, PITR) |
| **Permitted Tools** | Read files, write files, execute bash (psql, migration tools), search codebase |
| **Skills** | postgres-conventions, migration-patterns, query-optimization |

#### 3.2.5 UX/UI Specialist

| Attribute | Value |
|-----------|-------|
| **Agent ID** | `ux-ui-specialist` |
| **Icon / Color** | 🎨 Pink (#DB2777) |
| **Domain** | User experience design, interface design, design systems, accessibility |
| **System Prompt Focus** | User journey mapping, wireframe specification (component hierarchy, layout grids), design system architecture (tokens, components, patterns), interaction design (micro-interactions, transitions, loading states, error states, empty states), responsive design patterns, accessibility (WCAG 2.1 AA, screen readers, keyboard navigation), information architecture, usability heuristics (Nielsen), dark mode considerations, design-to-code handoff specifications, component documentation |
| **Permitted Tools** | Read files, write files, search codebase |
| **Skills** | ux-patterns, design-system-architecture, accessibility-guidelines |

#### 3.2.6 Git/GitHub Specialist

| Attribute | Value |
|-----------|-------|
| **Agent ID** | `git-github-specialist` |
| **Icon / Color** | 🔀 Gray (#64748B) |
| **Domain** | Version control, branching strategies, PR workflows, repository management |
| **System Prompt Focus** | Branching strategies (Git Flow, GitHub Flow, trunk-based), commit message conventions (Conventional Commits), PR best practices (size, description, review checklist), merge strategies (merge, squash, rebase), conflict resolution workflows, Git worktree management for parallel agent work, branch protection rules, GitHub Actions integration, code review automation, monorepo strategies (Nx, Turborepo), Git hooks (husky, lint-staged), .gitignore patterns, repository hygiene |
| **Permitted Tools** | Read files, execute bash (git, gh CLI), search codebase |
| **Skills** | git-workflow-patterns, pr-conventions, branching-strategies |

#### 3.2.7 Requirements Specialist (PO/BA)

| Attribute | Value |
|-----------|-------|
| **Agent ID** | `requirements-specialist` |
| **Icon / Color** | 📋 Green (#059669) |
| **Domain** | Business analysis, user stories, acceptance criteria, backlog management |
| **System Prompt Focus** | User story writing (INVEST criteria), acceptance criteria (Given-When-Then), requirements elicitation and refinement, domain modeling (event storming, domain-driven design ubiquitous language), stakeholder analysis, prioritization frameworks (MoSCoW, RICE, WSJF), backlog grooming, definition of ready/done, non-functional requirements specification, traceability matrices, impact analysis for change requests, BDD scenario writing |
| **Permitted Tools** | Read files, write files, search codebase |
| **Skills** | requirements-patterns, user-story-templates, ddd-patterns |

#### 3.2.8 Code Planner Specialist

| Attribute | Value |
|-----------|-------|
| **Agent ID** | `code-planner` |
| **Icon / Color** | 📝 Gray (#475569) |
| **Domain** | Code structure planning, module decomposition, dependency mapping, file organization |
| **System Prompt Focus** | File and folder structure design, module decomposition (feature-based, layer-based, domain-based), dependency graphs and import maps, API contract definitions (OpenAPI specs), interface and type definitions before implementation, code generation templates, shared library identification, naming conventions, configuration management patterns, feature flag integration points, technical debt identification and refactoring plans, code change impact analysis across the codebase |
| **Permitted Tools** | Read files, write files, execute bash (tree, find), search codebase |
| **Skills** | code-organization, module-patterns, dependency-management |

#### 3.2.9 Execution Planner Specialist

| Attribute | Value |
|-----------|-------|
| **Agent ID** | `execution-planner` |
| **Icon / Color** | 📅 Coral (#DC6843) |
| **Domain** | Sprint planning, task sequencing, parallelization strategy, effort estimation |
| **System Prompt Focus** | Task decomposition and sequencing with dependency graphs, parallel execution identification (which tasks can run concurrently), effort estimation (T-shirt sizing, story points), sprint capacity planning, critical path analysis, risk identification and mitigation planning, milestone definition, blocking dependency resolution, resource allocation across agents, progress tracking metrics, definition of done for each task, rollback plans for risky changes |
| **Permitted Tools** | Read files, write files, search codebase |
| **Skills** | execution-planning, task-decomposition, risk-assessment |

#### 3.2.10 CI/CD DevOps Specialist

| Attribute | Value |
|-----------|-------|
| **Agent ID** | `cicd-devops` |
| **Icon / Color** | 🚀 Red (#DC2626) |
| **Domain** | CI/CD pipelines, Docker, testing automation, deployment strategies |
| **System Prompt Focus** | GitHub Actions workflow design (matrix builds, caching, artifacts), Docker/Dockerfile optimization (multi-stage, layer caching, security scanning), testing pipeline orchestration (unit, integration, e2e, visual regression), deployment strategies (blue-green, canary, rolling), infrastructure as code (Terraform, Pulumi), secrets management (GitHub Secrets, Vault), monitoring and alerting (health checks, SLIs/SLOs), database migration automation in CI, environment management (dev, staging, production), dependency scanning (Dependabot, Snyk), performance testing integration |
| **Permitted Tools** | Read files, write files, execute bash (docker, gh, terraform), search codebase |
| **Skills** | cicd-patterns, docker-best-practices, github-actions-patterns |

#### 3.2.11 Cloud and Infrastructure Specialist

| Attribute | Value |
|-----------|-------|
| **Agent ID** | `cloud-infrastructure` |
| **Icon / Color** | ☁️ Teal (#0D9488) |
| **Domain** | Cloud architecture, IaC, scaling, networking, security |
| **System Prompt Focus** | Cloud architecture patterns (AWS, Azure, GCP), infrastructure as code (Terraform modules, Pulumi stacks), networking (VPCs, subnets, load balancers, CDN, DNS), compute selection (containers vs serverless vs VMs), managed database services (RDS, Cloud SQL, Cosmos DB), message queues and event buses (SQS, EventBridge, Pub/Sub), storage (S3, Blob, object lifecycle policies), auto-scaling configurations, cost optimization strategies, security best practices (IAM, network policies, encryption at rest/transit), compliance frameworks, disaster recovery planning, multi-region architecture |
| **Permitted Tools** | Read files, write files, execute bash (aws, az, gcloud, terraform), search codebase |
| **Skills** | cloud-patterns, terraform-modules, security-best-practices |

### 3.3 Agent Interaction Patterns

Agents interact through three primary patterns, selected by the orchestrator based on task requirements:

#### 3.3.1 Fan-Out / Fan-In (Parallel)

The orchestrator sends independent sub-questions to multiple specialists simultaneously. Results are collected and synthesized when all complete. Used for: architecture reviews, initial analysis, multi-domain audits.

#### 3.3.2 Pipeline (Sequential)

Output from one specialist feeds as input to the next. Used for: Requirements → Code Planner → Execution Planner → Code Implementation. Each agent builds on the previous agent's output.

#### 3.3.3 Hierarchical (Nested Delegation)

A specialist may sub-delegate to another specialist for a focused question. For example, the Code Planner may request the PostgreSQL Architect to define the schema before finalizing the module structure. The orchestrator mediates these cross-agent requests.

---

## 4. UI/UX Design

The application uses a panel-based layout inspired by VS Code and modern IDE conventions. The interface is designed for developers who are comfortable with split-pane views and keyboard-driven workflows.

### 4.1 Main Layout

| Panel | Position | Purpose | Key Features |
|-------|----------|---------|--------------|
| Workspace Sidebar | Left (collapsible) | Project navigation and management | Project list, file tree, recent workspaces, workspace settings |
| Chat Panel | Center-left (primary) | Conversation with the Coordinator | Markdown rendering, code blocks, file attachment drop zone, message history search |
| Agent Monitor | Center-right (toggle) | Real-time agent activity | Agent status cards, live stdout streaming via xterm.js, task queue, token usage |
| Plan Viewer | Center-right (toggle) | Execution plan visualization | Task board with drag-and-drop, dependency graph, Gantt-style timeline, status filters |
| Diff Viewer | Center-right (toggle) | Code change review | Monaco-based side-by-side diff, syntax highlighting, inline comments, approve/reject per file |
| Git Panel | Bottom bar (expandable) | Version control operations | Branch selector, staged changes, commit message, push/PR button, merge conflict viewer |
| Context Bar | Right sidebar (collapsible) | Attached files and agent context | Drag-drop file uploads, parsed preview, token count estimate, context management |

### 4.2 Key UI Workflows

#### 4.2.1 Chat with Coordinator

- User types a message or question in the Chat Panel input area
- Optionally attaches files (drag-drop or click to browse) — these are parsed and injected as context
- Coordinator processes the message; a thinking indicator appears with the orchestrator's analysis
- If specialists are engaged, the Agent Monitor panel automatically opens showing active agents
- Agent cards show real-time progress: status (thinking, writing, reviewing), current file being examined, estimated completion
- When synthesis is complete, the response streams into the Chat Panel with full markdown rendering
- If code was modified, a notification badge appears on the Diff Viewer tab
- If an execution plan was created, a notification badge appears on the Plan Viewer tab

#### 4.2.2 Code Audit Workflow

- User selects "Audit Repository" from workspace actions or types "audit this codebase" in chat
- Orchestrator engages relevant specialists: Code Planner (structure), React Architect (frontend quality), .NET Architect (backend quality), PostgreSQL Architect (schema review), CI/CD DevOps (pipeline review)
- Each specialist produces findings categorized by severity: Critical, Warning, Suggestion, Info
- Results are synthesized into an Audit Report displayed in the Chat Panel
- Individual findings link to specific files/lines, opening the Diff Viewer with suggested fixes
- User can approve suggested fixes one-by-one or batch-approve, creating commits

#### 4.2.3 Execution Plan Workflow

- User describes a feature or change they want to implement
- Orchestrator engages Requirements Specialist → Code Planner → Execution Planner (pipeline pattern)
- Requirements Specialist produces user stories and acceptance criteria
- Code Planner defines the file structure, interfaces, and module decomposition
- Execution Planner creates a sequenced task list with dependencies, parallelization opportunities, and effort estimates
- The full plan appears in the Plan Viewer as an interactive task board
- User can modify, reorder, or remove tasks before approving
- On approval, the orchestrator begins executing tasks, delegating each to the appropriate specialist
- Progress is tracked in real-time on the task board; completed tasks show diffs for review

#### 4.2.4 Branch and PR Workflow

- After code changes are reviewed and approved in the Diff Viewer, the user clicks "Create Branch" in the Git Panel
- A dialog suggests a branch name based on the conversation topic (e.g., `feature/add-user-authentication`)
- All approved changes are committed with an auto-generated commit message (editable)
- User clicks "Create Pull Request" — the Git/GitHub Specialist drafts a PR description
- PR description includes: summary of changes, list of modified files, testing notes, and links to the execution plan
- The PR is opened via the GitHub CLI (`gh`), and a link is displayed in the Git Panel

---

## 5. Data Model

All persistent data is stored in a local SQLite database. Each workspace has its own database file located in the workspace's `.agent-studio/` directory. Below are the core tables:

### 5.1 Core Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| **workspaces** | Registered projects | id, name, repo_path, git_remote_url, created_at, last_opened_at, settings_json |
| **conversations** | Chat sessions | id, workspace_id, title, created_at, status (active/archived), summary |
| **messages** | Individual chat messages | id, conversation_id, role (user/coordinator/specialist), agent_id, content_md, attachments_json, created_at |
| **execution_plans** | Task execution plans | id, conversation_id, title, status (draft/approved/in_progress/completed), plan_json, created_at |
| **tasks** | Individual plan tasks | id, plan_id, agent_id, title, description, status, depends_on (task IDs), priority, effort_estimate, started_at, completed_at, output_summary |
| **agent_sessions** | Spawned agent processes | id, task_id, agent_type, pid, status (running/completed/failed/terminated), started_at, ended_at, token_usage, stdout_log_path |
| **file_changes** | Code modifications by agents | id, task_id, agent_id, file_path, change_type (create/modify/delete), diff_text, status (pending/approved/rejected), reviewed_at |
| **attachments** | Context files | id, conversation_id, filename, mime_type, file_path, extracted_text, token_count, created_at |
| **git_operations** | Git history tracking | id, workspace_id, operation (branch/commit/push/pr), ref_name, commit_hash, pr_url, created_at |

---

## 6. Implementation Phases

The project is divided into four phases, each delivering a usable increment. Each phase builds on the previous one. Estimated total timeline: 10–14 weeks for a single developer, less with a team.

### 6.1 Phase 1: Foundation (Weeks 1–3)

> **Goal:** A working Electron app where you can open a project, chat with the Coordinator agent, and see basic agent activity.

#### 6.1.1 Deliverables

| Task | Description | Effort |
|------|-------------|--------|
| Electron + React scaffold | Create Electron app with React + TypeScript + Tailwind. Vite for dev build. electron-builder for packaging. | 2–3 days |
| SQLite integration | Set up better-sqlite3 in main process. Create schema for workspaces, conversations, and messages tables. | 1 day |
| Workspace Manager | Left sidebar: add/remove workspaces by selecting local directories. Store in SQLite. Switch between workspaces. | 2 days |
| IPC layer | Define typed IPC channels: chat:send, chat:receive, agent:status, workspace:open, etc. Bidirectional with event streaming. | 1–2 days |
| Chat Panel | React component with message list (markdown rendering), input area, message history. Scrollable, auto-scroll on new messages. | 2–3 days |
| Orchestrator integration | Spawn a persistent Claude CLI session as the coordinator. Route chat messages to it via stdin. Capture stdout responses. | 2–3 days |
| Basic Agent Monitor | Simple status display showing which agents are currently active, their status, and elapsed time. | 1–2 days |
| File attachment (basic) | Drag-and-drop zone in Chat Panel. Store files locally. Pass file content as context to the Orchestrator. | 1–2 days |

#### 6.1.2 Technical Details

**Electron Main Process:** The main process hosts all backend services. It spawns the Orchestrator as a long-running Claude CLI child process using `child_process.spawn('claude', ['--agent', 'orchestrator', '--output-format', 'stream-json'], { cwd: workspacePath })`. The orchestrator session persists for the lifetime of the workspace.

**IPC Channel Design:** All IPC uses a request/response pattern for queries and an event-stream pattern for real-time updates. Channel naming convention: `domain:action` (e.g., `chat:sendMessage`, `agent:statusUpdate`, `git:createBranch`). TypeScript interfaces enforce payload types on both sides.

**Chat Message Flow:** User message → `ipcRenderer.invoke('chat:sendMessage', { text, attachments })` → Main process writes to orchestrator stdin → Orchestrator stdout is parsed line-by-line → `ipcMain.emit('chat:messageChunk', chunk)` → Renderer appends to Chat Panel.

### 6.2 Phase 2: Agent Pool (Weeks 4–6)

> **Goal:** All 11 specialist agents are operational. The orchestrator can delegate to specialists running in parallel. Real-time agent monitoring with live output streaming.

#### 6.2.1 Deliverables

| Task | Description | Effort |
|------|-------------|--------|
| Agent YAML definitions | Create all 11 `.claude/agents/` YAML files with system prompts, tool permissions, and skill references. | 2–3 days |
| Agent Process Manager | Service that spawns Claude CLI sessions per specialist, manages lifecycle (start/stop/restart), captures stdout/stderr, handles crashes. | 3–4 days |
| Parallel execution engine | Orchestrator emits delegation plan (JSON). Process Manager spawns specialists concurrently. Results collected via `Promise.allSettled` pattern. | 2–3 days |
| Git worktree management | Automatically create and manage worktrees for each agent session. Merge changes back when tasks complete. | 2 days |
| Enhanced Agent Monitor | Full agent dashboard: per-agent cards with live xterm.js terminal output, status indicators, token usage, elapsed time, expandable detail view. | 3–4 days |
| Agent-to-agent messaging | Filesystem-based inbox system: agents write JSON messages to shared directories. Orchestrator routes between specialists. | 1–2 days |
| Token usage tracking | Parse Claude CLI output for token counts. Store per-session in SQLite. Display in Agent Monitor and workspace dashboard. | 1 day |
| Error handling and recovery | Graceful handling of agent crashes, timeouts, rate limits. Auto-retry with exponential backoff. User notification for persistent failures. | 2 days |

#### 6.2.2 Technical Details

**Agent Process Manager Architecture:** The `AgentProcessManager` class maintains a `Map<string, AgentProcess>` of active agents. Each `AgentProcess` wraps a `child_process.ChildProcess` with metadata (agentId, taskId, startTime, tokenCount). The manager exposes methods: `spawn(agentId, taskConfig)`, `terminate(processId)`, `getStatus(processId)`, and `streamOutput(processId)` which returns an `AsyncIterable<OutputChunk>`.

**Worktree Isolation:** When a specialist is spawned, the Git Service creates a worktree: `git worktree add .agent-studio/worktrees/{agentId}-{taskId} -b agent/{agentId}/{taskId}`. The Claude CLI process is started with `cwd` set to this worktree. On completion, changes are merged back to the main branch (if approved) or the worktree is pruned.

**Parallel Execution Flow:** The Orchestrator outputs a JSON delegation plan. The backend parses it and calls `Promise.allSettled(delegations.map(d => processManager.spawn(d.agentId, d.config)))`. As each agent completes, its result is stored in SQLite and forwarded to the Orchestrator for synthesis.

### 6.3 Phase 3: Planning and Review (Weeks 7–10)

> **Goal:** Execution plans, diff viewer, and full Git integration. Users can plan, review, approve changes, create branches, and open PRs.

#### 6.3.1 Deliverables

| Task | Description | Effort |
|------|-------------|--------|
| Plan Viewer (task board) | Interactive task board showing execution plan tasks as cards. Drag-and-drop reordering. Status columns: Pending, In Progress, Review, Done. | 3–4 days |
| Dependency graph visualization | D3.js-based DAG showing task dependencies. Click nodes to view details. Visual indicators for blocked tasks. | 2–3 days |
| Diff Viewer (Monaco) | Monaco Editor in diff mode showing side-by-side changes per file. Syntax highlighting. Inline approve/reject buttons per hunk. | 3–4 days |
| File change aggregation | Collect all file modifications across agent worktrees. Present unified view grouped by file, with per-agent attribution. | 2 days |
| Git Panel | Branch management: create, switch, delete. Staged changes viewer. Commit with auto-generated message. Push to remote. | 3–4 days |
| PR creation flow | Git/GitHub Specialist drafts PR description. User reviews/edits. Create PR via gh CLI or Octokit. Show PR link and status. | 2–3 days |
| Execution engine | Orchestrator executes approved plan tasks sequentially/in parallel based on dependency graph. Updates task statuses in real-time. | 3–4 days |
| Context file parsing | Parse DOCX (mammoth), PDF (pdf-parse), XLSX (xlsx), CSV, images (sharp + OCR). Extract text, estimate tokens, inject into agent context. | 2–3 days |

#### 6.3.2 Technical Details

**Diff Viewer Integration:** Monaco Editor's `DiffEditor` component is configured with the original file content (from Git HEAD) on the left and the agent's modified version on the right. The component uses `MonacoDiffEditor` with options: `{ renderSideBySide: true, readOnly: false }`. Users can further edit the agent's changes before approving.

**Execution Plan JSON Schema:** Plans are stored as JSON with this structure: `{ id, title, tasks: [{ id, agentId, title, description, dependsOn: [taskId], effort, status, output }] }`. The Plan Viewer parses this to render the task board and dependency graph. When the user approves, the Execution Engine topologically sorts tasks and executes in waves of independent tasks.

**PR Description Generation:** The Git/GitHub Specialist receives: the conversation summary, list of changed files with diffs, execution plan summary, and testing notes. It generates a structured PR description following the team's PR template (configurable per workspace).

### 6.4 Phase 4: Polish and Advanced Features (Weeks 11–14)

> **Goal:** Production-quality UX, advanced features, and workflow optimizations. The app feels professional and handles edge cases gracefully.

#### 6.4.1 Deliverables

| Task | Description | Effort |
|------|-------------|--------|
| Keyboard shortcuts | Comprehensive shortcut system: Cmd+K for command palette, Cmd+Enter to send, Cmd+Shift+D for diff, Cmd+B for sidebar toggle, etc. | 2 days |
| Theme system | Light/dark theme toggle. CSS variables for all colors. Respect system preference. High-contrast accessibility mode. | 1–2 days |
| Notification system | Toast notifications for: agent completion, errors, PR created, plan approved. Notification center for history. | 1–2 days |
| Search across conversations | Full-text search across all chat history within a workspace. Filter by agent, date, topic. | 2 days |
| Workspace settings | Per-workspace configuration: default branch, PR template, agent preferences, token budgets, Git remote settings. | 2 days |
| Agent skill customization | UI for editing agent skills (`.claude/skills/` files). Add custom instructions per agent per workspace. | 2–3 days |
| Export and reporting | Export conversation as Markdown/PDF. Export execution plan as document. Export audit report. | 2 days |
| Performance optimization | Virtual scrolling for long conversations. Lazy loading for diff views. Debounced search. SQLite query optimization. | 2–3 days |
| Onboarding and help | First-run wizard: connect Claude CLI, select first workspace, guided tour. In-app help tooltips. | 2 days |
| Error boundary and recovery | React error boundaries. Automatic session recovery. Crash reporting. Safe mode for corrupted workspaces. | 2 days |
| Cloud infrastructure panel | Optional: view cloud resources (AWS/Azure/GCP) related to the workspace. Trigger IaC plans from the app. | 3–4 days |

---

## 7. Project Structure

The following is the recommended directory structure for the Agent Studio codebase:

| Path | Purpose |
|------|---------|
| `agent-studio/` | Root monorepo |
| `package.json` | Root package with Electron build scripts |
| `electron.vite.config.ts` | Vite config for Electron (main + renderer) |
| `src/main/` | Electron main process (Node.js) |
| `src/main/index.ts` | App entry: window creation, IPC registration |
| `src/main/ipc/` | IPC handler definitions (chat, agent, git, workspace channels) |
| `src/main/services/orchestrator.ts` | OrchestratorService: manages persistent coordinator Claude CLI session |
| `src/main/services/agent-process-manager.ts` | AgentProcessManager: spawn/monitor/terminate specialist agents |
| `src/main/services/git.ts` | GitService: worktree, branch, commit, diff, PR operations |
| `src/main/services/file.ts` | FileService: parse attachments (docx, pdf, xlsx, images) |
| `src/main/services/task-tracker.ts` | TaskTracker: CRUD for execution plans and tasks in SQLite |
| `src/main/services/context-store.ts` | ContextStore: manage attached files and token budgets |
| `src/main/db/schema.sql` | SQLite schema definitions |
| `src/main/db/index.ts` | Database initialization and migration runner |
| `src/renderer/` | React frontend (renderer process) |
| `src/renderer/App.tsx` | Root layout with panel management |
| `src/renderer/store/` | Zustand stores (chatStore, agentStore, planStore, gitStore, workspaceStore) |
| `src/renderer/components/chat/` | ChatPanel, MessageList, MessageInput, AttachmentDropzone |
| `src/renderer/components/agents/` | AgentMonitor, AgentCard, AgentTerminal (xterm.js) |
| `src/renderer/components/plan/` | PlanViewer, TaskBoard, TaskCard, DependencyGraph |
| `src/renderer/components/diff/` | DiffViewer (Monaco), FileChangeList, HunkActions |
| `src/renderer/components/git/` | GitPanel, BranchSelector, CommitDialog, PRCreator |
| `src/renderer/components/workspace/` | WorkspaceSidebar, FileTree, WorkspaceSettings |
| `src/renderer/components/context/` | ContextBar, FilePreview, TokenCounter |
| `src/renderer/hooks/` | useIPC, useAgent, useGit, useWorkspace custom hooks |
| `src/renderer/types/` | Shared TypeScript interfaces for all IPC payloads and data models |
| `src/shared/` | Code shared between main and renderer |
| `src/shared/types.ts` | IPC channel definitions, agent types, task types |
| `src/shared/constants.ts` | Agent IDs, status enums, default configurations |
| `.claude/agents/` | 11 specialist agent YAML definitions |
| `.claude/skills/` | Custom skill files referenced by agents |
| `resources/` | App icons, default templates, onboarding assets |

---

## 8. Agent Definition Examples

Below are example YAML configurations for two representative agents. All 11 agents follow this same structure:

### 8.1 Orchestrator Agent

**File:** `.claude/agents/orchestrator.yml`

```yaml
name: orchestrator
description: >
  Central coordinator that analyzes user requests,
  delegates to specialists, and synthesizes results.
  Never writes code directly.
model: claude-sonnet-4-6
system_prompt: |
  You are the Orchestrator of an AI development team.
  Available specialists: react-architect, dotnet-architect,
  agentic-architect, postgres-architect, ux-ui-specialist,
  git-github-specialist, requirements-specialist,
  code-planner, execution-planner, cicd-devops,
  cloud-infrastructure
  Analyze each request and delegate to the minimum set
  of specialists needed. Output structured JSON plans.
tools: [Read, Write, Bash, Search, Task, Teammate]
```

### 8.2 React Architect Agent

**File:** `.claude/agents/react-architect.yml`

```yaml
name: react-architect
description: >
  Frontend React expert. Handles component architecture,
  state management, routing, performance, and accessibility.
model: claude-sonnet-4-6
system_prompt: |
  You are a senior React Frontend Architect. You focus
  exclusively on React/frontend concerns. When you receive
  a task, analyze the codebase first, then propose changes.
  Always consider: component composition, type safety,
  performance (code splitting, memoization), accessibility
  (WCAG 2.1 AA), and testing strategy.
tools: [Read, Write, Bash, Search]
skills: [frontend-conventions, react-patterns]
```

---

## 9. Risk Assessment and Mitigations

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Claude CLI rate limits with parallel agents | High | High | Implement token budgets per agent. Queue agents when approaching limits. Use Sonnet for routine tasks, reserve Opus for complex analysis. Monitor with /cost command. |
| Agent conflicts in shared codebase | Medium | High | Git worktree isolation ensures agents never touch the same files. Orchestrator manages dependency ordering. Merge conflicts detected and surfaced to user. |
| Context window exhaustion in long sessions | High | Medium | Auto-compaction (/compact) triggered when context exceeds 70% capacity. Summarize completed tasks. Use subagents for contained subtasks (separate context). |
| Electron app performance with many open panels | Medium | Medium | Virtual scrolling for long lists. Lazy-load Monaco editor. Debounce IPC events. Web Workers for heavy parsing. Profile with Chrome DevTools. |
| Claude CLI version compatibility | Low | High | Pin minimum Claude CLI version in prerequisites. Check version on app startup. Graceful degradation for missing features. |
| Large repository clone/analysis time | Medium | Low | Use shallow clones (--depth 1) for initial analysis. Incremental codebase scanning. .claudeignore to skip node_modules, build artifacts, etc. |
| Data loss from app crash | Low | High | SQLite WAL mode for crash-safe writes. Auto-save conversation every 30 seconds. Git worktrees preserve agent work even if app crashes. Session recovery on restart. |
| User confusion with many agents | Medium | Medium | Clear agent status UI. Collapsible agent cards. Focus mode showing only active agents. Onboarding tutorial explaining the agent team concept. |

---

## 10. Prerequisites and Setup

### 10.1 System Requirements

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| Operating System | macOS 12+, Windows 10+, Ubuntu 22.04+ | macOS 14+ or latest Windows 11 |
| Node.js | v20.0+ | v22 LTS |
| Claude CLI | Latest version | Latest version (auto-update enabled) |
| Claude Subscription | Max 5x ($100/mo) | Max 20x ($200/mo) for heavy parallel usage |
| Git | 2.35+ | 2.44+ (worktree improvements) |
| GitHub CLI (gh) | 2.40+ | Latest |
| RAM | 8 GB | 16 GB+ (multiple agent processes) |
| Disk | 2 GB free + repo size | SSD with 10 GB+ free |

### 10.2 Initial Setup Steps

1. Install Node.js 20+ and ensure npm is available
2. Install Claude CLI: `npm install -g @anthropic-ai/claude-code`
3. Authenticate: run `claude login` and complete OAuth flow (this uses your Max subscription)
4. Install GitHub CLI: `brew install gh` (macOS) or equivalent for your OS
5. Authenticate GitHub: `gh auth login`
6. Clone the Agent Studio repository
7. Run `npm install` to install all dependencies
8. Run `npm run dev` to start the Electron app in development mode
9. On first launch, select a workspace directory containing a Git repository
10. Start chatting with the Coordinator agent

---

## 11. Success Metrics

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Agent response time | < 30 seconds for simple delegation, < 2 min for full team | Timestamp logging in AgentProcessManager |
| Parallel agent success rate | > 95% of delegations complete without error | Error counts in agent_sessions table |
| Diff accuracy | > 90% of agent-generated diffs apply cleanly | Track merge conflict count vs. total changes |
| PR quality | > 80% of auto-generated PRs pass CI on first push | GitHub API: check run status after PR creation |
| Token efficiency | < 50K tokens per typical orchestration cycle | Token tracking in SQLite, compare across conversation types |
| App startup time | < 3 seconds to interactive state | Performance profiling with Electron DevTools |
| Crash rate | < 1 crash per 100 hours of usage | Error boundary reporting + process monitoring |

---

## 12. Next Steps

To begin implementing Agent Studio, the recommended immediate actions are:

1. **Scaffold the Electron project:** Initialize the monorepo with Electron + React + TypeScript + Tailwind using electron-vite. Set up the build pipeline and ensure the app launches with a blank window.

2. **Create all 11 agent YAML files:** Write the `.claude/agents/` definitions with full system prompts. Test each agent individually in Claude Code to validate their focus and quality.

3. **Build the IPC layer:** Define all TypeScript interfaces for IPC channels. Implement the bidirectional communication bridge between renderer and main processes.

4. **Implement the Orchestrator Service:** This is the critical path — the ability to spawn a persistent Claude CLI session, send it messages, and parse structured JSON responses.

5. **Build the Chat Panel:** The primary user interface. Once this works with the Orchestrator, you have a functional (if minimal) application.

---

*— End of Document —*
