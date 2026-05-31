# Project Specialist Refactor — Implementation Notes

Living companion to the approved plan. Updated as each phase lands.

---

## Migration version correction

The plan calls for **migration 65**, but the DB already has migration 65 (`create-bugs-table`, added in the current HEAD). The Project Specialist migration will therefore land as **migration 66**. `CURRENT_SCHEMA_VERSION` will move from 65 → 66.

---

## Phase 1 — Session-layer audit (Task #1)

Goal: decide which portions of `generalist.service.ts` (1597 LOC) belong in the new generic `AgentSessionService` vs a `GeneralistRoleAdapter`.

### Public surface that MUST stay intact

Consumers of `generalistService.*` (confirmed via grep):

| Consumer                                                     | Methods called                                                                                                                                                                                                             |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/ipc/chat-lifecycle.ipc.ts`                         | `start`, `send`, `stop`, `switchMode`, `switchPersona`, `getMode`, `getCurrentConversationId`, `compact`                                                                                                                   |
| `src/main/ipc/agent.ipc.ts`                                  | `getStatus`, `isRunning`, `getStreamedContent`, `getCacheEfficiency`, event emitters (`chunk`, `statusUpdate`, `complete`, `intent`, `handoff`, `plan`, `askQuestion`, `promptSuggestion`, `compactNeeded`, `elicitation`) |
| `src/main/ipc/agent-lifecycle.ipc.ts`                        | `start`, `stop`                                                                                                                                                                                                            |
| `src/main/ipc/sdk-control.ipc.ts`                            | `getActiveQuery`, `resumeAt`, `getSessionId`, `clearSession`                                                                                                                                                               |
| `src/main/ipc/checkpoint.ipc.ts`                             | `getActiveQuery`                                                                                                                                                                                                           |
| `src/main/services/task-pipeline.service.ts`                 | `injectContext`, `getCurrentConversationId`                                                                                                                                                                                |
| `src/main/services/generalist-stream.service.ts`             | `this.generalistService.*` cross-references — will be merged in                                                                                                                                                            |
| `src/main/services/__tests__/ipc-pipeline-contracts.test.ts` | 23 references, mostly for mocking                                                                                                                                                                                          |

**Invariant**: after Phase 1, all 9 IPC/service consumers compile and run unchanged. `generalistService` remains an EventEmitter with identical method signatures and events. Internally it becomes a thin wrapper around `AgentSessionService`.

### What moves to `AgentSessionService` (generic)

- **Session lifecycle** — `sessionMap`, `resolveSession`, `clearSession`, `getSessionId`, `resumeAt`, `pendingResumeAt`, `sdkAbortController`, session ID capture from `meta.sessionId`.
- **Stream orchestration** — `executeStream`, `processMetaChunk`, `processContentChunk`, `finalizeStream`, `handleStreamError`, `handleSessionRecovery`, `buildRecoverySummary`.
- **Token + cost tracking** — delegation to `GeneralistTokenTracker` (renamed to `AgentTokenTracker` or kept role-neutral; signature is already role-neutral).
- **Circuit breaker** — `GeneralistCircuitBreaker` → `AgentCircuitBreaker` (wrap identically).
- **Compaction** — `checkCompaction`, `compact`, `compactSuggested`, `compactCount`, `costPreference`-driven thresholds, `pendingCompaction`.
- **Mode switching** — `switchMode`, `currentMode`, permission-mode wiring to the active SDK `Query`.
- **Abort / cancel** — `cancelCurrentQuery`, `stop`.
- **Persona** — `switchPersona`, `currentPersonaSpecialistId`, `currentPersonaData` (generic concept: role + optional persona overlay).
- **Context injection** — `injectContext` (lazy, zero-cost via assembler's pending context).
- **Recovery nudge** — `RecoveryNudgeService` wiring.
- **DB session tracking** — `createDbSession`, `updateDbSessionConversation`, `completeDbSession` (inherited from `AgentBaseService`).
- **Workspace path + id + conversation id** — `workspacePath`, `workspaceId`, `currentConversationId`.
- **SDK execute options skeleton** — `buildSdkExecuteOptions` minus adapter-supplied fields (`systemPrompt`, `mcpResult`, `permissionMode`, `allowedTools`, `disallowedTools`, `additionalDirectories`, `canUseTool`).

### What moves to `GeneralistRoleAdapter` (Generalist-specific)

- `GeneralistPromptAssembler` (assembles system prompt + effective message; handoff framing, specialist roster, investigation mode).
- `GeneralistMcpConfig.build(...)` (MCP server selection: control-actions, code-graph, semantic-search, github, investigation hooks).
- `buildControlCallbacks()` — `onPlan`, `onHandoff`, `onAskUser`, `onMemory` intent wiring.
- `emitDetectedIntents()` — pipes `ControlToolState` through `intentDetector`.
- `decompose()` — handoff brief → task plan (Generalist-only; Project Specialist never delegates).
- Feature flag refresh (`refreshFeatureFlags()`) — role-neutral _shape_ but the flags Generalist consumes (`investigationModeEnabled`, `repomapEnabled`, `semanticSearchEnabled`, `githubConfigured`) are generalist/workspace features. Project Specialist will override with its own flag set.
- `investigationModeEnabled` — Generalist-only gate.
- Persona loading (`currentPersonaData`) — currently generalist-only; likely shareable later, kept in adapter for Phase 1.

### Role adapter interface (draft)

```ts
// src/main/services/agent-session.types.ts
import type { ConversationMode, ControlToolState } from '../../shared/types'
import type { ControlActionCallbacks } from './control-actions.tool'

