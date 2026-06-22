# Tech Debt Audit — AgentStudio (code-atelier)

_Generated: 2026-06-19 · Scope: `src/` (main, preload, renderer, shared). Git worktrees, `node_modules`, and build output excluded._

## Snapshot

| Metric | Value |
|---|---|
| Source files (.ts/.tsx, excl. worktrees) | 915 |
| Total source lines | ~172,500 |
| Files over 600 lines | 25 |
| Largest file | `src/main/db/index.ts` (2,907 lines) |
| Test files | 197 (all under `src/main`) |
| Renderer tests | 0 (across 269 components) |
| Playwright e2e specs | 0 (harness configured, no specs) |
| Coverage gate | 33% lines / 50% functions / 75% branches |
| `console.*` in prod code | 125 |
| `any` in prod code | 6 (325 total — rest in tests) |
| `eslint-disable` / `ts-ignore` in prod | 53 |
| TODO / FIXME / HACK | 19 |
| CI pipeline | None (`.github/workflows` absent, no pre-commit hooks) |

### What's already healthy (not debt)

These are in good shape and should be protected, not "fixed":

- **Electron security is correctly hardened** — `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true` in `src/main/index.ts`. No `nodeIntegration` leaks.
- **No SQL injection surface** — zero string-interpolated queries; `better-sqlite3` is used with parameterized statements. Raw `db.exec` calls are confined to migrations with static DDL.
- **Strong service-layer test culture** — 197 tests cover the main process (executors, normalizers, state machines, recovery).
- **Modern, current dependencies** — React 19, Electron 41, TypeScript 6, Vite 7, Zod 4. Dependency-version debt is low.
- **Versioned, transactional migration system** with 104 schema versions and a rich `docs/` tree.

---

## Prioritized findings

Priority = (Impact + Risk) × (6 − Effort), each scored 1–5. Higher = do sooner.

| # | Item | Category | Impact | Risk | Effort | **Priority** |
|---|------|----------|:------:|:----:|:------:|:------:|
| 1 | No CI/CD or pre-commit enforcement | Infrastructure | 5 | 5 | 2 | **40** |
| 2 | 125 `console.*` calls bypass the logger | Code | 3 | 3 | 2 | **24** |
| 3 | Placeholder package metadata + no Node `engines` pin | Dependency / Docs | 2 | 2 | 1 | **20** |
| 4 | 24 suppressed `react-hooks/set-state-in-effect` | Code | 3 | 3 | 3 | **18** |
| 5 | Zero renderer/e2e tests; coverage gate at 33% | Test | 4 | 4 | 4 | **16** |
| 6 | God files (db, preload, shared) | Architecture | 4 | 3 | 4 | **14** |
| 7 | 53 prod `eslint-disable` / `ts-ignore` | Code | 2 | 2 | 3 | **12** |

---

### 1. No CI/CD or pre-commit enforcement — Priority 40
**Evidence:** No `.github/workflows`, no `.husky`, no `lint-staged`. The repo ships `lint`, `typecheck`, `test:all`, and `test:e2e` scripts but nothing runs them automatically. `build:mac` is a hand-run shell script.

**Business justification:** Every quality gate the team already built is optional in practice. Broken types, failing tests, or lint regressions can land on the main branch undetected, and releases depend on a developer remembering to run the right command. This is the single highest-leverage fix: it makes every other improvement self-enforcing.

**Effort:** ~2–3 days. A single GitHub Actions workflow running `typecheck → lint → test:all` on PRs, plus a Husky `pre-push` hook for fast local feedback.

### 2. 125 `console.*` calls bypass the logger — Priority 24
**Evidence:** 125 `console.log/warn/error` calls in production code, even though `electron-log` is a dependency and both `src/main/logger.ts` and `src/renderer/src/utils/logger.ts` exist.

**Business justification:** Inconsistent logging means production incidents can't be reliably traced — some output goes to structured, persisted logs and some vanishes to stdout. It directly slows incident response. Mostly mechanical to fix.

**Effort:** ~1–2 days. Codemod `console.*` → the existing logger, then add a lint rule (`no-console`) to prevent regressions.

### 3. Placeholder package metadata + no Node `engines` pin — Priority 20
**Evidence:** `package.json` has `"author": "example.com"` and `"homepage": "https://electron-vite.org"` (scaffold defaults), and no `engines` field pinning Node.

