# Design Audit — Impeccable-Powered Design Review & Blueprint Handoff

> **Tracking file**: this document is the single source of truth for implementation status.
> **Status legend** — each item carries one of: `[ ] pending` → `[C] coded` → `[V] verified` (tests green) → `[A] audited` (reviewed by a second model/human). Update the status inline as you work. **Work strictly bullet-by-bullet; never start a phase with a prior phase below `[V]`.**
> **Intended execution**: this file is the input brief for a Code Atelier Blueprint run. Paste it (or attach it) as the blueprint description; SPECIFY/PLAN/TASKS decompose the phases below. Phases are ordered by build dependency, not by importance.

## Vision (context for any session picking this up)

Add an **Audit Design** capability parallel to the existing code audit (Workspace Health), powered by the [`impeccable`](https://github.com/pbakaus/impeccable) npm package (design skill pack: 1 skill, 23 commands, 61 deterministic detector rules, Apache-2.0):

- A **wizard** ("what do you want to accomplish") → LLM command preselection → Impeccable-style **command cards** (critique, audit, polish, harden, …) with a combination matrix that blocks nonsense pairs (`bolder`↔`quieter`, `distill`+additive passes) → **scope** selection (whole project vs pages/files).
- A design **run** executes **evaluate-class commands only** (`audit`, `critique`) as agent sessions with Impeccable SKILL.md guidance injected into the prompt, always merged with the **deterministic detector** (`impeccable detect --json`, zero LLM cost). Fix-class commands never execute here — they shape the remediation brief.
- On completion: a **findings report file** written to the workspace (`.impeccable/critique/`, Impeccable's own convention for tracked review artifacts) plus a DB mirror for history/restart.
- **Move to Blueprint**: one blueprint ingesting the report (attached via copy-on-attach) plus a **prefabricated remediation brief** encoding Impeccable's command routing (audit P0s→`harden`, theming/type→`polish`/`typeset`, perf→`optimize`, slop→`polish`/`distill`, copy→`clarify`), with lineage in `settingsJson`. Design-sourced blueprints inject the Impeccable skill layer into BUILD task prompts so fixes apply the same design vocabulary the audit used.
- A new **Design section** in the model configuration (3 role rows: Evaluate / Route / Init).

Integration model is **reference, not copy**: `impeccable` is an exact-pinned production dependency; its skill markdown is read at runtime and injected via the existing SkillPromptComposer pattern; the detector runs as a subprocess. Updates = bump the pin. (Internal tool; Apache-2.0; no license concern.)

## Decision ledger (resolved in interview)

| # | Topic | Decision |
|---|---|---|
| Q1 | Integration model | npm-managed package + prompt injection + detector CLI. No vendoring/copying. Exact pin (upstream ships multiple releases/week: 3.0→3.6 in ~3 months). |
| Q2 | Feature surface | Dedicated **DesignPage** (wizard UX diverges from track toggles) with its own `DESIGN_*` IPC namespace, but **shared audit storage**: `kind` discriminator (`'code' \| 'design'`) on `audit_runs` so AuditRepository, history, results, and handoff machinery are reused, not duplicated. *Alternative rejected: own `design_runs` tables (more migration code, duplicated retention/handoff for marginal isolation).* |
| Q3 | Command cards | 16 selectable commands (2 evaluate + 14 refine) in shared constants with an `incompatibleWith` matrix. Create/new-surface is **not** a card (out of scope). Multi-select = what runs now (evaluate) + what the blueprint brief gets told to do (refine route). |
| Q4 | INIT automation | `init` is interactive by design (interview writing PRODUCT.md) — **not a card, never auto-run**. It becomes an auto-**detected** wizard prerequisite: status chip (ready / missing / stale), one-click guided setup. `document` (DESIGN.md) is a pure code scan → runs unattended after init. Runs without context proceed with a degraded-quality warning. |
| Q5 | Scope | Wizard scope step: whole project vs selected files/dirs, filtered to design-relevant extensions. Default = detected UI source dir. |
| Q6 | Brief + LLM preselect | Step 1 free-text brief with prefabricated example chips. New `design:route` action (cheap model) maps brief → preselected commands + scope hint; deterministic keyword fallback when LLM unavailable. Preselect fills the card step; user confirms/edits. |
| Q7 | Wizard order | Brief → (LLM route in background) → command cards pre-filled & validated → scope → run. |
| Q8 | Model settings | New `design` ModelRoleGroup, 3 rows: **Evaluate** (`design:audit`), **Route** (`design:route`, haiku-class default), **Init** (`design:init`). |
| Q9 | Findings file | Written to `<workspace>/.impeccable/critique/YYYY-MM-DD-<commands>-<scope-slug>.md` (Impeccable's tracked-artifact convention — future `/impeccable` sessions discover it) + full result persisted in DB as source of truth (report regenerable). |
| Q10 | Execution engine | New `DesignAgentService` mirroring `AuditAgentService` (multi-round, coverage-gated `AgentSessionService` sessions); per-command Impeccable guidance as a prompt layer; detector runs for `audit` AND `critique` (Impeccable merges detector output into both) and its findings are deduped in. |
| Q11 | Move to Blueprint | ONE blueprint: description = prefabricated design-remediation brief (goal + command routing table + selected findings inline, severity-ordered); report attached as reference doc via **copy-on-attach** (durable against repo edits mid-pipeline; workspace-file no-copy is the rejected alternative); `settingsJson` = `{ source: 'design', sourceDesignRunId, commandIds, scope, reportPath }`. Mirrors `AUDIT_HANDOFF_TO_BLUEPRINT`. Design-sourced blueprints get skill injection into BUILD. |

## Resolved at implementation time (re-verify, do not trust memory)

- `CURRENT_SCHEMA_VERSION` in `src/main/db/index.ts` — memory values (85/94/100/120/147/157) are all stale records from different eras. Read it; the migration number for this feature is `CURRENT + 1`.
- Test runners: `src/main/services/__tests__/run-tests.ts` (unit) and `src/main/db/repositories/__tests__/run-tests.ts` (repo) are the executed entrypoints; `src/main/__tests__/run-all.ts` is the coverage aggregator with known drift. Register new tests in **both** run-tests.ts AND run-all.ts.
- Impeccable tarball layout (exact SKILL.md path, engine binary location, platform optional deps) — inspect `node_modules/impeccable` after install; candidates: `skill/SKILL.md`, `dist/universal/impeccable/SKILL.md`.
- Detector `--json` output schema (field names, severity level names) — undocumented in full; capture real output once and pin the mapper to it.
- Actual model IDs available in `AVAILABLE_MODELS` (memory disagrees: opus-4-7 vs opus-4-8, sonnet-4-6 vs sonnet-5) — use whatever the `audit` role defaults to as the Evaluate default.

## Verified grounding (seams this plan builds on)

- **Audit orchestration**: `src/main/services/audit-agent.service.ts` (890 lines — per-workspace state, sequential auditors, retry, events `progress`/`result`/`intermediate_findings`/`stream`/`complete`), `audit-coverage-tracker.ts`, `audit-response-parser.ts` (progressive ` ```audit-finding ` + ` ```audit-score ` blocks), `audit-prompt-templates.ts` (**has an unused `skillContent` param — wiring precedent**), `audit-discovery.service.ts`.
- **Audit storage**: `audit_runs` / `audit_results` / `audit_plans` / `audit_finding_handoffs` via `AuditRepository` (10-run retention, CASCADE, dynamic SET updates). `AuditFinding` = `{ id, severity: info|low|medium|high|critical, title, description, filePath?, recommendation? }` (`src/shared/types.ts` ~2287).
- **Blueprint intake**: `blueprintService.create({ workspaceId, title, description, priority, settingsJson })`; copy-on-attach at `src/main/ipc/blueprint.ipc.ts:82–128` (`userData/blueprint-docs/{ws}/{bp}/N-{filename}`, max 50 attachments, 25MB/file); reference docs budget-capped at **50K chars/file** in phase prompts (`blueprint-document-loader.ts:39`); format precedent `src/shared/audit-blueprint-format.ts` (`deriveBlueprintPriority`, `buildAuditBlueprintTitle`, `formatAuditFindingsBrief`); handoff handler precedent `AUDIT_HANDOFF_TO_BLUEPRINT` (`audit.ipc.ts:881–971`, `MAX_BLUEPRINT_FINDINGS = 50`, trusts DB not renderer payload, records envelope + handoff row).
- **Skill injection seam**: `SkillPromptComposer` (`skill-prompt-composer.ts`) — mtime-cached reads, budget tiers (minimal/standard/full, 4K hard cap), `buildBaselineSkillsLayer()` pattern, dev/packaged root split at :313 (`app.isPackaged ? userData : cwd`). Baseline skills live in `.claude/skills/{name}/SKILL.md`.
- **CLI probe pattern**: `runProbeAsync` in `blueprint-preflight.service.ts:313–355` (5s budget, parallel, never throws, Windows `.cmd` via `shell`, timeout ⇒ warn not blocker). `KNOWN_SERVICES` registry is the extension point.
- **Agent sessions**: `runAgenticClaude()` (`agentic-claude-runner.ts`) — `-p`, `--mcp-config`, `--allowedTools`, `--model`, `--max-turns`; **no `--skills` flag exists** — skill content must ride in the prompt.
- **Model config**: `ModelAction` union (`src/shared/types.ts:665`), `DEFAULT_MODEL_CONFIG` + `MODEL_ROLE_ROWS` + `MODEL_ROLE_GROUP_LABELS` (`src/shared/constants.ts:1025/1075/1206`), resolution via `resolveAssignment` (roles → overrides → defaults), optional-role off-binding (`OPTIONAL_MODEL_ROLE_ACTIONS`), UI `ModelRolesSection.tsx` (group sections via `rolesInGroup(group)`).
- **Page wiring**: `HealthPage.tsx` views `landing|configure|active|plan`; tab render in `WorkspaceSettingsContent.tsx:130+`; zustand precedent `audit.store.ts`; handoff hook `health/useAuditHandoff.ts`.
- **Packaging**: prod deps survive `npm prune --omit=dev` (`scripts/build-mac.sh:119+`); `scripts/afterPack.js` prunes "non-essential assets" from copied node_modules (keeps `.js/.mjs/.cjs/.ts/.json`) — **must whitelist the impeccable payload**; `OnlyLoadAppFromAsar: false`.
- **Detector contract**: `impeccable detect --json <target>` — exit `0` clean / `2` findings / `1` failure; JSON on stdout, human output on stderr; honors `.impeccable/config.json` + inline `impeccable-disable` waivers; web files only (html/css/jsx/tsx/vue/svelte/astro/css-modules + configured template extensions); design-system checks unlock only when DESIGN.md exists; `--scope type|layout` domain narrowing available.

## Architecture

```mermaid
flowchart TD
    subgraph REN["Renderer"]
        W["DesignPage wizard<br/>brief - route - cards - scope"]
        RV["RunView + ResultsView<br/>stream, scores, findings"]
        HB["Move to Blueprint button"]
    end
    subgraph MAIN["Main process"]
        RTS["design-route.service<br/>design:route + keyword fallback"]
        REG["DESIGN_COMMANDS catalog<br/>+ validateDesignCommandSet"]
        DAS["DesignAgentService<br/>multi-round, coverage-gated"]
        IDS["impeccable-runtime.service<br/>resolve pkg + SKILL.md + engine"]
        DET["impeccable-detector.service<br/>detect --json to findings"]
        RPT["design-report.service<br/>markdown writer + regen"]
    end
    PKG["node_modules/impeccable<br/>exact pin"]
    DB[("audit_runs kind=design<br/>audit_results")]
    BP["blueprintService.create<br/>copy-on-attach + lineage"]

    W -->|"DESIGN_ROUTE brief"| RTS
    RTS -->|"preselect + rationale"| W
    W -->|"DESIGN_START config"| DAS
    REG --> DAS
    PKG --> IDS
    IDS -->|"skill layer per command"| DAS
    IDS --> DET
    DET -->|"merged, deduped findings"| DAS
    DAS -->|"workspace events"| RV
    DAS --> DB
    DB --> RPT
    RPT -->|".impeccable/critique/*.md"| HB
    HB -->|"DESIGN_HANDOFF_TO_BLUEPRINT"| BP
```

---

## P1 — Foundation: dependency, runtime resolver, packaging

- [ ] **P1.1** `package.json`: add `"impeccable": "3.6.1"` to **dependencies** (exact pin, like `better-sqlite3`). `npm install`; inspect tarball layout and record the real SKILL.md path + engine binary location in this file (see "Resolved at implementation time").
- [ ] **P1.2** NEW `src/main/services/impeccable-runtime.service.ts`:
  - `resolvePackageRoot()` — dev: `process.cwd()/node_modules/impeccable`; packaged: `join(app.getAppPath(), 'node_modules', 'impeccable')` (mirror the dev/packaged split at `skill-prompt-composer.ts:313`).
  - `resolveSkillMarkdown()` — locate SKILL.md from P1.1 findings; mtime-cached read (composer pattern); returns `{ path, content }` or `null`.
  - `resolveDetectorCommand()` — prefer platform engine binary from the package / `node_modules/.bin/impeccable`; **never `npx` in the packaged app** (no Node PATH guarantee); dev-only npx fallback allowed.
  - `checkAvailability()` — `runProbeAsync` pattern (version probe, 5s budget, cached result, never throws) → `{ available, reason? }`.
- [ ] **P1.3** `scripts/afterPack.js`: whitelist `node_modules/impeccable/**` markdown + engine binaries against asset pruning; verify `build-mac.sh` handles the platform-specific optional dep (mirror better-sqlite3 prebuilt platform-strip logic if the engine ships per-platform prebuilts).
- [ ] **P1.4** NEW `src/main/services/__tests__/impeccable-runtime.test.ts` — path resolution (dev/packaged), silent `null` when package missing, availability caching. Register in run-tests.ts + run-all.ts.
- **Verify**: unit tests green; `npm run build && scripts/build-mac.sh`, mount DMG, confirm `node_modules/impeccable` payload intact. **This is a hard gate before P3.**

## P2 — Shared catalog, types, migration, model roles, IPC skeleton

- [ ] **P2.1** `src/shared/constants.ts`: `DESIGN_COMMANDS: readonly DesignCommandDef[]` — 16 entries: evaluate (`audit`, `critique`) + refine (`polish`, `harden`, `optimize`, `distill`, `animate`, `typeset`, `layout`, `bolder`, `quieter`, `colorize`, `delight`, `adapt`, `clarify`, `onboard`). Each: `{ id, name, category: 'evaluate'|'refine'|'simplify'|'harden', description, impeccableCommand, incompatibleWith: DesignCommandId[] }`. Matrix per Impeccable's own philosophy: `bolder`↔`quieter` (two halves of voice, never neutral); `distill` vs additive (`animate`, `colorize`, `delight`, `bolder`); evaluate combines freely with everything. Plus `IMPECCABLE_DESIGN_EXTENSIONS` (html, css, jsx, tsx, vue, svelte, astro, mjs + css-module patterns) and `DESIGN_BRIEF_EXAMPLES` (chips: "I want to animate this user page", "Audit the current UX", "This page feels generic / AI-made", …).
- [ ] **P2.2** NEW pure helper (same file or `src/shared/design-commands.ts`): `validateDesignCommandSet(ids): { valid: boolean; conflicts: [a, b][] }` + `evaluateCommandsSelected(ids)`.
- [ ] **P2.3** `src/shared/types.ts`: `DesignCommandId` (union), `DesignRunConfig { commandIds, scope, brief, llmProvider? }`, `DesignContextStatus { productMd: boolean; designMd: boolean; stale: boolean }`; extend `ModelAction` with `'design:audit' | 'design:route' | 'design:init'`; extend `ModelRoleGroup` with `'design'`; `AuditFinding.source?: string` (`'impeccable-detector'` vs LLM).
- [ ] **P2.4** `src/shared/constants.ts`: `DEFAULT_MODEL_CONFIG` += design actions (evaluate → same default as `audit` role; route/init → haiku/sonnet-class); `MODEL_ROLE_ROWS` += 3 design rows (Evaluate: actions `[design:audit]`; Route: `[design:route]`; Init: `[design:init]`); `MODEL_ROLE_GROUP_LABELS.design = 'Design'`; IPC channels `DESIGN_ROUTE`, `DESIGN_START`, `DESIGN_CANCEL`, `DESIGN_GET_LATEST`, `DESIGN_GET_HISTORY`, `DESIGN_DELETE_RUN`, `DESIGN_CONTEXT_STATUS`, `DESIGN_GENERATE_REPORT`, `DESIGN_HANDOFF_TO_BLUEPRINT` (namespace `design:*`).
- [ ] **P2.5** Migration (next number after current `CURRENT_SCHEMA_VERSION`): `ALTER TABLE audit_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'code'` + index on `(workspace_id, kind)`. Sweep `AuditRepository` read paths to filter `kind = 'code'` (Health) — existing flows must be untouched.
- [ ] **P2.6** NEW `src/main/ipc/design.ipc.ts` — skeleton with `requireObject/requireString` validation mirroring audit.ipc.ts; register in `src/main/ipc/index.ts` `registerAllIpcHandlers()` (currently 49 modules).
- [ ] **P2.7** Tests: `validateDesignCommandSet` matrix cases (valid pairs, each conflict, empty set), catalog integrity (unique ids, symmetric incompatibility), migration round-trip in repo test runner. Register everywhere.
- **Verify**: `npm run typecheck`; unit green; Health e2e still green (kind filter regression).

## P3 — Execution engine

- [ ] **P3.1** NEW `src/main/services/design-agent.service.ts` — mirror `AuditAgentService` structure: per-workspace `{ running, abortController, session }`, sequential command execution (order: detector first, then `critique`, then `audit`), retry (MAX_RETRIES=1), events `progress`/`result`/`intermediate_findings`/`stream`/`complete`. One `audit_results` row per command (`trackId = 'design:<commandId>'`), run row with `kind: 'design'`, `selected_tracks` reused for commandIds, `selected_skills` for `{ brief, scope }`. Reuse `AuditCoverageTracker` + coverage gate; `applicability: 'not-applicable'` when scope has zero design-relevant files.
- [ ] **P3.2** NEW `src/main/services/design-prompt-templates.ts` — per-command system prompt = audit scaffold + **Impeccable layer** (SKILL.md content trimmed to the command's guidance via tiered budgets, hard cap ~6–8K chars) + PRODUCT.md/DESIGN.md contents when present (the context files Impeccable commands expect) + user brief + scope file list. Output contract: same progressive ` ```audit-finding ` / ` ```audit-score ` blocks so `parseAuditResponse` works **unchanged**. Detector summary injected into round-2+ prompts (feedback loop).
- [ ] **P3.3** NEW `src/main/services/impeccable-detector.service.ts` — `runDetection(workspacePath, targets)`: spawn engine `detect --json <targets>`, `cwd = workspacePath` (honors `.impeccable/config.json` + inline waivers), 60s timeout, `windowsHide`; exit 0/2 → parse stdout; 1 → `{ status: 'failed' }` warn-skip. Defensive JSON mapper → `AuditFinding[]` with `source: 'impeccable-detector'`; severity mapping pinned against captured real output.
- [ ] **P3.4** Merge logic in the service: detector findings deduped against LLM findings by `filePath + normalized title prefix`; `skillsUsed += ['impeccable-detector']`; detector output excluded from coverage stats (it is not agent evidence).
- [ ] **P3.5** Wire `DESIGN_START/CANCEL` → service; persist via `AuditRepository`; forward events through `getSessionEventRouter().sendWorkspaceEvent()` (mirror audit.ipc.ts wiring).
- [ ] **P3.6** Tests: templates (layer inclusion per command, budget caps, context-file injection, brief/scope presence), detector mapper (fixture JSONs, exit-code semantics, timeout, dedupe), orchestration with stubbed sessions (event emission, per-command result rows, not-applicable path). Register everywhere.
- **Verify**: unit green; one stubbed run end-to-end produces a completed run row with findings.

## P4 — Wizard UX, model settings section, navigation

- [ ] **P4.1** `ModelRolesSection.tsx`: `const DESIGN_ROLES = rolesInGroup('design')` + section JSX between Quality & Council (Evaluate / Route / Init rows — RoleRow handles persistence automatically; no backend work).
- [ ] **P4.2** NEW `src/renderer/src/store/design.store.ts` — mirror `audit.store.ts` (currentRun, isRunning, progress/result/stream handlers, history, delete).
- [ ] **P4.3** NEW `src/main/services/design-route.service.ts` — one-shot `design:route` call: `{ brief, contextStatus }` → `{ commandIds, scopeHint, rationale }`; deterministic keyword fallback (`animate→animate`, `audit/review→audit+critique`, `bold→bolder`, `generic/slop→critique+distill`, …) when model call fails or times out (10s); **never blocks the wizard** — degrade to no preselect.
- [ ] **P4.4** NEW `src/renderer/src/components/workspace/DesignPage.tsx` + `design/` folder:
  - `DesignLanding` — history via `DESIGN_GET_HISTORY` (kind='design'), empty state, "New Design Audit" CTA (mirror HealthLanding).
  - `DesignWizard` — `BriefStep` (textarea + `DESIGN_BRIEF_EXAMPLES` chips; fires `DESIGN_ROUTE` in background) → `CommandCardsStep` (cards grouped by category, pre-selected from route with rationale line, live `validateDesignCommandSet` conflict badges + disable invalid toggles) → `ScopeStep` (whole-project toggle + extension-filtered file/dir picker defaulting to detected UI dir; design-context status banner from `DESIGN_CONTEXT_STATUS`) → provider toggle → Run.
  - `DesignRunView` — reuse health/ rendering patterns: stream view, score hero (audit: 5 dimension scores; critique: heuristic/persona/slop-verdict parsed from result), findings list with `source` badge for detector findings, per-command sidebar.
  - `DesignRunCard` for history.
- [ ] **P4.5** Navigation: register `design` tab in `WorkspaceSettingsContent.tsx` (alongside `health`), icon + label in the nav config.
- [ ] **P4.6** Preload `window.api` entries for all DESIGN_* channels (mirror audit preload block).
- [ ] **P4.7** E2E (`e2e/design-*.e2e.ts`, claude-shim where needed): wizard happy path, conflict blocking, brief chips, route fallback, history rendering, cancel. Typecheck via `npm run typecheck:e2e`.
- **Verify**: typecheck + unit + e2e green; manual wizard walkthrough.

## P5 — Design context prerequisite (init)

- [ ] **P5.1** `DESIGN_CONTEXT_STATUS` handler (deterministic, no LLM): PRODUCT.md/DESIGN.md presence at root, then `.agents/context/`, then `docs/` (Impeccable's fallback search order); staleness = DESIGN.md mtime older than the N newest in-scope UI files → `stale: true` (doctor-style hint, never blocks).
- [ ] **P5.2** Wizard "Set up design context" step when missing: attended mini-session via `design:init` model action through `AgentSessionService` — agent scans codebase, asks ≤3 questions (rendered as a chat-style card in the wizard, not a raw gate), writes PRODUCT.md (user-confirmed writes only), then `document` behavior runs **unattended** to write DESIGN.md (pure code scan). Pre-fill the scan prompt with workspace metadata we already have (name, description, constitution/CLAUDE.md, detected tech stack).
- [ ] **P5.3** Degraded mode: runs without context proceed; wizard shows a persistent "running without design context — results will be generic" warning chip; detector design-system checks simply stay off (Impeccable native behavior).
- [ ] **P5.4** Tests: status detection (present/missing/monorepo fallback/staleness), degraded-mode banner logic; e2e for banner states.
- **Verify**: fresh scratch workspace → banner → guided init writes both files → banner clears.

## P6 — Report file + Move to Blueprint

- [ ] **P6.1** NEW `src/shared/design-blueprint-format.ts` (mirror `audit-blueprint-format.ts`; pure, unit-testable): `buildDesignBlueprintTitle(commands, scope)`, `deriveBlueprintPriority(findings)` (severity mapping identical to audit), `formatDesignRemediationBrief(run, findings, commands)` — sections: goal statement from user brief; **command routing table** (finding clusters → impeccable fix commands: critical/P0/P1 + a11y → `harden`; theming/typography → `polish` + `typeset`; performance → `optimize`; slop-detector hits → `polish`/`distill`; UX copy → `clarify`; motion → `animate`); selected findings inline severity-ordered (same shape as `formatAuditFindingsBrief`); files-in-scope; note that Impeccable guidance is available to BUILD sessions.
- [ ] **P6.2** NEW `src/main/services/design-report.service.ts` — render full markdown (dimension scores, findings grouped by command, detector section with rule ids, brief, scope, lineage footer) → write `<workspace>/.impeccable/critique/YYYY-MM-DD-<commands>-<scope-slug>.md`; **regenerable from DB** (`DESIGN_GENERATE_REPORT`); path persisted on the run row. Auto-write on run completion.
- [ ] **P6.3** `DESIGN_HANDOFF_TO_BLUEPRINT` handler in `design.ipc.ts` (mirror `audit.ipc.ts:881–971`): fetch run + selected findings **from DB** (trust DB, cap at 50), `blueprintService.create({ title, description: formatDesignRemediationBrief(...), priority, settingsJson: { source: 'design', sourceDesignRunId, commandIds, scope, reportPath } })`, attach report via existing copy-on-attach path, record handoff row + envelope (reuse handoff machinery), navigate to blueprints.
- [ ] **P6.4** BUILD-phase skill injection: when `settingsJson.source === 'design'`, blueprint build-task prompt assembly appends the Impeccable layer + per-command guidance (same injection helper as P3.2) so fixes apply the design vocabulary. Touch point: blueprint prompt/task-context assembly (work-packet build), gated by the lineage marker — zero effect on non-design blueprints.
- [ ] **P6.5** Optional preflight entry: `impeccable` availability probe in `KNOWN_SERVICES` (id `impeccable`, presenceProbe on the resolved binary, `presenceWarnOnly: true`) — surfaces as warning for design-sourced blueprints, never a blocker.
- [ ] **P6.6** Tests: format module snapshots (routing table for each cluster type, priority mapping, empty-findings edge), report writer + regeneration, handoff handler (blueprint created with attachment + lineage + cap enforcement), prompt-injection gating (design vs non-design blueprints). Register everywhere.
- **Verify**: stubbed run → report file exists in workspace → Move to Blueprint → blueprint detail shows attachment + brief; BUILD prompt contains skill layer (assert in test).

## P7 — Registration, gates, hardening

- [ ] **P7.1** Every new test file registered in `src/main/services/__tests__/run-tests.ts` AND synced into `src/main/__tests__/run-all.ts` (known drift issue — unregistered tests silently don't run under `npm run test:cov`).
- [ ] **P7.2** Full gates: `npm run typecheck`, `npm run typecheck:e2e`, `npm run test:unit`, targeted coverage on new files, Health audit e2e regression (kind-discriminator sweep).
- [ ] **P7.3** Packaging re-verification: DMG build → payload present → run one design audit from the packaged app (resolver works from `app.getAppPath()`).
- [ ] **P7.4** One real run on a scratch web workspace (create-class Vite/React sandbox): detector findings present, LLM findings parsed, report written, blueprint created and BUILD prompt injection observed. Optional live-LLM check via the `electron-live` Playwright project (15min timeout pattern).

## Implementation order

P1 → P2 → P3 → P4 (P4.1 parallel with P4.2–P4.6) → P5 → P6 → P7. Each phase exits typecheck+unit green. P1.3/P1.4 packaging gate is a hard checkpoint before any P3 detector work.

## Risks & mitigations

- **afterPack strips skill/binary payload** → explicit whitelist (P1.3) + DMG verification gate.
- **Detector JSON schema drift** (undocumented fields) → exact version pin, defensive parser, severity map validated against captured real output before the mapper is finalized.
- **Upstream release cadence** (3.2→3.6 in days) → exact pin; upgrades deliberate; tarball-layout knowledge isolated in `impeccable-runtime.service.ts`.
- **SKILL.md exceeds prompt budgets** → tiered trimming (composer pattern), per-command section filtering, hard cap; budgets are constants to tune.
- **First-run engine download offline** (launcher fetches binary to `~/.impeccable/bin` on first use) → availability probe → graceful skip; LLM design audit unaffected.
- **Web-only detector vs non-web workspaces** → extension filter + `not-applicable` path (P3.1).
- **`kind` discriminator migration** → default `'code'` keeps every existing flow untouched; both query paths filtered explicitly; Health e2e regression in P2.7/P7.2.
- **Blueprint brief too large** → inline brief capped (severity-ordered findings, same budget discipline as audit brief); full detail lives in the attached report (50K doc budget).
- **`design:route` LLM latency/failure** → 10s timeout, keyword fallback, never blocks the wizard.

## Out of scope (follow-ups, not this blueprint)

- Impeccable Live Mode (browser variant iteration), design hooks (edit-time blocking), browser extension.
- New-surface creation flow (`shape`/new-work classification) — cards cover evaluate + refine only.
- Importing impeccable into the skills table / specialist assignment (existing `SKILL_IMPORT` seam makes this cheap later).
- Standalone detector button; slop catalog UI; `extract` as a card; `document` as a standalone card (reached via the init step only).
- Design → Chat handoff (envelope adapter) — the blueprint path covers the primary flow; chat handoff can reuse the unified HandoffService later.
