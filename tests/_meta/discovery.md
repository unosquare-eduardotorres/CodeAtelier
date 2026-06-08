# Test Generation — Phase 0: Discovery Report

> **Generated**: 2026-04-20
> **Run focus**: discovery
> **Status**: Complete ✅

---

## 1. Stack Identification

| Aspect              | Value                                                                     |
| ------------------- | ------------------------------------------------------------------------- |
| Language            | TypeScript 5.9 (strict)                                                   |
| Runtime             | Electron 41 (Node 24) / React 19                                          |
| Test framework      | Custom tsx-based runner (`node:assert/strict`) + shared `test-harness.ts` |
| E2E framework       | Playwright (`@playwright/test ^1.59.0-alpha`)                             |
| LLM tests           | Live Claude SDK via CLI (opt-in, `test:llm`)                              |
| Mocking             | Manual fakes/stubs (no Jest, no Vitest, no sinon)                         |
| Coverage tool       | None currently configured                                                 |
| Test runner scripts | `test:unit`, `test:repo`, `test:llm`, `test:all`                          |

---

## 2. Architecture Map

### Agents / Orchestration

| Module                     | File                                               | Role                                                |
| -------------------------- | -------------------------------------------------- | --------------------------------------------------- |
| Generalist Service         | `src/main/services/generalist.service.ts`          | Long-lived coordinator, spawns specialists          |
| Specialist Pool            | `src/main/services/specialist-pool.service.ts`     | Manages specialist lifecycle, scheduling, execution |
| SDK Executor               | `src/main/services/sdk-executor.ts`                | Wraps Claude Agent SDK `execute` calls              |
| Conversation State Machine | `src/main/services/conversation-state-machine.ts`  | State transitions (idle → streaming → executing)    |
| Intent Detector            | `src/main/services/intent-detector.ts`             | Detects intents from user messages                  |
| Intent Router              | `src/main/services/intent-router.ts`               | Routes intents to appropriate handlers              |
| Prompt Assembler           | `src/main/services/generalist-prompt-assembler.ts` | Builds system prompts per turn                      |
| Generalist Stream          | `src/main/services/generalist-stream.service.ts`   | Handles streaming from SDK                          |

### Tools & Approval

| Module                     | File                                                   |
| -------------------------- | ------------------------------------------------------ |
| Tool Approval              | `src/main/services/tool-approval.service.ts`           |
| Control Actions            | `src/main/services/control-actions.tool.ts`            |
| Specialist Control Actions | `src/main/services/specialist-control-actions.tool.ts` |
| Code Graph Tool            | `src/main/services/code-graph.tool.ts`                 |
| Semantic Search Tool       | `src/main/services/semantic-search.tool.ts`            |
| Git Context Tool           | `src/main/services/git-context.tool.ts`                |
| GitHub Context Tool        | `src/main/services/github-context.tool.ts`             |
| Task Context Tool          | `src/main/services/task-context.tool.ts`               |
| Checkpoint Context Tool    | `src/main/services/checkpoint-context.tool.ts`         |

### Services (Business Logic)

- Elicitation, Cost Tracker, Model Config, SDK Hooks, Hook Engine
- Decomposition, Quality Gate Runner, Task Pipeline, Task Loop
- Memory, Memory Feed, Dream, Skill, Skill Summary
- File Watcher, File Service, Git Worktree, GitHub
- Code Graph, Vector Search, Tech Stack Detector
- Subscription, Auth Provider, Auto-Update, Mermaid, Docs

### Persistence

- 28 repository classes in `src/main/db/repositories/`
- SQLite via better-sqlite3, 64 migrations

### IPC Layer

- 47 IPC handler modules in `src/main/ipc/`
- 170+ channels

### Renderer (Frontend)

- 20 Zustand stores in `src/renderer/src/store/`
- Components by feature: chat, agents, workspace, etc.

---

## 3. Existing Tests & Coverage Gaps

### Current test inventory (verified 2026-04-20)

| Suite            | Runner Script               | Files         | Tests (approx) |
| ---------------- | --------------------------- | ------------- | -------------- |
| Unit (services)  | `run-tests.ts` (20 imports) | 20 files      | ~200+          |
| Repository       | `test:repo`                 | 4 files       | ~40            |
| LLM (live)       | `test:llm`                  | 2 files       | ~10            |
| E2E (Playwright) | manual                      | 2 files       | ~5             |
| **Total**        |                             | **~40 files** | **~355+**      |

### Registered unit test files (run-tests.ts)

```
generalist-migration, execution-pipeline, ipc-pipeline-contracts,
event-sequence, agent-services, mcp-server-service, preprocessing,
description-cache, code-graph-logic, vector-search, code-graph-db,
mcp-tool-wiring, path-traversal, control-actions, code-graph-first-hook,
conversation-state-machine, intent-detector, intent-router,
generalist-circuit-breaker, tool-approval, generalist-prompt-assembler,
cost-tracker, generalist-token-tracker, complexity-scorer, elicitation,
abandonment-detector, scheduling-strategy, semaphore, investigation-detect,
model-config, opus-47-thinking, session-recovery, health-check
```

### Additional test files (not in run-tests.ts)

```
specialist-pool-orchestration, specialist-modules, skill-summary,
prompt-assembler-turn-count, tag-to-chunk-adapter, investigation-report-detection
```

### HIGH-RISK UNTESTED Services (52+ files)

**P0 — Critical (orchestration & SDK):**

