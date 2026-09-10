# Coverage Audit Round 9 — Electron Main Modules + Vector-Search Pipeline

**Date:** 2026-09-09 (follows [coverage-audit-round8.md](coverage-audit-round8.md))
**Starting point:** 78.37% lines
**Result:** **79.00% lines** (+0.63 this round; **68.79% → 79.00% = +10.21** across rounds 5–9)
**Typecheck:** ✅ Clean · Orphan check: ✅ OK · Lint: ✅ clean on all touched files
**Final suite state:** 14,494 passed, 20 failed (identical set to round 8 — verified by diff), 0 load failures, all 694 registered test modules loaded

---

## What this round did

### 1. The three 0% Electron main modules → 100 / 92 / 87% (11 tests)

- **app-identity.ts: 0% → 100%.** The name-pinning matrix: dev store name,
  `DEV_USE_PACKAGED_IDENTITY=1` → packaged name, `E2E_USER_DATA` redirect, and
  the legacy-store adoption decision table (dev never adopts; packaged + empty
  canonical + exactly one legacy store → adopts; populated canonical kept; two
  legacy candidates → ambiguous, stays).
- **tray-menu.ts: 0% → 92.1%.** Real menu template built from mocked repos and
  services: bug-count row, workspace submenu with running-status labels,
  informational "Audit running" line, click handlers navigating via
  `webContents.send`, single-click show behavior, and the destroyed-window
  no-op. Required extending the shared electron stub with `Menu`
  (template-capturing `buildFromTemplate`), `app.setName`, and a stateful
  `app.setPath` — additive, benefits every future main-process test.
- **main-vitals.ts: 0% → 87.2%.** A real heartbeat run with injected gauges
  (sessions, retry timers, child procs, fds, blueprint phases) written and
  fsynced to a temp vitals log; asserts the exact gauge fields and that
  `stopVitals()` halts ticking. Signal-handler lines stay uncovered on purpose:
  process-manager-server registers a module-scope `SIGTERM → process.exit(0)`
  listener, so a synthetic `process.emit('SIGTERM')` would kill the whole
  unified run — noted below as a hazard.

### 2. vector-search.service.ts: 31.9% → 64.4% merged (8 tests)

The whole index→search pipeline body was dead. Now driven for real:
`indexProject` over fixture files through the genuine preprocessing pipeline
(heuristic descriptions) with a deterministic fake embedding provider and
mocked repositories; a gated-embedder test that pauses a live run mid-flight,
asserts the `paused` state, resumes, and lets it finish; `loadPersistedIndex`
rebuilding a collection from stored rows and answering `search`/`searchByCode`
off it (with a score ~1 for identical embed text); `hasPersistedIndex`;
checkpoint/pause/resume/cancel; plus direct units for `InMemoryCollection`
(upsert/query/filter/clear) and `cosineSimilarity` (identity/orthogonal/
opposite/mismatch/zero-vector).

Two fixture lessons captured in the file: `mockService` keys are
substring-matched against the module REQUEST — `local-embedding-provider`
(hyphen) silently never matched `local-embedding.provider` (dot), sending
`search()` into its swallow-everything catch; and persisted chunk rows must
carry the full `ProcessedChunk.metadata` object, because `query()` reads
`metadata.filePath` while mapping results.

## Numbers

| Metric   | R5 start | R7 end | R8 end | R9 end    | Total Δ    |
| -------- | -------- | ------ | ------ | --------- | ---------- |
| Lines    | 68.79%   | 77.81% | 78.37% | **79.00%**| **+10.21** |
| Functions| 80.47%   | 89.03% | 89.39% | 89.62%    | +9.15      |
| Branches | 78.82%   | 81.20% | 81.03% | 80.92%    | +2.10      |

Gap to the 90% goal: **18,588 more covered lines** of 169,076.

## Where the next points are (unchanged shape, updated numbers)

1. Giant services: `blueprint-build` (~2,270), `agent-session` (~1,500),
   `blueprint-verify` (~970), `chat-stream` (~925) — deep campaigns.
2. `audit.ipc` START streaming handler (~680 lines).
3. Long-tail upgrades of vacuous tests (the audit.ipc/vector-search pattern).
4. New hazard for the backlog: process-manager-server's module-scope
   SIGTERM/SIGINT → `process.exit(0)` listeners — importing it anywhere makes
   the whole process exit on a polite signal; should move into its guarded
   `main()` like the self-start did.