export type AgentRole = 'generalist' | 'project-specialist'

export interface AdapterPromptContext {
  message: string
  conversationId: string
  hasImages: boolean
  turnCount: number
  sessionId: string | undefined
  mode: ConversationMode
  workspacePath: string
  workspaceId: string | null
}

export interface AdapterMcpContext {
  mode: ConversationMode
  workspacePath: string
  workspaceId: string | null
  conversationId: string | null
  controlCallbacks: ControlActionCallbacks
}

export interface AgentRoleAdapter {
  readonly role: AgentRole
  readonly agentId: string // e.g. GENERALIST_AGENT_ID or workspace-specialist-<id>

  /** Called once on session.start() — load role-specific state (prompt, feature flags). */
  onSessionStart(ctx: {
    workspacePath: string
    workspaceId: string | null
    conversationId: string | null
  }): Promise<void>

  /** Assemble system prompt + effective message for the upcoming turn. */
  buildPrompts(ctx: AdapterPromptContext): { systemPrompt: string; effectiveMessage: string }

  /** Compose MCP servers, allowed/disallowed tool lists. */
  buildMcpConfig(ctx: AdapterMcpContext): {
    mcpServers?: Record<string, unknown>
    allowedTools?: string[]
    disallowedTools?: string[]
  }

  /** Wire control-tool callbacks (plan/handoff/askUser/memory) — may return empty for adapters without control tools. */
  buildControlCallbacks(emit: (event: string, payload: unknown) => void): ControlActionCallbacks

  /** Detect + emit intents from accumulated text + control-tool state (post-stream). */
  emitDetectedIntents(ctx: {
    accumulatedText: string
    controlToolState: ControlToolState
    mode: ConversationMode
    conversationId: string
    emit: (event: string, payload: unknown) => void
  }): void

  /** Whether this adapter supports handoff (Generalist only). */
  supportsHandoff(): boolean

  /** Reset any per-session state on stop(). */
  onSessionStop(): void
}
```

### Refactor outline (Task #5)

After Phase 1 lands, `generalist.service.ts` collapses to roughly:

```ts
export class GeneralistService extends EventEmitter {
  private session: AgentSessionService
  constructor() {
    super()
    this.session = new AgentSessionService(new GeneralistRoleAdapter())
    // forward events 1:1
    for (const evt of [
      'chunk',
      'statusUpdate',
      'complete',
      'intent',
      'handoff',
      'plan',
      'askQuestion',
      'promptSuggestion',
      'compactNeeded',
      'elicitation'
    ]) {
      this.session.on(evt, (payload) => this.emit(evt, payload))
    }
  }
  start = (...args) => this.session.start(...args)
  send = (...args) => this.session.send(...args)
  // ... etc — simple forwarders
}
```

Target size: < 200 LOC.

### Ship-gate checklist for Phase 1

- [ ] Existing test suites pass unchanged
- [ ] `agent-session.service.test.ts` covers start/send/stop/switchMode/compact/abort/recovery
- [ ] `role-adapters/generalist.adapter.test.ts` verifies prompt + MCP + intent wiring unchanged
- [ ] Manual smoke: plan mode + build mode + handoff + compaction + mode-switch + abort mid-stream

---

## Phase 2 notes (captured for later)

### Migration 66 skeleton

```sql
ALTER TABLE specialists ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE specialists ADD COLUMN build_status TEXT NOT NULL DEFAULT 'ready'
  CHECK (build_status IN ('pending', 'building', 'ready', 'failed'));
