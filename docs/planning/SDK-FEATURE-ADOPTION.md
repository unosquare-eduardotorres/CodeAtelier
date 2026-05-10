# SDK Feature Adoption — Master Plan

> **Last updated**: 2026-05-09
> **SDK version**: `@anthropic-ai/claude-agent-sdk@0.2.138`

---

## Phase 2 — Completed ✅

Seven work items across 4 blocks, all implemented and type-checked.

| Block | Item | Status |
|-------|------|--------|
| A | `close()` — force terminate query | ✅ Done |
| A | `seedReadState(path, mtime)` — fix edit-after-compact | ✅ Done |
| A | `PreCompact` + `PostCompact` hooks with callbacks | ✅ Done |
| B | `elicitation_complete` message handler | ✅ Done |
| B | `local_command_output` message handler | ✅ Done |
| C.1 | `canUseTool` — enriched tool approval with title/description/Always Allow | ✅ Done |
| C.2 | `onElicitation` — MCP OAuth via `ElicitationService` + `ElicitationModal` | ✅ Done |
| D | Session management: `listSessions`, `getSessionInfo`, `getSessionMessages`, `renameSession`, `tagSession`, `forkSession` | ✅ Done |

### Files Created (Phase 2)
- `src/main/services/elicitation.service.ts`
- `src/main/ipc/session.ipc.ts`
- `src/renderer/src/components/common/ElicitationModal.tsx`

### Files Modified (Phase 2)
- `src/main/services/sdk-executor.ts` — compact hook wiring, message handlers, canUseTool typing
- `src/main/services/sdk-hooks.ts` — `createPreCompactHook`, `createPostCompactHook`
- `src/main/services/generalist.service.ts` — `onPostCompact` + `seedReadState`, `canUseTool` wiring
- `src/main/services/tool-approval.service.ts` — `requestApprovalEnriched()`
- `src/main/ipc/sdk-control.ipc.ts` — `close`, `seedReadState`, elicitation response handlers
- `src/main/ipc/index.ts` — register session IPC
- `src/shared/constants.ts` — all new channels
- `src/shared/types.ts` — all new IPC channel types
- `src/preload/index.ts` + `index.d.ts` — bridge methods
- `src/renderer/src/components/common/ToolApprovalModal.tsx` — enriched context UI
- `src/renderer/src/components/common/index.ts` — barrel export
- `src/renderer/src/App.tsx` — mount `ElicitationModal`

---

## Full SDK Surface Audit

### Coverage Summary

| Category | Wired | Total | Coverage |
|----------|-------|-------|----------|
| Query instance methods | 17/19 | 89% |
| Query options | 24/37 | 65% |
| Top-level functions | 10/13 | 77% |
| Message types handled | 21/22 | 95% |
| Hook events wired | 12/27 | 44% |

### Query Instance Methods — Fully Wired ✅

| Method | IPC Channel | Called from Renderer? |
|--------|-------------|---------------------|
| `close()` | `sdk:closeQuery` | Not yet |
| `seedReadState()` | `sdk:seedReadState` | Not yet (auto-called by PostCompact) |
| `getContextUsage()` | `sdk:getContextUsage` | Not yet (used internally) |
| `stopTask()` | `sdk:stopTask` | ✅ AgentStatusCard.tsx |
| `interrupt()` | `sdk:interrupt` | Not yet |
| `accountInfo()` | `sdk:accountInfo` | Not yet |
| `supportedModels()` | `sdk:supportedModels` | Not yet |
| `mcpServerStatus()` | `sdk:mcpServerStatus` | Not yet |
| `setModel()` | `sdk:setModel` | Not yet |
| `setPermissionMode()` | `sdk:setPermissionMode` | Not yet (used internally) |
| `applyFlagSettings()` | `sdk:applyFlagSettings` | Not yet |
| `setMcpServers()` | `sdk:setMcpServers` | Not yet |
| `rewindFiles()` | `sdk:rewindFiles` | Not yet |
| `reconnectMcpServer()` | `sdk:reconnectMcp` | Not yet |
| `supportedAgents()` | `sdk:supportedAgents` | Not yet |

### Query Instance Methods — NOT Wired ❌

| Method | Why Missing | Phase 3? |
|--------|-------------|----------|
| `toggleMcpServer(name, enabled)` | Enable/disable MCP mid-session | ✅ Yes |
| `initializationResult()` | Replaces accountInfo + supportedModels in one call | ⚠️ Maybe |
| `supportedCommands()` | Slash command auto-complete | ⚠️ Maybe |
| `reloadPlugins()` | Hot-reload after skill/agent edits | ⚠️ Maybe |
| `setMaxThinkingTokens()` | **Deprecated** — use `thinking` option | ❌ Skip |

