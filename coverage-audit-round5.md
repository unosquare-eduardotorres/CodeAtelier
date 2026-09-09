# Coverage Audit Round 5 — Unified Runner Truncation Fix

**Date:** 2026-09-09
**Goal:** +5 points line coverage
**Result:** **+7.60 points** (68.79% → 76.39%), goal exceeded
**Typecheck:** ✅ Clean (node)
**Final suite state:** 14,300 passed, 33 failed (all pre-existing — see "Known remaining failures"), 0 load failures, all 680 registered test modules loaded

---

## Headline finding

The coverage number was never a measurement problem — it was a **silent truncation bug** in the
unified test runner. Two independent defects killed the `test:cov` process partway through the
680-file registry, and every test file registered after the death point contributed **zero**
coverage while the run still printed a plausible summary. Roughly 420 registered test files —
hundreds of already-written, already-registered tests — were dead weight in every coverage run.

Neither defect produced an error message pointing at itself: the sentinel line
`[run-all] all N test modules loaded` was simply absent from the output, and c8 still wrote a
report from whatever had run. Coverage could swing several points on an unchanged tree purely
from timing.

## Root causes and fixes

### 1. Five test files called `summaryAsync()` at module scope without a self-run guard

`summaryAsync()` ends with `process.exit()`. When run-all.ts imports a test file, top-level code
runs — so the first unguarded file in the registry terminated the whole run from inside its own
import (after its internal straggler-wait drained, which let the loop proceed a few hundred more
files before dying, making the death point look arbitrary).

Fixed with the repo's standard guard in all five files:

```ts
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync().catch(...)
}
```

- `src/main/services/__tests__/blueprint-session-resume.test.ts`
- `src/main/services/__tests__/blueprint-retry-correctness.test.ts`
- `src/main/services/__tests__/agent-session-host-surface.test.ts`
- `src/main/services/__tests__/opencode-agent-preflight.test.ts`
- `src/main/services/__tests__/opencode-seed-session.test.ts`

### 2. All nine MCP servers self-started on import — and their failure path calls `process.exit(1)`

Every `src/main/mcp-servers/*-server.ts` ended with a bare `main().catch(...)` at module scope.
Importing the module (as tests do) started the stdio server; if startup failed, the process died.
Concretely: `glm-explicit-provider.test` leaks `process.env.WORKSPACE_PATH = '/repo/glm-e2e-ws'`
into the shared process, and when `process-manager.test` later imported
`process-manager-server.ts`, its module-level `ensureStateDir()` tried to `mkdir` under that
non-existent path and killed the run.

Production spawns these files directly (`cli-mcp-config-writer.ts` passes
`args: [server.js]`), so a `require.main === module` guard preserves the real startup path
exactly while making imports side-effect-free:

- `code-graph-server.ts`, `git-context-server.ts`, `control-actions-server.ts`,
  `code-analysis-server.ts`, `memory-server.ts`, `jira-server.ts`,
  `semantic-search-server.ts`, `process-manager-server.ts`, `recall-server.ts`

### 3. `audit-plan.repository.test` — load failure repaired (schema drift)

The file threw at module scope (`CHECK constraint failed: mode IN ('light', 'deep')`) and so had
never loaded in the unified run. It had also drifted further: stale seed modes (`'full'`,
`'quick'`), a "malformed plan_json" test that the schema's `json_valid(plan_json)` CHECK now
makes unrepresentable, an order-flake from `created_at` 1-second granularity, and — worst —
**no `summary()` call at all**, so its failures exited 0. All fixed; the file now runs 7/7 green
standalone and asserts the CHECK constraint as the (schema-level) regression guard.

### 4. `.c8rc.json`: pure-type modules excluded from the denominator

`src/shared/track-types.ts` (349 lines) and `src/shared/blueprint-snapshot-types.ts` (62 lines)
are 100% type/interface declarations with no runtime code — untestable by construction. Excluded
on the same precedent as the existing `src/shared/types.ts` / `mpa-types.ts` entries.

## Numbers

| Metric   | Before | After  | Δ            |
| -------- | ------ | ------ | ------------ |
| Lines    | 68.79% | 76.39% | **+7.60**    |
| Branches | 78.82% | 81.22% | +2.40        |
| Functions| 80.47% | 88.84% | +8.37        |

Files revived from 0% by the truncation fix (examples): `jira-format.ts` 0→100%,
`jira-list-view.ts` 0→100%, `jira-jql.ts` 0→99.5%, `task-readiness.ts` 0→100%,
`work-packet-parser.ts` 22→100%, `gate-test-targeting.ts` 38→99.3%,
`background-task-watcher.service.ts` 0→80.1%, `recall-helpers.ts` 0→91.6%,
`model-family.ts` 0→83.8%.

## Known remaining failures (33, all pre-existing, none caused by this change)

1. **Unified-run-only DB order dependence (~28)**: repository tests
   (workspace/app-preference/checkpoint/chunk-embedding/mpa-artifact shadow-routing and
   round-trip tests) fail only in the shared-DB unified run and pass 612/0 under
   `npm run test:repo`. This is the unified runner's documented architecture limit (see the
   ordering-constraint comments in `run-all.ts` / `db-test-helper.ts`). A per-file DB reset
   (or fresh `:memory:` handle per repo test file) would fix the class.
2. **Stale-API tests revived from the dead (4)**: `ipc-utilities.test`
   (`formatToolErrorMessage` no longer exported), `github-service-p27.test` (`GitHubService`
   export shape changed), `config-ipc-validation.test` (CORE_AGENT_* validation). The tests
   drifted while they were dead; they need updating to the current APIs.
3. **One genuine pre-existing failure**: `blueprint-session-resume.test` —
   "resume / rotation / flag-off / stale walk through the real ladder" asserts a
   `reason: 'flag-off'` telemetry row that the service no longer writes. Fails standalone too;
   predates this audit (visible in pre-fix logs).

## Where the next coverage points are (priority order)

1. `blueprint-build.service.ts` — 2,273 uncovered lines (71.02%)
2. `agent-session.service.ts` — 1,501 (57.31%)
3. `blueprint-verify.service.ts` — 969 (33.49%)
4. `blueprint.ipc.ts` — 958 (61.76%)
5. `vector-search.service.ts` — 932 (31.92%)

Still at 0% with *nominal* tests that only exercise adjacent helpers (Phase-24 "coverage
theatre" — the registered tests never import the file they name):
`control-actions-server.ts` (516), `jira.ipc.ts` (489), `recall-server.ts` (362),
`jira-server.ts` (294). Writing real tool-handler tests for these four is worth ~1.7k lines
(≈ +1 point).

## Guardrails worth adding (follow-ups)

- Make `run-all.ts` fail loudly when the completeness sentinel doesn't print: a wrapper that
  checks for `all 680 test modules loaded` in the output before trusting `coverage-summary.json`
  (the `coverage-rank.mjs` all-zero guard catches total collapse, not partial truncation).
- A lint/CI rule that rejects unguarded `summary(`/`summaryAsync(` calls at module scope in
  `**/*.test.ts` (the exact defect class fixed here — five instances slipped in silently).
- `glm-explicit-provider.test` should restore `process.env.WORKSPACE_PATH` after mutating it;
  the leaked value poisoned a later module's module-level `process.env` read.
