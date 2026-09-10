# Coverage Audit Round 7 — MCP Tool Handlers at Scale + Last 0% IPC Files

**Date:** 2026-09-09 (follows [coverage-audit-round6.md](coverage-audit-round6.md))
**Starting point:** 77.28% lines
**Result:** **77.81% lines** (+0.53 this round; **68.79% → 77.81% = +9.02** across rounds 5–7)
**Typecheck:** ✅ Clean · Orphan check: ✅ OK · Lint: ✅ clean on all touched files
**Final suite state:** 14,442 passed, 21 failed (all order-dependent — see below), 0 load failures, all 689 registered test modules loaded

---

## What this round did

### 1. code-graph-server.ts: 16.4% → 86.1% (18 tests)

The biggest single-file gap among the MCP servers. 15 tool handlers (`graph_map`,
`search_identifiers`, `find_dead_code`, `file_outline`, `find_callers`,
`find_callees`, `find_references`, `file_dependencies`, `file_dependents`,
`symbol_hotspots`, `coupling_analysis`, `circular_dependencies`,
`module_boundary_health`, `shortest_path`, `wiring_check`) now execute for real
via the round-6 capture seam — covering the resolution-sorting, file+line and
symbol dedupe, provenance surfacing, json/markdown renderings, the
`wiring_check` verdict tables, and the unindexed-workspace hint.

One production change: the module-scope
`if (!WORKSPACE_ID) process.exit(1)` moved into `main()`. Importing the module
without the env var used to kill the whole importing process (the same import
side-effect class rounds 5–6 eliminated); production behavior is unchanged —
the server is always spawned with the env var, and a missing one still aborts
at startup inside the guarded `main()`. `registerToolSchemas()` is exported for
tests (it previously only ran under `main()`'s stdio path).

### 2. The last three 0% files → 100% (16 tests)

`btw.ipc.ts` (70 lines), `ultraplan.ipc.ts` (49) and `autofix-pr.service.ts`
(134) had registered tests that never imported them. One new file drives all
three: the `/btw` ephemeral one-shot prompt (context building, `--code`
handling, CLI-failure message), the teleport-back action forwarding
(implement/new-session/cancel → CLI choice 1/2/3, unknown actions ignored),
and the `/autofix-pr` prompt builder (failed checks + review comments + the
clean-PR and branch-detection paths against a real temp git repo).

### 3. Reclassification: the "genuine" flag-off telemetry failure isn't one

`blueprint-session-resume.test`'s "resume / rotation / flag-off / stale" test
passes **standalone** (6/6). Its failure in the shared runs is the same
attachTestDb/shared-DB order dependence as the other 18 repository-family
failures — my round-5/6 reports called it a genuine source/test drift, and
that was wrong. The suite has **zero** genuinely-failing tests; every red test
passes in its standalone runner.

### 4. Failure accounting

20 → 21, but the added failure is `memory-retrieval-fusion`'s
"RRF ranks the expected fact first" — one of the 11 tests that previously
**never ran** (they sat in the truncated run's dropped list). It now executes
(19/19 standalone) and is order-fragile in the shared DB like its siblings.
Net: one more dead test revived; no regressions.

## Numbers

| Metric   | Round 5 start | Round 6 end | Round 7 end | Total Δ    |
| -------- | ------------- | ----------- | ----------- | ---------- |
| Lines    | 68.79%        | 77.28%      | **77.81%**  | **+9.02**  |
| Branches | 78.82%        | 81.19%      | 81.20%      | +2.38      |
| Functions| 80.47%        | 88.87%      | 89.03%      | +8.56      |

MCP-server family now: recall-server 86.6%, jira-server 91.2%,
control-actions-server 76.5%, code-graph-server 86.1% (was 16.4%).

## The one remaining structural problem

All 21 red tests are the same disease in two strains:
1. **19 shared-DB order-dependence** (workspace/app-preference/checkpoint/
   chunk-embedding/mpa-artifact/blueprint-session-resume/memory-retrieval-fusion):
   pass standalone, fail when an earlier file swaps or seeds the shared test DB.
2. **2 module-cache ordering** (ipc-code-changes-p27): a later file's re-mock
   cannot rebind an already-cached module.

The cure for strain 1 is architectural: a per-file DB reset (or fresh `:memory:`
handle) in the unified runner, instead of the process-wide attachTestDb cache.
That single change would take the unified run to effectively 0 failures and
make `test:cov:check` a real gate.

## Where the next points are

1. `blueprint-build.service.ts` — 2,273 uncovered lines (71%)
2. `agent-session.service.ts` — 1,501 (57%)
3. `blueprint-verify.service.ts` — 969 (33%)
4. `blueprint.ipc.ts` — 958 (62%)
5. `vector-search.service.ts` — 932 (32%) · `code-analysis-server.ts` — 828 (38%)
   and `process-manager-server.ts` — 655 (40%) — both fit the MCP capture seam