### Top-level Functions — NOT Wired ❌

| Function | What it does | Phase 3? |
|----------|-------------|----------|
| `getSubagentMessages()` | Read specialist full transcripts | ✅ Already wired in IPC |
| `listSubagents()` | List SubAgents for a session | ✅ Already wired in IPC |
| `tool()` | Define custom tools inline | ❌ Skip (we use `createSdkMcpServer`) |
| `unstable_v2_createSession()` | V2 persistent sessions | ❌ Skip (@alpha) |
| `unstable_v2_prompt()` | V2 one-shot prompt | ❌ Skip (@alpha) |
| `unstable_v2_resumeSession()` | V2 session resume | ❌ Skip (@alpha) |

### Query Options — NOT Wired ❌

| Option | What it does | Win | Phase 3? |
|--------|-------------|-----|----------|
| `additionalDirectories` | Multi-directory access beyond cwd | Monorepo / multi-project support | ✅ Yes |
| `resumeSessionAt` | Resume from a specific message UUID | Powers "Undo to this point" / rewind UI | ✅ Yes |
| `taskBudget` | API-side token budget awareness | Model paces itself instead of hard-kill | ✅ Yes |
| `sandbox` | Command execution isolation | Security hardening for build mode | ✅ Yes |
| `env` (CLIENT_APP) | Set User-Agent identifier | Analytics / telemetry attribution | ⚠️ Maybe |
| `toolConfig` | Per-tool configuration | AskUserQuestion format control | ⚠️ Maybe |
| `agent` | Use named agent for main thread | Simplify generalist agent loading | ⚠️ Maybe |
| `tools` (preset) | Restrict tool preset | Specialist tool scoping | ⚠️ Maybe |
| `plugins` | Load local plugins at session level | Plugin ecosystem | ❌ Skip (MCP servers suffice) |
| `continue` | Continue most recent session | We use `resume` with sessionMap | ❌ Skip |
| `forkSession` (option) | Auto-fork on resume | We use top-level `forkSession()` | ❌ Skip |
| `persistSession` | Disable session persistence | All sessions should persist | ❌ Skip |
| `includeHookEvents` | Hook lifecycle in stream | Already handled via hook callbacks | ❌ Skip |
| `settings` / `settingSources` | Filesystem settings | We manage settings via DB | ❌ Skip |
| `debug` / `debugFile` / `stderr` | Debug logging | Dev-only, not user-facing | ❌ Skip |
| `permissionPromptToolName` | Custom permission MCP tool | We use `canUseTool` callback | ❌ Skip |
| `strictMcpConfig` | Strict MCP validation | Nice-to-have, not impactful | ❌ Skip |
| `sessionId` | Custom session UUID | We let SDK auto-generate | ❌ Skip |

### Hook Events — NOT Wired ❌

| Hook | What it fires on | Win | Phase 3? |
|------|-----------------|-----|----------|
| `SubagentStart` | SubAgent spawned | Better status tracking in AgentMonitor | ✅ Yes |
| `SubagentStop` | SubAgent finished | Track specialist completion lifecycle | ✅ Yes |
| `TaskCreated` | Task object created | Rich decomposition tracking | ✅ Yes |
| `TaskCompleted` | Task object finished | Track task lifecycle end-to-end | ✅ Yes |
| `UserPromptSubmit` | Before user prompt sent | Pre-processing, validation, auto-complete | ⚠️ Maybe |
| `InstructionsLoaded` | CLAUDE.md loaded | UI feedback: "Context loaded from CLAUDE.md" | ⚠️ Maybe |
| `TeammateIdle` | Teammate agent idle | Multi-agent coordination | ⚠️ Maybe |
| `SessionStart` | Session begins | Session analytics | ❌ Skip (init msg suffices) |
| `Stop` / `StopFailure` | Query stops | We use AbortController | ❌ Skip |
| `Setup` | Initial setup | One-time, not actionable | ❌ Skip |
| `ConfigChange` | Config changed | We manage config via DB | ❌ Skip |
| `WorktreeCreate` / `WorktreeRemove` | Git worktree ops | Niche feature | ❌ Skip |
| `CwdChanged` | Working directory changed | Not applicable (fixed cwd) | ❌ Skip |

---

## Phase 3 — Proposed

Eight work items grouped into 3 blocks. Prioritized by user-facing impact.

### Block E — Specialist Lifecycle Hooks + SubAgent Inspector

**Win**: Currently SubAgent lifecycle is tracked via stream messages (`task_started`, `task_progress`, `task_notification`). Hook-based tracking gives us pre/post callbacks we can use for richer state management — track cost per specialist, instrument timing, and trigger UI updates before the stream events arrive.

