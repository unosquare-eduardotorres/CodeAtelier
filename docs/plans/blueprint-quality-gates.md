# Blueprint Quality Gates & Multi-Model Review Pipeline

> **Tracking file**: this document is the single source of truth for implementation status.
> **Status legend** — each item carries one of: `[ ] pending` → `[C] coded` → `[V] verified` (tests green) → `[A] audited` (reviewed by a second model/human). Update the status inline as you work. **Work strictly bullet-by-bullet; never start a milestone with a prior milestone below `[V]`.**

## Resolved at implementation time

- `CURRENT_SCHEMA_VERSION` in `src/main/db/index.ts` was **147** at the start of this work (memory values 85/94/120 were all stale).
- Test runners: `src/main/services/__tests__/run-tests.ts` (unit) and `src/main/db/repositories/__tests__/run-tests.ts` (repo) are the executed entrypoints; `src/main/__tests__/run-all.ts` is the coverage aggregator. New tests must be registered in **run-tests.ts AND run-all.ts**.

## Vision (context for any session picking this up)

Extend the Blueprint pipeline (`specify → clarify → plan → tasks → review → build → verify`) with a layered verification stack so that a cheap builder model (e.g. Qwen 27B) can produce Opus-grade output, and so that even all-Opus runs get decorrelated external review:

- **Layer 2 — deterministic gates** (kernel-owned, post-session): write-set, stub scan, test integrity, lint, build, tests with red→green proof. Verdicts: `pass` / `fail` / `unverifiable`. **`unverifiable` NEVER becomes `fail`** — it warns, continues, and taints the final blueprint status. A failing test is always `fail`, never `unverifiable`.
- **Layer 3 — peer review** (optional, cheap model, per task): checklist-bound, advisory, one round-trip.
- **Layer 3.5 — lead review** (strong model, per task): diff vs ACs; emits mechanical fix packets.
- **Layer 4 — adversarial code review** (new phase, external model e.g. Fable, per blueprint): whole-diff review; findings become fix tasks.
- **Layer 5 — VERIFY extensions**: full suite, smoke, code-graph structural analysis, unverified-items ledger → terminal status taint.
- **Everything model-configurable** as role slots in the existing model routing panel (`ModelRoleMap` in `src/shared/types.ts` already supports cross-provider routing).
- **Escalation ladder** on gate `fail`: builder retries (max 2, with gate evidence) → lead model fixes → still red = hard hold. Bounded worst case.
- **Work packets**: TASKS phase produces per-task briefings (context excerpts, scaffolds, ACs with HOW_VERIFIED, allowed write-set, pre-authored failing tests) so a weak builder never explores.

---

## M0 — Shared types & role-slot foundation

- [V] **M0.1** `src/shared/gate-types.ts`: `GateVerdict`, `GateResult`, `GateReport`, `UnverifiedItem`, `aggregateVerdict`, `boundEvidence`.
- [V] **M0.2** `ModelAction` extended with `'blueprint:peer-review'`, `'blueprint:lead-review'`, `'blueprint:code-review'` + `MODEL_ROLE_ROWS` rows + `DEFAULT_MODEL_CONFIG` entries.
- [V] **M0.3** Off-binding: `ModelRoleAssignment.disabled?: true`; `resolveAssignment` returns `disabled` and `isRoleDisabled()` helper.
- [V] **M0.4** Phase `'code-review'` added (+ migration 148 expanding the `blueprints.status` / `blueprints.current_phase` / `blueprint_phases.phase` CHECK constraints; `advancePhase` now backfills missing phase rows) to `BlueprintPhaseType`, `BLUEPRINT_PHASE_ORDER` (between build and verify), `'code-reviewing'` in `BlueprintStatus`, `PHASE_TO_STATUS`. Exhaustive-record sweep done.
- [V] **M0.5** `sameModelFamily(a, b)` decorrelation helper in `src/shared/model-family.ts`.
- [V] **M0.6** Unit tests `gate-types.test.ts` + `model-family.test.ts`, registered in both runners.

## M1 — Gate command resolution (detect / declare / override)