ALTER TABLE specialists ADD COLUMN stack_fingerprint TEXT;
ALTER TABLE specialists ADD COLUMN detected_techs TEXT DEFAULT '[]' CHECK (json_valid(detected_techs));
ALTER TABLE specialists ADD COLUMN mcp_config TEXT DEFAULT '{}' CHECK (json_valid(mcp_config));
ALTER TABLE specialists ADD COLUMN mcp_overrides TEXT DEFAULT '{}' CHECK (json_valid(mcp_overrides));
ALTER TABLE specialists ADD COLUMN last_built_at TEXT;
CREATE UNIQUE INDEX idx_specialists_workspace_unique ON specialists(workspace_id) WHERE workspace_id IS NOT NULL;
ALTER TABLE specialist_skills ADD COLUMN is_enabled INTEGER NOT NULL DEFAULT 0;
```

(Full sequence — backup export, rebind conversation_specialists, drop app-global specialists — documented in the plan §5.1.)

### Naming defaults (from plan §9)

- Display name: `"{workspace.name} Specialist"`
- agent_id: `workspace-specialist-{workspace.id}`
- Icon default: `🔧`, color `#6366F1`

### Out-of-scope reminders

- Dynamic skill generation (Phase 3+)
- Cross-workspace reasoning
- Multi-specialist parallelism
- Re-introducing handoff

---

## Scheduled deletions (Phase 3 cleanup — inert but compiled)

Migration 66 deleted all app-global specialists (except the Generalist row),
so the following legacy modules are **no longer invoked at runtime** in the
new flow. They stayed compiled-but-inert so Phase 2 could ship green without
a multi-file cascade rewrite:

- `src/main/services/specialist-pool.service.ts` (~1,500 LOC) — was the
  SubAgent-spawn orchestrator for handoffs. Dead.
- `src/main/services/specialist-deploy.service.ts` — deployed app-global
  specialists into workspaces. Dead.
- `src/main/services/specialist-control-actions.tool.ts` — handoff MCP tool,
  never exposed to Project Specialists.
- `src/main/ipc/specialist-deploy.ipc.ts` — IPC for the deploy service.
- Handoff branches in `task-pipeline.service.ts`, `workspace-deploy.service.ts`,
  `chat.ipc.ts`, `chat-message.ipc.ts`.

A dedicated Phase 3 PR removes them plus their tests; doing it in Phase 2
would have added ~2 days of cascade work with zero runtime benefit.

### Renderer components scheduled for deletion (Phase 3)

Left in place alongside the new slide-over so Phase 2 ships green:

- `src/renderer/src/components/settings/SpecialistMarketplace.tsx`
- `src/renderer/src/components/settings/SpecialistCard.tsx`
- `src/renderer/src/components/chat/SpecialistsTable.tsx`
- `src/renderer/src/components/chat/SpecialistDrawer.tsx`
- `src/renderer/src/components/chat/ActiveSpecialistsStrip.tsx`
- `src/renderer/src/components/chat/PersonaSelector.tsx` (Generalist-only — keep until persona flow is retired)
- `src/renderer/src/components/settings/SpecialistEditPage.tsx`

Cut-over status:

- `ChatPanel` ships the new `Specialist` header button + `SpecialistSlideOver`
  in parallel with the old UI.
- `SpecialistsListPage` (new) is ready for Settings to route to; old
  `SpecialistMarketplace` still linked from legacy nav.
- `NewChatPage` and `MessageInput` specialist-picker / @-mention logic
  untouched — neither break the Project Specialist flow, they just expose
  legacy app-global specialists that no longer exist post-migration 66 (the
  picker will simply show empty).