Combined with the already-wired `listSubagents()` + `getSubagentMessages()`, this enables a **Specialist Inspector** panel where users can click any specialist to see its full transcript, tools used, and cost breakdown.

#### E.1 — `SubagentStart` / `SubagentStop` Hooks

**`src/main/services/sdk-hooks.ts`** — two new hooks:
```typescript
export function createSubagentStartHook(
  onStart: (agentId: string, description: string) => void
): HookCallback

export function createSubagentStopHook(
  onStop: (agentId: string, status: string) => void
): HookCallback
```

**`src/main/services/sdk-executor.ts`** — add options + wire in hooksConfig:
```typescript
onSubagentStart?: (agentId: string, description: string) => void
onSubagentStop?: (agentId: string, status: string) => void
```

**Effort**: Small

#### E.2 — `TaskCreated` / `TaskCompleted` Hooks

**`src/main/services/sdk-hooks.ts`** — two new hooks:
```typescript
export function createTaskCreatedHook(
  onCreated: (taskId: string, description: string) => void
): HookCallback

export function createTaskCompletedHook(
  onCompleted: (taskId: string, status: string, result?: string) => void
): HookCallback
```

**Effort**: Small

#### E.3 — Specialist Inspector UI (deferred)

Depends on E.1 + E.2. Uses existing `listSubagents()` and `getSubagentMessages()` IPC handlers. Renders a panel in AgentMonitor showing full specialist transcripts. **This is a renderer-only task** — no backend work needed since the IPC is already wired.

**Effort**: Medium (renderer only)

---

### Block F — Multi-Directory + Resume-at-Message + Task Budget

These are query-option additions that unlock new features with minimal code.

#### F.1 — `additionalDirectories` — Monorepo Support

**Problem**: Users working in monorepos need Claude to access sibling directories (e.g., `packages/shared/` from `packages/app/`). Currently limited to `cwd`.

**Win**: Unlocks multi-package workspace support. Users configure additional directories in workspace settings, passed through to `query()`.

**Files**:
- `src/main/services/sdk-executor.ts` — add `additionalDirectories?: string[]` to options, pass through
- `src/main/services/generalist.service.ts` — read from workspace settings, pass to execute
- Workspace settings schema update

**Effort**: Small

#### F.2 — `resumeSessionAt` — Undo to Checkpoint

**Problem**: Users want to "rewind" a conversation to a specific message and continue from there, discarding later messages.

**Win**: Powers "Undo to this point" in the message list. Combined with `rewindFiles()` (already wired), enables full conversation + file rollback.

**Files**:
- `src/main/services/sdk-executor.ts` — add `resumeSessionAt?: string` to options, pass through
- `src/main/services/generalist.service.ts` — accept message UUID, use on next `send()`
- New IPC channel for the renderer to request rewind-to-message
- Renderer: "Undo to here" button on message bubbles

**Effort**: Medium

#### F.3 — `taskBudget` — Token-Aware Pacing

**Problem**: `maxBudgetUsd` hard-kills the query when exceeded. The model has no awareness of its budget, so it can't pace itself or wrap up gracefully.

**Win**: With `taskBudget`, the model knows its token budget and can self-regulate — e.g., "I'm at 80% budget, let me summarize and finish." More graceful than hard-kill. Uses `task-budgets-2026-03-13` beta header.

**Files**:
- `src/main/services/sdk-executor.ts` — add `taskBudget?: { total: number }`, pass through with beta
- `src/main/services/generalist.service.ts` — calculate budget from workspace preferences
- Could pair with complexity tier: simple=10K, moderate=30K, complex=80K tokens

**Effort**: Small

**Risk**: @alpha API — may change. Worth tracking but low-risk to implement.

---

### Block G — Security + Observability

#### G.1 — `sandbox` — Command Isolation

**Problem**: In build mode with `bypassPermissions`, all Bash commands run unrestricted. A malicious or confused agent could execute harmful system commands.

**Win**: The SDK sandbox option provides OS-level command isolation (Linux bubblewrap / macOS sandbox-exec). Defense-in-depth alongside scope guard hooks.

**Files**:
- `src/main/services/sdk-executor.ts` — add `sandbox?: SandboxSettings` to options, pass through
- `src/main/services/generalist.service.ts` — enable sandbox in build mode
- Consider `autoAllowBashIfSandboxed: true` to reduce approval fatigue when sandboxed

**Effort**: Small to wire, Medium to test cross-platform

**Risk**: macOS sandbox-exec has limited capabilities. Linux bubblewrap may not be installed. Use `failIfUnavailable: false` for graceful degradation.

#### G.2 — `toggleMcpServer` — MCP Health Dashboard

**Problem**: If an MCP server hangs or crashes, users have no way to disable it without restarting the session.