**Business justification:** A quick win. Placeholder metadata is unprofessional in a shipped/auto-updating app, and an unpinned Node version invites "works on my machine" build drift across the team and CI. Trivial effort, removes a class of environment bugs.

**Effort:** ~1–2 hours.

### 4. 24 suppressed `react-hooks/set-state-in-effect` — Priority 18
**Evidence:** `react-hooks/set-state-in-effect` is disabled 24 times across the renderer (plus a handful of `exhaustive-deps`).

**Business justification:** Setting state inside effects is a recognized React anti-pattern that causes extra render passes and, in the worst cases, render loops — a real UX/perf risk in a chat-heavy UI. Suppressing the rule hides the problem rather than fixing it. Worth addressing incrementally as these components are touched.

**Effort:** ~3–5 days, spread across the components as they're modified.

### 5. Zero renderer/e2e tests; coverage gate at 33% — Priority 16
**Evidence:** 197 tests exist but all live under `src/main`. The renderer has 0 tests across 269 components; Playwright is configured but has 0 spec files. The coverage gate is only 33% lines.

**Business justification:** The entire UI layer — the part users actually touch — has no automated safety net, so any renderer change is a manual-QA gamble. A 33% line gate is low enough to pass while large areas stay untested. This is high-value but genuinely large, so it should be phased rather than attempted at once.

**Effort:** Ongoing, ~2–4 weeks phased. Start with smoke/e2e coverage of critical flows (new chat, message send), then unit-test the largest components, then raise the gate in steps.

### 6. God files — Priority 14
**Evidence:** `db/index.ts` (2,907 lines, 104 migrations inline), `preload/index.ts` (2,798 lines exposing 377 `ipcRenderer` bindings), `shared/constants.ts` (2,146), `shared/types.ts` (1,614), `agent-session.service.ts` (1,627). 25 files exceed 600 lines.

**Business justification:** These files are merge-conflict magnets and onboarding obstacles, and the monolithic preload is a large, hard-to-audit IPC surface. Full decomposition is costly, but it contains a clear quick win (see Phase 1): extracting the 104-entry migrations array out of `db/index.ts` is low-effort and immediately shrinks the worst offender.

**Effort:** Migrations extraction ~0.5 day; full preload/db decomposition ~1–2 weeks, best done opportunistically.

### 7. 53 prod `eslint-disable` / `ts-ignore` — Priority 12
**Evidence:** 53 suppressions in production code — mostly `explicit-function-return-type` (12) and `no-require-imports` (12), plus the hooks rules counted in #4.

**Business justification:** Each suppression is a small accountability gap. The `no-require-imports` cases suggest lingering CommonJS in an ESM codebase. Low urgency; clean up alongside the files they live in.

**Effort:** ~2–3 days.

---

## Phased remediation plan

Designed to run alongside feature work, front-loading the cheap, high-leverage items.

**Phase 1 — Guardrails & quick wins (week 1, ~3–4 days)**
- Add GitHub Actions PR workflow: `typecheck → lint → test:all` (#1).
- Add Husky `pre-push` hook (#1).
- Fix `package.json` metadata and add an `engines` Node pin (#3).
- Extract the migrations array from `db/index.ts` into `db/migrations/` (#6, quick-win slice).

**Phase 2 — Consistency cleanup (weeks 2–3, ~3–4 days)**
- Codemod `console.*` → logger and add `no-console` lint rule (#2).
- Triage `eslint-disable`/`ts-ignore`; remove the easy ones, ticket the rest (#7).

**Phase 3 — Renderer safety net (weeks 3–6, phased)**
- Write Playwright e2e for critical flows: new chat, send message, agent handoff (#5).
- Unit-test the largest renderer components, starting with `HealthDetailPanel.tsx`, `NewChatPage.tsx`, `MessageInput.tsx` (#5).
- Raise the coverage gate in steps (33 → 45 → 60% lines) as coverage grows (#5).

**Phase 4 — Structural (opportunistic, ongoing)**
- Fix `set-state-in-effect` violations as components are touched (#4).
- Decompose `preload/index.ts` into domain modules and split the remaining god files (#6).

**Sequencing rationale:** Phase 1 makes all later work self-enforcing and banks cheap wins. Phases 2–4 are ordered by descending priority-per-effort, and the largest items (tests, decomposition) are deliberately incremental so they never block a release.