- ~~`conversation-state-machine.ts`~~ ✅ covered (Run 2 — 12 tests)
- ~~`intent-detector.ts`~~ ✅ covered (Run 2 — 10 tests)
- ~~`intent-router.ts`~~ ✅ covered (Run 2 — 8 tests)
- ~~`generalist-prompt-assembler.ts`~~ ✅ covered (Run 3 — 10 tests)
- ~~`tool-approval.service.ts`~~ ✅ covered (Run 3 — 10 tests)
- ~~`generalist-circuit-breaker.ts`~~ ✅ covered (Run 3 — 10 tests)

**P1 — High (business logic):**

- ~~`cost-tracker.service.ts`~~ ✅ covered (Run 4 — 10 tests, pure functions)
- ~~`generalist-token-tracker.ts`~~ ✅ covered (Run 4 — 8 tests)
- ~~`complexity-scorer.service.ts`~~ ✅ covered (Run 4 — 10 tests, pure functions)
- ~~`elicitation.service.ts`~~ ✅ covered (Run 4 — 2 tests)
- ~~`abandonment-detector.service.ts`~~ ✅ covered (Run 5 — 12 tests, pure functions)
- `decomposition.service.ts` — DB/SDK-dependent, deferred to integration tier
- `model-config.service.ts` — partially tested, needs expansion
- `specialist-pool.service.ts` — 2975 lines, needs targeted method tests

**P2 — Medium (tools & integration):**

- ~~`specialist/scheduling.ts`~~ ✅ covered (Run 5 — 10 tests, 4 strategies + composite)
- ~~`specialist/semaphore.ts`~~ ✅ covered (Run 5 — 6 tests, async concurrency)
- ~~`specialist/investigation-detect.ts`~~ ✅ covered (Run 5 — 2 tests)
- `code-graph.tool.ts`, `semantic-search.tool.ts`, `git-context.tool.ts`
- `github-context.tool.ts`, `task-context.tool.ts`, `checkpoint-context.tool.ts`
- `specialist-control-actions.tool.ts`
- `quality-gate-runner.service.ts`, `hook-engine.service.ts`
- `generalist.service.ts` — 1479 lines, core coordinator
- `sdk-executor.ts`

**P3 — Lower priority:**

- 24 of 28 repositories untested
- All 47 IPC handlers untested
- All 20 Zustand stores untested

---

## 4. Test Infrastructure Created

### helpers/claude-mock.ts

- `ScriptedClaudeClient` — mock SDK client with scripted steps (text, tool_use, tool_result, thinking, error)
- `createTextOnlyClient()` — simple text response
- `createToolCallClient()` — tool call + result + final text
- `createErrorClient()` — throws during execution

### helpers/agent-factory.ts

- `createMockBrowserWindow()` — captures IPC sends
- `createMockLogger()` — captures log calls
- `createMockEventLoggerService()` — captures event log calls
- `createConversationStateMachine()` — fresh SM with mock window
- `createIntentDetector()` — fresh detector instance
- `createIntentRouter()` — fresh router with mock window
- `createCircuitBreaker()` — fresh circuit breaker
- `createToolApprovalService()` — fresh approval service
- `createTokenTracker()` — fresh GeneralistTokenTracker instance
- `createElicitationService()` — fresh ElicitationService instance
- `createMockConversationRepo()` / `createMockMessageRepo()` — in-memory repos
- `FakeTimerControl` — captures setTimeout for manual advancement

---

## 5. Implementation Sequence

| Run | Focus       | Target                                                      | Est. Tests |
| --- | ----------- | ----------------------------------------------------------- | ---------- |
| 1   | discovery   | This report                                                 | 0          |
| 2   | mocks       | Test helpers (✅ done in this run)                          | 0          |
| 3   | unit (P0)   | conversation-state-machine, intent-detector, intent-router  | 30         |
| 4   | unit (P0)   | generalist-prompt-assembler, tool-approval                  | 27         |
| 5   | unit (P1)   | circuit-breaker, cost-tracker, token-tracker, decomposition | 30         |
| 6   | integration | specialist-pool, sdk-executor, generalist, elicitation      | 45         |
| 7   | e2e         | Core flows with Playwright                                  | 5          |
| 8   | edge_cases  | Edge cases per Phase 5 spec                                 | 20         |

---

## 6. Key Patterns Observed

1. **Test harness**: `test-harness.ts` provides `test()`, `describe()`, `summary()` with counters
2. **Runner pattern**: Each suite has a `run-tests.ts` that imports all test files, last file calls `summary()`
3. **No shared mutable state**: Each test constructs its own service instances
4. **Mocking**: Manual fakes (no framework), using `require()` for dynamic import in helpers
5. **Assertions**: `node:assert/strict` exclusively
6. **Naming**: `<module-name>.test.ts`, descriptive test names with underscores

---

## Summary

```
=== TEST GENERATION RUN SUMMARY ===
Run focus: unit (P1 expansion + P2 specialist internals)
Discovery updated: yes (P1 + P2 sections — 4 new modules covered)
New test files: 4 (Run 5)
New test cases: 30 (Run 5)
Coverage before: ~40% services (390 tests)
Coverage after: ~45% services (420 tests)
All tests passing: yes (420 ✓, 0 failed)
Cassettes added: 0
Remaining high-risk gaps: decomposition (integration), model-config (expansion),
  specialist-pool, generalist.service, sdk-executor, quality-gate-runner,
  24 repos, 47 IPC handlers
Recommended next run focus: P2 expansion — message-bus, rate-limiter, quality-gate-runner
===================================
```
