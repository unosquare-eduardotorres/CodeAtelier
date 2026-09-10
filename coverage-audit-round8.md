# Coverage Audit Round 8 — Remaining MCP Servers + Audit Handlers

**Date:** 2026-09-09 (follows [coverage-audit-round7.md](coverage-audit-round7.md))
**Starting point:** 77.81% lines
**Result:** **78.37% lines** (+0.56 this round; **68.79% → 78.37% = +9.58** across rounds 5–8)
**Typecheck:** ✅ Clean · Orphan check: ✅ OK · Lint: ✅ clean on all touched files
**Final suite state:** 14,475 passed, 20 failed (all pre-existing order-dependent), 0 load failures, all 692 registered test modules loaded

---

## What this round did

### 1. code-analysis-server.ts: 38% → 75.1% (13 tests)

The last big MCP server. All seven tool handlers now execute: the library-doc
pair (`resolve_library_id`, `query_library_docs`) against a fake
`LibraryDocService`, and the analysis family with **real** runs —
`analyze_complexity` scoring a Python fixture through tree-sitter and a repo
TypeScript file through ESLint, `eslint_check` in summary/full formats,
`eslint_fix` on a temp file (writes confined to tmpdir), `eslint_rules`, and
`audit_scan`. Production change: `registerTools()`/`registerEslintTools()`
exported (they previously only ran under `main()`).

Harness notes captured in the test file: `mockService` needs `setupFullMock()`
(the interception), not bare `setupElectronStub()`; and `registerTools()` is
async, so its capture patch runs in a prelude whose registrations merge into
the shared capture map.

### 2. process-manager-server.ts: 40.2% → 68.3% (5 tests)

A real process lifecycle through the five tool handlers in a temp workspace:
`run_background` spawns a short-lived `node -e` process (allowlist rejection
covered too), `check_process` reads it, `wait_process` returns exit code 0 with
the captured log line, `list_processes` lists it, `stop_process` answers for an
already-exited pid, and unknown pids report not-found. (Tool arg is `pid`, not
`processId` — the schema says so.)

### 3. audit.ipc.ts: 39.7% → 45.7% (14 tests)

The existing audit IPC tests are largely vacuous (`r.ok === true ||
r.ok === false`). New real handler coverage: the **stale-running
reconciliation** on `audit:getLatest` (in-flight tracks cancelled, `partial`
vs `cancelled` derived from completed tracks), history/delete/cancel,
`getPlans`/`generatePlan` argument flow, `exportMarkdown` writing an actual
health report through a mocked save dialog, the no-plan/no-run guards, and the
`rerunTrack` refusal guards. The remaining ~680 uncovered lines are the big
`AUDIT_START` streaming orchestration — a round of its own.

One integration trap fixed in-file: audit.ipc is loaded by earlier test files
with their own mocks, and a cached module's captured `auditAgentService`
cannot be rebound — the test deletes the require-cache entry and loads a fresh
instance under its own mocks (verified against a simulated preceding load).

## Numbers

| Metric   | R5 start | R6 end | R7 end | R8 end    | Total Δ    |
| -------- | -------- | ------ | ------ | --------- | ---------- |
| Lines    | 68.79%   | 77.28% | 77.81% | **78.37%**| **+9.58**  |
| Functions| 80.47%   | 88.87% | 89.03% | 89.39%    | +8.92      |
| Branches | 78.82%   | 81.19% | 81.20% | 81.03%    | +2.21      |

Run-to-run variance is now visible at the margin (back-to-back full runs read
78.53% and 78.37%): the order-dependent tests land differently per run. That
noise (±0.2) is another argument for the per-file DB reset.

## State of the suite

Same 20 order-dependent failures (19 shared-DB + 2 module-cache; the flaky RRF
test toggles run to run). Zero genuine failures. All 692 modules load.

## The road to 90%

90% lines means covering ~19,700 more of the 169,076 denominator lines. At the
~1,000–1,500 lines a round like this delivers, that is 13+ more rounds of
grind — the efficient path changes:

1. **The five giant services hold ~6,500 uncovered lines together**
   (`blueprint-build` 2,273 · `agent-session` 1,501 · `blueprint-verify` 969 ·
   `chat-stream` 925 · `vector-search` 932). They need deep behavioral test
   campaigns against their existing harnesses — the biggest single lever.
2. **The long tail**: 100+ files between 40–70%, many with existing vacuous
   tests to upgrade (the audit.ipc pattern this round applied).
3. **Auditability wins**: `main-vitals.ts` (296, 0%), `tray-menu.ts` (178, 0%),
   `app-identity.ts` (120, 0%) — Electron main modules testable under the stub.
4. **Denominator hygiene**: if any remaining files are type-declaration-heavy
   or genuinely e2e-only (the way `src/shared/types.ts` already is), excluding
   them the same documented way is more honest than writing dead-weight tests.