- [V] **M1.1** `src/shared/gate-command-types.ts`: `GateCommandSet` + provenance + `isSafeGateCommand`/`isSafeGateCwd` injection guards.
- [V] **M1.2** Deterministic toolchain scanner (`detectGateCommands`) in `src/shared/gate-command-detect.ts`, wired through `blueprint-preflight.service.ts`.
- [V] **M1.3** `gate-commands` fenced block parser in `src/shared/blueprint-artifact-parsers.ts` + PLAN prompt contract (`prompts/plan-phase.md`, "Gate Commands" — required for new/blank workspaces).
- [C] **M1.4** Per-workspace `settings_json.gateCommands` override typed on `WorkspaceSettings`; settings UI is M9.5.
- [V] **M1.5** `resolveGateCommands` — precedence override > declared > detected; unresolved ⇒ `unverifiable` / `no_command`.
- [V] **M1.6** Tests for scanner, parser, resolver precedence (27 cases). Registered in both runners.

## M2 — Deterministic gate engine (kernel-owned)

- [V] **M2.1** G4 write-set gate. `evaluateWriteSet` in `src/shared/gate-analysis.ts`; packet test files are exempt (G5 owns them) so one mistake is not reported twice.
- [V] **M2.2** G3 stub scan — scans ADDED DIFF LINES, not whole changed files, so a pre-existing `TODO` cannot fail the task that edited the file.
- [V] **M2.3** G5 test-integrity gate (hash + skip-marker + test-count).
- [V] **M2.4** G2 lint + G1 build/typecheck. Timeout ⇒ `unverifiable` (a slow machine must not burn the retry ladder); missing command ⇒ `unverifiable`/`no_command`.
- [V] **M2.5** G6 task tests with red→green proof. Green BEFORE the session ⇒ `unverifiable`/`vacuous_test`. A test timeout here IS `fail` — a suite that never finished is not green.
- [C] **M2.6** `selectAffectedTestFiles` implemented and tested (packet files + injectable code-graph callers). **NOT wired to the code graph** — see "Known gap" below.
- [V] **M2.7** Persistence: **migration 149** adds `packet_json`, `gates_json`, `unverified_json`, `attempts`, `escalated_to` to `blueprint_tasks` and `unverified_json` to `blueprints`. (Schema 147 → 148 → 149.)
- [V] **M2.8** Wired into the build loop via `executeTaskWithGates`; `BLUEPRINT_TASK_GATES` IPC channel + preload `onBlueprintTaskGates`.
- [V] **M2.9** 19 engine tests (real temp git repos + injected command runner) + 26 pure-analysis tests. Registered in both runners.

## M3 — Work packets (executor-aware TASKS + test-first)

- [V] **M3.1** `BlueprintWorkPacket` + tolerant `extractWorkPacket`, persisted by `blueprint-tasks.service.ts`.
- [V] **M3.2** TASKS prompt: work-packet contract table, test-first requirement, builder-context sizing rules.
- [V] **M3.3** `renderWorkPacket` consumed by `buildTaskContext`; strict wording for local providers.
- [V] **M3.4** No packet ⇒ `unverifiable`/`no_packet`; the legacy `files` field is accepted as the write-set.
- [V] **M3.5** 17 parser + renderer tests. Registered in both runners.

## M4 — Retry & escalation ladder + hold semantics

- [V] **M4.1** `buildGateFixInstructions` — gate name, files, error tail, mechanical instruction. `MAX_BUILDER_ATTEMPTS = 3` (first run + 2 retries).
- [V] **M4.2** `escalateToLead` re-runs the task on `blueprint:lead-review` once (the build adapter gained a `modelAction` override), then the existing failure machinery hard-holds.
- [V] **M4.3** `unverifiable` ⇒ `phaseProgress` warning + ledger append + continue. Never enters the retry ladder.
- [V] **M4.4** Terminal taint is **derived**, not stored: `isCompletedWithWarnings()` = `status === 'complete' && ledger non-empty`. A stored flag could drift from the ledger it describes.
- [C] **M4.5** Attempt accounting done (`recordAttempt`, `setEscalatedTo`, `resetForRetry`). Ladder-transition tests written in R3.2 (`blueprint-gate-ladder.test.ts`) — closed.

