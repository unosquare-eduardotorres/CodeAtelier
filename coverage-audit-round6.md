# Coverage Audit Round 6 — Real Tests for Dead Modules

**Date:** 2026-09-09 (follows [coverage-audit-round5.md](coverage-audit-round5.md))
**Starting point:** 76.39% lines (round 5 fixed the unified-runner truncation)
**Result:** **77.28% lines** (+0.89 this round; 68.79% → 77.28% across both rounds)
**Typecheck:** ✅ Clean (node) · Orphan check: ✅ OK · Lint: ✅ clean on all touched files
**Final suite state:** 14,409 passed, **20 failed** (down from 33 — every failure class this round touched is fixed), 0 load failures, all 687 registered test modules loaded

---

## What this round did

Round 5 left four modules at 0% whose registered tests never imported them (the
"coverage theatre" files), plus four stale-API test files failing since the
truncation fix revived them. This round wrote **real** tests for the dead
modules and repaired the stale ones.

### New coverage (previously-0% modules, real handler execution)

| File | Before | After | Tests |
| ---- | ------ | ----- | ----- |
| `src/main/mcp-servers/jira-server.ts` | 0% | **91.2%** | 16 |
| `src/main/mcp-servers/recall-server.ts` | 0% | **86.6%** | 14 |
| `src/main/mcp-servers/control-actions-server.ts` | 0% | **76.5%** | 13 |
| `src/main/ipc/jira.ipc.ts` | 0% | **81.8%** | 21 |
| `src/main/services/jira-attachments.ts` | 0% | **100%** | (via jira.ipc tests) |
| `src/main/ipc/tool-error-reporter.ts` | 26% | **96.5%** | 9 |

The remaining uncovered lines are `main()`/stdio-transport and socket-connected
paths that cannot execute without a live transport.

### The test seam: `mcp-tool-capture.ts`

The repo's MCP servers register tools on a module-scoped, unexported
`McpServer`, and the bundled SDK (1.29.x) ships no in-memory transport — so
`src/main/mcp-servers/__tests__/mcp-tool-capture.ts` patches
`McpServer.prototype.tool` before the module loads, captures every
`(name, description, zodShape, handler)` registration, and
`invokeTool(capture, name, args)` parses args through the registered zod shape
(the SDK applies `.default()` values there — calling the handler raw makes
defaulted fields `undefined`) before invoking the real handler. One production
change was needed: `recall-server.ts`'s `registerToolSchemas()` is now exported
(it only ran inside `main()` before; jira/control-actions register at module
scope and needed no change).

Two unified-run traps these tests had to work around (both documented in the
test files):

1. **tsx dynamic-import interop**: recall-server loads repositories via
   `await import(...)`, which bypasses `setupFullMock`'s `Module._load`
   interception and, entered from the wrong direction, throws a TDZ
   `ReferenceError` on the circular `conversation.repository ⇄
   base-repository` graph. The tests require `db/index` first (the same
   cycle-safe order the repository tests use) and patch the resulting
   singletons' methods directly.
2. **Substring shadowing in `mockService`**: `blueprint-handoff-options.test`
   leaves `mockService('services/blueprint.service', …)` registered forever;
   its key matches jira.ipc's import earlier in the Map than
   `'blueprint.service'`, so jira.ipc received a stub without `.create`.
   jira-ipc-tools now drops that key and registers under both spellings.

### Stale-API test repairs (13 failures → 0)

- `config-ipc-validation.test` — 4 assertions still expected the retired
  `'da-vinci'` fixture; the input is `'specialist'`.
- `ipc-utilities.test` — `formatToolErrorMessage` no longer exists; the block
  now drives the real `reportToolError` against a hermetic collector (and
  covers the suppression branches the old test never reached).
- `github-service-p27.test` — unguarded a neighbor's leaked
  `mockService('github.service')` with `unmockService` (the documented
  process-global map).
- `glm-explicit-provider.test` — restores `WORKSPACE_PATH`/`NODE_OPTIONS`
  after `writeConfig`'s documented env injection (this leak is what armed the
  round-5 process-manager crash).
- `audit-plan.repository.test` — repaired last round, carried forward.

### Bookkeeping

- `blueprint-model-snapshot-refresh.test` was on disk and in the standalone
  unit runner but missing from `run-all.ts` — registered (it contributed zero
  coverage to every unified run).
- All four new test files registered in both `run-all.ts` and
  `run-tests.ts`; `npm run test:check-orphans` is green.

## Known remaining failures (20, all pre-existing)

1. **18 shared-DB order-dependent repository tests** (workspace shadow-routing,
   app-preference, checkpoint, chunk-embedding, mpa-artifact): fail only in
   the unified run's shared database; pass 612/0 under `npm run test:repo`.
   Fixing the class needs a per-file DB reset in the unified runner.
2. **2 module-cache order failures** in `ipc-code-changes-p27.test`: a later
   file's re-mock cannot rebind an already-cached `code-changes.ipc` module.
3. **1 genuine pre-existing failure**: blueprint-session-resume's flag-off
   telemetry row (`reason: 'flag-off'`) is never written by
   `blueprint.service` — fails standalone too.

## Numbers

| Metric   | Round 5 start | Round 5 end | Round 6 end | Total Δ   |
| -------- | ------------- | ----------- | ----------- | --------- |
| Lines    | 68.79%        | 76.39%      | **77.28%**  | **+8.49** |
| Branches | 78.82%        | 81.22%      | 81.19%      | +2.37     |
| Functions| 80.47%        | 88.84%      | 88.87%      | +8.40     |

(Branches wobbled −0.03: the new files add coverable branches to the
denominator faster than the tests cover them; lines and functions both rose.)

## Where the next points are

1. `blueprint-build.service.ts` — ~2,270 uncovered lines (71%)
2. `agent-session.service.ts` — 1,501 (57%)
3. `blueprint-verify.service.ts` — 969 (33%)
4. `blueprint.ipc.ts` — 958 (62%)
5. `vector-search.service.ts` — 932 (32%)

Still nominal-coverage theatre (registered tests that never import the file
they name): `process.ipc.ts` (63 lines — `process-ipc.test` silently skips when
the module fails to load under full-mock), `btw.ipc.ts`, `integrations.ipc.ts`,
`ultraplan.ipc.ts`, `autofix-pr.service.ts`. Same pattern as the four files
fixed this round — each needs its load failure diagnosed or real handler tests
written.