**Win**: Powers a toggle switch per MCP server in the MCP health panel. Combined with already-wired `mcpServerStatus()` and `reconnectMcpServer()`, gives full MCP lifecycle control.

**Files**:
- `src/main/ipc/sdk-control.ipc.ts` — add handler
- `src/shared/constants.ts` — add channel
- `src/preload/index.ts` + `index.d.ts` — bridge
- Renderer: toggle in MCP status panel

**Effort**: Small

#### G.3 — `env` with `CLAUDE_AGENT_SDK_CLIENT_APP`

**Problem**: API requests from Code Atelier are indistinguishable from raw CLI usage in Anthropic's analytics.

**Win**: Setting `CLAUDE_AGENT_SDK_CLIENT_APP: 'code-atelier/1.0'` tags all API requests with our app identifier. Enables Anthropic-side analytics and potential partnership benefits.

**Files**:
- `src/main/services/sdk-executor.ts` — pass `env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'code-atelier/VERSION' }` in query options

**Effort**: Trivial (1 line)

---

## Phase 3 — Implementation Order

| Step | Block | Item | Effort | Depends On |
|------|-------|------|--------|------------|
| 1 | **G.3** | `env` CLIENT_APP identifier | Trivial | — |
| 2 | **E.1** | SubagentStart / SubagentStop hooks | Small | — |
| 3 | **E.2** | TaskCreated / TaskCompleted hooks | Small | — |
| 4 | **G.2** | `toggleMcpServer` IPC + UI | Small | — |
| 5 | **F.1** | `additionalDirectories` monorepo support | Small | — |
| 6 | **F.3** | `taskBudget` token-aware pacing | Small | — |
| 7 | **G.1** | `sandbox` command isolation | Medium | — |
| 8 | **F.2** | `resumeSessionAt` undo-to-checkpoint | Medium | — |
| 9 | **E.3** | Specialist Inspector UI | Medium | E.1, E.2 |

---

## Deferred / Not Planned

| Feature | Reason |
|---------|--------|
| `setMaxThinkingTokens()` | Deprecated — replaced by `thinking` option (already wired) |
| `initializationResult()` | Convenience — `accountInfo()` + `supportedModels()` work fine separately |
| `supportedCommands()` | Low value — no slash command UI planned |
| `reloadPlugins()` | We don't use plugins — MCP servers are managed differently |
| `tool()` function | We use `createSdkMcpServer()` — no raw tool definitions needed |
| `unstable_v2_*` functions | Deprecated in 0.2.133 — use `query()` instead |
| `plugins` option | We use in-process MCP servers instead |
| `continue` option | We use `resume` with sessionMap |
| `forkSession` query option | We use top-level `forkSession()` function |
| `persistSession` option | Sessions should always persist |
| `settings` / `settingSources` | We manage settings via DB, not filesystem |
| `debug` / `debugFile` / `stderr` | Dev-only, not user-facing |
| `permissionPromptToolName` | Replaced by `canUseTool` callback |
| `strictMcpConfig` | Marginal safety improvement |
| `sessionId` option | Let SDK auto-generate |
| `includeHookEvents` option | Already handled via hook callbacks |
| `UserPromptSubmit` hook | Low value — no pre-processing needed |
| `InstructionsLoaded` hook | Nice-to-know but not actionable |
| `TeammateIdle` hook | Only useful for multi-agent coordination patterns we don't use |
| `SessionStart` hook | System init message already captures session start |
| `Stop` / `StopFailure` hooks | AbortController handles this |
| `Setup` hook | One-time, not actionable |
| `ConfigChange` hook | Config managed via DB |
| `WorktreeCreate` / `WorktreeRemove` hooks | Niche git worktree ops |
| `CwdChanged` hook | Fixed cwd per workspace |

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-08 | Phase 2 completed | All 7 items implemented, typecheck passes |
| 2026-04-08 | `local_command_output` type corrected | SDK type is `system/local_command_output` with `content` field, not top-level `type: 'local_command_output'` with `output` field |
| 2026-04-08 | Skip `unstable_v2_*` | Alpha API — V2 session model may change significantly |
| 2026-04-08 | Skip `plugins` option | `createSdkMcpServer()` covers all our custom tool needs |
| 2026-04-08 | Prioritize `env` CLIENT_APP first in Phase 3 | Trivial to implement, immediate analytics benefit |
| 2026-04-08 | `taskBudget` marked as Phase 3 despite @alpha | Low risk — simple passthrough, graceful degradation if API changes |
| 2026-05-09 | SDK bumped to 0.2.138 | TodoWrite deprecated → added TaskCreate/TaskUpdate/TaskGet/TaskList to disallowedTools and summarizeToolInput; resolveSettings() wired for diagnostics; result origin captured |