## M5 — Peer review (optional cheap-model layer, per task)

- [x] **M5.1** Peer-review runner. (`blueprint-peer-review.service.ts` — dispatched from the build service's gate loop after a task's gates pass, only when `modelConfigService.isRoleEnabled(workspacePath, 'blueprint:peer-review')` (optional role, off unless bound). One cheap-model session reviews the task diff against its work packet; diff is write-set scoped (`packet.allowedFiles ∪ filePathsJson`) with peers' in-flight writes exempt, same attribution contract as the gates. `blueprint-peer-review.adapter.ts` — role `blueprint-review`, `getModelAction() = 'blueprint:peer-review'`, packet + ACs injected via `renderWorkPacket`. `prompts/peer-review-pass.md` carries the four-category rubric.)
- [V] **M5.2** Closed four-category rubric in `task-review-types.ts`; `parsePeerReview` rejects out-of-rubric and non-actionable findings and reports why.
- [x] **M5.3** Structured findings, exactly one fix round-trip, advisory only. (Findings become ONE fix attempt appended to the task's retry ladder via `buildPeerReviewFixInstructions` — not a new wave, not R-tasks, never a loop; bound by `PEER_REVIEW_MAX_ROUNDS = 1`. The fix attempt re-runs the gates; findings that survive are recorded to the unverified ledger (gate `peer-review`, reason `finding_unresolved`) — never block. A pass failure is ledgered (`pass_error`) and the task keeps its passing state.)
- [V] **M5.4** 14 parser tests (shared with M6.3). Registered in both runners.
- [x] **M5.5** Tests. Registered in both runners. (`blueprint-peer-review.test.ts` — 14 tests: findings→advisory-fix mapping, no-R-task contract, one-round bound, no-git ledger path, disabled-role skip, adapter stance, off-rubric rejection integration, goal condition.)

## M6 — Lead review (strong model, per task)

- [x] **M6.1** Post-verify lead-review pass. (`blueprint-lead-review.service.ts` — whole-diff review after verify passes, gated by workspace setting `leadReviewPass` (default OFF, `LeadReviewSection` toggle in Repository settings); diff from `settingsJson.buildBaselineCommit` with merge-base fallback; `blueprint-lead-review.adapter.ts` with `getModelAction() = 'blueprint:lead-review'`; findings parsed by the existing `parseLeadReview`; bounded loop via `settingsJson.leadReviewRound` — pass → R-tasks (collision-safe renumber, MAX_FIX_TASKS=10) → one fix wave → build re-enters verify → round-2 survivors → ledger reason `finding_unresolved` → complete. NOT a pipeline phase: runs under the verify umbrella, appends a `lead-review-pass` artifact to the verify phase record, avoids a DB CHECK migration. `prompts/lead-review-pass.md` carries the seven-category rubric. Verify's success path dispatches the pass instead of completing when the setting is on and the round bound allows.)
- [x] **M6.2** `parseLeadReview` done — `approved` requires the stated verdict AND zero findings, so "approved, but change these four things" cannot ship. Runner + cycle cap delivered with M6.1 (`blueprint-lead-review.service.ts`, `leadReviewRound` bound at 2 rounds).
- [x] **M6.3** Tests. Registered in both runners. (`blueprint-lead-review.test.ts` — 14 tests: findings→R-tasks mapping, round bound, verdict gating, settings-gate semantics, adapter stance, goal condition, artifact persistence.)

## M7 — Adversarial code-review phase (per blueprint)

- [x] **M7.1** `src/main/services/blueprint-code-review.service.ts`. (Whole-feature diff from `settingsJson.buildBaselineCommit` — captured at build start — with merge-base fallback; findings artifact `type: 'code-review'`; advances to verify with pipeline-lock handoff.)
- [x] **M7.2** `blueprint-code-review.adapter.ts` — whole-diff external-reviewer stance. (Diff injected into the phase message; `prompts/code-review-phase.md` added.)
- [x] **M7.3** Findings → fix tasks; max 1 fix wave then re-review once; remainder to ledger. (Severity ≥ high → R-tasks, BP-COLLISION-SAFE-RENUMBER, MAX_FIX_TASKS=10; bound via `settingsJson.codeReviewFixRound`; survivors → ledger reason `finding_unresolved`.)
- [x] **M7.4** State machine & orchestration wiring. (`finalizeSuccess` routes build→code-review when the role is enabled; `create()` snapshots `codeReview`; retry dispatch map has the real dispatch with skip-and-advance fallback.)
- [x] **M7.5** IPC (existing generic phase channels reused).
- [x] **M7.6** `buildCodeReviewGoalCondition`.
- [x] **M7.7** Tests. Registered in both runners. (`blueprint-code-review.test.ts` — 12 tests.)

## M8 — VERIFY extensions

- [x] **M8.1** Full-suite backstop. (Delivered as the P0.2 interim at WAVE level: `runWaveCommandGates` runs the resolved `test` command once per wave after build — closes the "zero tests ran" hole for waves whose tasks declared no per-task test commands. A red suite fails the wave; `no_command` → ledger. The VERIFY-phase full-suite gate remains future work under M8 proper.)
- [x] **M8.2** Smoke gate (missing ⇒ ledger, not failure). (`runVerifyGates` in `blueprint-gates.service.ts` — runs `['full-suite','test']` + `['smoke','smoke']` via the existing `gateCommand`, so a missing smoke command inherits `unverifiable`/`no_command` → ledger for free; red full-suite or red smoke ⇒ `fail`, backstop parity with the wave level. Wired into verify via `runVerifyQualityGates`, which resolves commands through the same override → declared → detected chain the build phase uses — no cache, verify runs once.)
- [x] **M8.3** Structural analysis (new dead code / import cycles ⇒ warnings). (`runStructuralGate` in `blueprint-gates.service.ts` — changed files from `git diff --name-only baseline..HEAD` (baseline = `settingsJson.buildBaselineCommit`, merge-base fallback, same contract as lead-review); budgeted reindex (`indexWorkspace` raced against a 60s budget, overrun/throw ⇒ `unverifiable`/`analysis_unavailable` → ledger); `findDeadCode` filtered to changed files, `findCircularDependencies` filtered to cycles touching changed files. Findings are WARNINGS — verdict `pass` with evidence lines naming each finding; they also surface as warning-severity findings in the verify report. `deps` injectable (codeGraph + git) mirroring the `CommandRunner` seam.)
- [x] **M8.4** Ledger rollup + outcome mapping. (`summarizeLedger` + `blueprintOutcome` in `src/shared/gate-types.ts` — pure functions next to `ledgerItemsFrom`; `isCompletedWithWarnings` stays and the outcome function composes with it. Banner upgrade in `BlueprintDetailView.tsx`: ledger grouped by gate — "Finished UNPROVEN — 7 checks could not be verified (write-set ×4, task-tests ×2, smoke ×1)" — same testid, minimal diff. Verify injects `unverifiedSummary` into the completion payload so the terminal report states what shipped unproven.)
- [x] **M8.5** Tests. Registered in both runners. (`blueprint-verify-gates.test.ts` — 14 tests: smoke missing → ledger not fail; smoke red → fail; full-suite red → fail; structural dead-code/cycle scoping with real temp git repos; graph unavailable → unverifiable; budget overrun → unverifiable (injectable `reindexBudgetMs` seam). `gate-rollup.test.ts` — 13 tests: rollup counts (null/empty/mixed), outcome mapping edge cases, agreement with `isCompletedWithWarnings`. Both registered in run-tests.ts AND run-all.ts.)

## M9 — UI

- [x] **M9.1** Model routing panel rows + off-binding + decorrelation warning. (Row existed in `MODEL_ROLE_ROWS`; `RoleRow` now offers the explicit "Off — skip this layer" option binding `{disabled:true}` and warns when code-review shares the lead-review model.)
- [x] **M9.2** Per-task gate report chips + attempts/escalation badge. (`gatesByTask` in blueprint.store via `onBlueprintTaskGates`, W<n> excluded; `GateVerdictChip` + escalation badge in `TaskRow`.)
- [x] **M9.3** `CodeReviewDeliverable`. (Findings list, verdict banner, severity metrics, fix-task linkage.)
- [x] **M9.4** Unverified-items banner + `code-review` phase rendering. (Amber "Finished UNPROVEN" banner on the detail view; wave-gates evidence in `BuildDeliverable`; `code-review` in phase-config/phase-icons with "(layer off)" on skipped.)
- [x] **M9.5** Gate-command override editor. (`GateCommandsSection` in Repository settings — isSafeGateCommand/isSafeGateCwd client-side validation, provenance display.)

## M10 — E2E, docs, memory

- [x] **M10.1** E2E specs for gates + code-review on/off. (`e2e/blueprint-quality-gates.e2e.ts` — offline shim-driven full pipeline: code-review role OFF → phase record `skipped` + "(layer off)" in the timeline, gate-command editor renders + validates, unverified banner renders when the ledger is non-empty, lead-review toggle persists. `e2e/blueprint-code-review-live.e2e.ts` — live-LLM only: role ON → build → code-review → verify → complete, asserts the phase record `complete`, findings artifact exists, CodeReviewDeliverable renders. Shim extended with plan/tasks/review/build/verify/code-review/lead-review handlers keyed off kickoff-message markers. `electron-live` project testMatch now `*-live.e2e.ts` + the dual-mode clarify-flow spec.)
- [x] **M10.2** Runner registration sweep. (`blueprint-lead-review.test.ts` in both run-tests.ts and run-all.ts; `check-test-orphans` green — 585 on disk, 605 registered.)
- [x] **M10.3** Tracking file statuses + memory proposals. (Statuses updated through M10; 3 memory proposals recorded.)

## Known gap needing a decision (M2.6) — DECIDED: Option 2

`selectAffectedTestFiles` is implemented and tested but **not connected to the code graph**, because the connection would not currently pay off.

Targeting a test run at specific files is runner-specific syntax (`vitest <path>`, `pytest <path>`, `dotnet test --filter`, `npm test -- <path>`). The gate engine deliberately never synthesises it: a wrong guess produces a spawn error indistinguishable from a red test, which would fail correct work. So the engine uses the packet's declared `testCommand` when present and the full resolved test command otherwise — and a code-graph-derived file list has nowhere to go in either branch.

To close this properly, one of:

1. Have the TASKS phase emit a `testCommandTemplate` carrying a `{files}` placeholder, or
2. Add per-ecosystem targeting templates keyed off the detected toolchain, owned by us rather than by the model.

**DECIDED (R3.1): Option 2.** `src/shared/gate-test-targeting.ts` implements `buildTestCommand(toolchain, files)` + `detectTestToolchain(manifests)` beside `gate-command-detect.ts`. Precedence: packet `testCommand` (override) → template (default) → `unverifiable`/`no_command`. The full suite runs only in VERIFY (M8). Toolchains: vitest / jest / pytest / dotnet / go / cargo; each returns `null` when it cannot honestly target the given files rather than disguising a full-suite run.

## Audit R1/R2/R3 — gate-system remediation (2026-01)

Audit verdict: engine sound in isolation, but designed for serial execution while the repo runs parallel waves in one shared worktree. Remediation below; M5+ resumes after R1–R2.

### R1 — safe to run a real blueprint (blocks dogfooding)

- [x] **R1.1 (P0, security)** Packet `testCommand` sanitised: `isSafeGateCommand` applied in `extractWorkPacket` (drop at parse time) + defence-in-depth re-check in `taskTestCommand` (unsafe → `undefined` → G6 `unverifiable`/`no_command` + ledger). Injection strings covered in `work-packet.test.ts` + `blueprint-gates-remediation.test.ts`.
- [x] **R1.2 (P0)** Parallel-wave attribution: `GateTaskContext.exemptFiles` (union of other in-flight tasks' declared files, refreshed at gate time by `refreshExemptFiles` from the wave scheduler's `inFlight` map); `collectChanges` subtracts them exactly like `preexistingDirty` (G4 input + added lines). Per-worktree async mutex (`withWorktreeLock`) around `gateCommand`/`gateTaskTests`/`captureRedProof` — command gates never run concurrently in one tree. Two-task interference tests included.
  - **Accepted limitation 1:** undeclared peer writes are NOT exempted — a peer task that edits files outside its declared write-set still pollutes this task's diff (the exemption is only as good as the declaration). Accepted because the write-set gate (G4) catches the peer's violation on the peer's own grade.
  - **Accepted limitation 2:** peer-edit-induced green proof — a peer's mid-flight edit to THIS task's test files can flip the red proof from `red` to `green` (vacuous) or vice versa between capture and grade. Accepted because the outcome is an honest `unverifiable` (vacuous_test), never a false `fail`; the retry ladder is not burned on it.
- [x] **R1.3 (P0)** Interim code-review skip guard in `advancePhase`: when the next phase is `code-review` and `modelConfigService.isRoleEnabled(workspacePath, 'blueprint:code-review')` is false, the phase record is marked `skipped` and the advance loops to `verify`. Subsumed by M7's dedicated phase service when that lands.
- [x] **R1.4 (P0, interim)** G6 honesty: full-suite fallback removed from `taskTestCommand` (packet `testCommand` or `unverifiable`/`no_command`); `captureRedProof` skips entirely when `packet.testFiles` is empty. Full-suite grading moves to VERIFY (M8).

### R2 — correctness

- [x] **R2.1 (P1)** Gate-command cache invalidation: caches re-resolve whenever a command gate returns `no_command`, and after any task whose declared write-set intersects a toolchain manifest (`package.json`, `Cargo.toml`, `*.csproj`, `pyproject.toml`, `go.mod` — `isManifestFile`). Scaffold-task test included.
- [x] **R2.2 (P1)** Stub-rule narrowing: bare `/{\s*}\s*$/` empty-body rule dropped; `placeholder-return` only fires with a trailing TODO-style comment. False-positive regressions (`const config = {}`, `return []`, `return null` bare) pinned in tests.
- [x] **R2.3 (P1)** Silent degradation: baseline-capture throw now writes a ledger `analysis_unavailable` entry + `phaseProgress` warning (was log-only); `resetForRetry` wired into the `retryPhase` build path (stale gate report / escalation flag cleared; `attempts` stays monotonic); UI shows `max(attempts, 1)` for ran tasks.
- [x] **R2.4 (P2)** `taskGates` forward tagged `'build-event'`; `blueprint-phase-chain.test.ts` / `blueprint-retry.test.ts` fixtures refreshed to 8 phases.

### R3 — loop closure (folds into M-plan)

- [x] **R3.1** Ecosystem test-targeting templates — `buildTestCommand(toolchain, files[])` in `src/shared/gate-test-targeting.ts`, keyed off detected toolchain (vitest/jest/pytest/dotnet/go/cargo). Packet `testCommand` remains the override; template is the default; full suite only in VERIFY. **This decides M2.6: Option 2.**
- [x] **R3.2** `escalateToLead` + ladder-transition tests (`blueprint-gate-ladder.test.ts`): attempt monotonicity, replace-vs-accumulate gate reports, `resetForRetry` semantics, bounded-ladder shape, unverifiable-never-enters. Closes M4.5.
- [x] **R3.3** Wave-level G1/G2: per-task lint/build skipped (`skipCommandGates`) for wave-dispatched tasks; `runWaveCommandGates` runs lint+build once per wave on the settled tree, attributed to the wave (pseudo-task id `W<n>`); `fail` fails the wave, `unverifiable` → ledger + continue.

M5 (peer-review runner), M6 (lead-review runner), M7 (code-review phase service — subsumes R1.3's guard), M8–M10 remain as tracked below.

## Invariants (must never regress)

1. `unverifiable` ≠ `fail` — it warns, continues, taints the terminal status.
2. A failing test is always `fail`, never `unverifiable`.
3. Gates run in the main process, never by the graded agent.
4. Evidence is bounded (≤2000 chars serialized per gate).
5. Optional roles bound off ⇒ the layer/phase is fully skipped.
6. Fix instructions are always mechanical: file / location / change / verification.
