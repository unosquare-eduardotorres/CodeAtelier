# Code Atelier improvement plan — derived from the CHR-20 incident

**Audience:** an engineer or LLM implementing these changes. Assumes no prior context.
**Subject app:** Code Atelier (`~/Downloads/AgentStudio`), version 1.0.100, HEAD `4d7686ff`
**Written:** 2026-09-02
**Status:** proposal. Nothing below is implemented.

Every item here was observed in a single working session on one repo
(`~/Downloads/CongruityHR`, an Open Enrollment monorepo driven by Code Atelier blueprints).
Each carries the evidence that produced it. Where a claim is inference rather than
observation, it says so.

Two companion documents already exist and are referenced rather than duplicated:
- `docs/worktree-deps-and-landing-diagnostic.md` — the dependency-linking defect and the
  `landed_into` anomaly, with full evidence.
- `docs/requirement-configurable-base-branch.md` — the explicit base-branch requirement.

---

## The incident, in one paragraph

Blueprint `0038cdec` (CHR-20) produced 58 commits that could not merge: 22 conflicting
files, most `add/add`, because it had rebuilt features that already existed on `main`. Root
cause was a **nine-minute window**. Its branch was created at 07:46:42 from
`feat/open-enrollment-scaffold` @ `bc5e2622`; `main` was updated to `da5f9b5a` at 07:56:07;
the BUILD phase started at 08:32 and recorded `base_branch = main` in the database — then
used the branch's stale tip anyway. The result was a full day of manual reconciliation:
rebase, 21 typecheck errors, 95 failing tests, three deleted suites, and a deleted
duplicate signing endpoint. **Every defect below either caused that or hid it.**

---

## P0 — Would have prevented the incident

### 1. The resolved base is computed, recorded, and then discarded

**Evidence.** `src/main/services/track.service.ts:1058`:

```ts
const exists = await this.branchExists(git, branch)
const args = exists
  ? ['worktree', 'add', path, branch]                    // base IGNORED
  : ['worktree', 'add', '-b', branch, path, baseBranch]
```

For CHR-20 the database recorded `base_branch = main` — correct — while git checked out the
branch at `bc5e2622`. The app's own record contradicted what it did. Confirmed from the
branch reflog: `bc5e2622 … branch: Created from feat/open-enrollment-scaffold`.

**Change.** When the branch already exists at worktree-creation time, compare it to the
resolved base. If the branch has **no commits of its own** (`git rev-list --count
<base>..<branch>` is 0) and the base is ahead, fast-forward the branch to the base before
adding the worktree. This is safe by construction — a branch with no unique commits loses
nothing — and it is precisely the CHR-20 case.

If the branch **does** have its own commits, do not touch it; surface the divergence
(see item 3) and let the human decide.

**Acceptance.**
- Branch exists at an ancestor of the base, no unique commits → worktree opens at the base.
- Branch exists with unique commits → branch untouched, divergence surfaced, run continues.
- Branch does not exist → unchanged (`-b` from base).
- A branch already at or ahead of the base is never rewound.

### 2. Record which rule supplied the base

**Evidence.** `work_tracks.base_branch` said `main`. The tree said `bc5e2622`. Diagnosing
this required reading the branch reflog, by which time the state that produced it was gone.

**Change.** Store the base **commit SHA actually used** alongside the branch name, plus
which precedence rule supplied it (per-blueprint `fork` choice / integration branch /
workspace setting / primary HEAD / `'main'` fallback). A DB column or a JSON blob on the
track row.

**Acceptance.** After any run, "why did this fork from there?" is answerable from the
track row alone, without git archaeology.

### 3. Surface the resolved base before BUILD starts

**Evidence.** Nothing anywhere told the user what CHR-20 would fork from. The Settings
panel's `Branch` field is a live `git revparse --abbrev-ref HEAD` mirror
(`repo.service.ts:498`) — the same command `ensureTrack` uses (`track.service.ts:1004`) —
so it *looks* like a setting and is not one. The user reasonably read it as configuration.

**Change.** Before the build phase runs, show the resolved base **branch and commit**, and
whether the blueprint's branch already exists and where it points. Block or warn when the
branch is behind the resolved base.

This is the single highest-value item. Items 1 and 2 fix the mechanism; this one gives the
human a chance to catch what the mechanism still gets wrong.

**Acceptance.** A user can see, without running git, what the next build will fork from.

### 4. Make the base branch explicit and configurable

Fully specified in `docs/requirement-configurable-base-branch.md`. Summary: there is no
persisted base-branch setting anywhere (`WorkspaceSettings` has `gitAutoBranch` and
`landingMode`, nothing for a base); the base falls through to the primary checkout's HEAD,
which changes whenever the user switches branches for unrelated reasons.

**Observed three times in one session:** the checkout was left on a working branch
(`rebase/chr20-onto-main`) and would have mis-forked the next blueprint each time.

---

## P1 — Hid the problem, or made recovery expensive

### 5. `linkNodeModules` handles only the repo-root `node_modules`

**Evidence.** `src/main/services/track.service.ts:1087`. Full detail in
`docs/worktree-deps-and-landing-diagnostic.md`. The subject repo has a root `package.json`
with **no** `workspaces` key plus independent projects in `apps/enrollment`, `apps/web`,
`connectors/isolved-odata-mcp`. Every new worktree got a root symlink and bare app
directories, and the function **returned `true`** — so the existing warning at line 1102,
whose text is accurate about the consequences, is unreachable.

Manually installing (522 + 792 packages) left both lockfiles byte-unchanged, confirming the
committed lockfiles were correct and nothing was missing from version control.

**Change.** Discover nested projects (a `package.json` with a sibling lockfile is a
defensible heuristic; a bare `package.json` glob wrongly picks up `.opencode/`), link or
install each, and return `false` when any is left bare so the warning fires.

**Correlation, not established as causal:** baseline telemetry records ~40% of build tasks
retrying. A silent missing-dependency failure is a plausible contributor. Nobody has
attributed retries to module-resolution errors in the data — do not present this as a
finding without doing that attribution.

### 6. A failed blueprint strands its commits silently

**Evidence.** Blueprint `8bb7c4de` ("Task 15-16") is `failed`. Its branch held **51 commits
of real, unique feature work** — the portal election workspace, signature capture, CSV and
PDF exports, signed-record views — that existed nowhere else and were nearly written off as
a duplicate snapshot. Auto-landing only fires on completion, so a failed blueprint
correctly does not land; but nothing anywhere said "this failed run is holding 51 commits."

**Change.** When a blueprint reaches a terminal failure state, compute and surface the
commit count its track holds beyond the mainline. A failed run with zero commits is
disposable; a failed run with 51 is an asset at risk.

**Acceptance.** The Tracks/Blueprints view distinguishes "failed, nothing to salvage" from
"failed, holding N commits."

### 7. Landing failures leave no trace

**Evidence and caveats in `docs/worktree-deps-and-landing-diagnostic.md`.** Both call sites
are fire-and-forget (`void autoLandBlueprint(...)`, at `blueprint-verify.service.ts:835`
and `blueprint-lead-review.service.ts:530`) wrapped in a catch that only logs. Two
blueprints reached `complete` **with** tracks and still show no `landed_into`; no track is
marked `conflicted`, no `integration/*` branch was ever created, and there are zero
`[land]` lines in the Electron logs.

**Do not rework `TRACK_LAND` wiring on the strength of the widely-circulated claim that "no
blueprint completion path calls it." That claim is false** — two completion paths call it.
Instrument first (persist a blueprint event or notify on throw), reproduce, then fix.

---

## P2 — Cost real time in this session

### 8. Cross-blueprint conflict detection exists but reasons from stale facts

**Evidence.** During CHR-28's clarify phase, Code Atelier asked a genuinely valuable
question: sibling blueprint `0038cdec` plans a `decision_version`-gated CTE while shipped
code is last-write-wins. Detecting that at all is good. But its **recommended** option was
justified as *"Matches shipped code with no migration"* — and `0038cdec` ships
`011_decision_integrity.py` plus `test_migration_011.py`. It also described the sibling as
*"a plan that has not landed"* when that blueprint had already **built** the feature and was
complete-but-unmerged.

**Change.** When citing a sibling blueprint, read its **artifacts and branch**, not just its
plan. Distinguish `planned` / `built, unmerged` / `merged`, and check for files the sibling
actually adds (migrations especially) before asserting none exist.

### 9. No detection of migration / revision-chain collisions

**Evidence.** Two blueprints independently targeted Alembic revision `011`. CHR-20 shipped
`011_decision_integrity`; CHR-28's plan then specified "Alembic migration 011" again.
Building both forks the chain and `alembic upgrade head` fails with multiple heads. CHR-20
itself carries a commit *"R007 guard the Alembic revision chain against forks"* — the
project already knows this hurts.

**Change.** A cheap pre-build check: parse migration filenames / `revision` and
`down_revision` in the target directory and refuse (or warn loudly) when a planned
migration id already exists on the base, or when two live blueprints target the same id.
Generalizable beyond Alembic to any monotonic-id convention.

### 10. Phase rewind has no general UI

**Evidence.** `blueprint:rewindPhase` exists in `blueprint.ipc.ts:546` and **nothing in the
renderer or preload calls it**. The only reachable path is "Re-plan from scratch" at the
approval gate (`BlueprintApprovalGate.tsx:714`), which hardcodes `rewindToPhase(id, 'plan')`.
The user's own belief — "I can't re-run a given phase, so I'll create a new blueprint" — was
correct, and would have cost an entire blueprint to work around.

**Change.** Expose rewind to any earlier phase. Note `specify` and `clarify` survive a
rewind to `plan`, so a stale clarify answer persists — which is exactly what happened here:
finding f8 recorded "no `decision_version` column" and the codebase had since shipped the
opposite. Rewinding to `clarify` needs to be possible.

### 11. The UI renders stale phase artifacts after a rewind

**Evidence.** Immediately after a successful re-plan, the task list still showed the old
"Alembic migration 011" text. The user reasonably concluded the re-plan had failed. It had
not: the `plan` artifact had been rewritten to `012_wizard_elections` with
`down_revision '011_decision_integrity'`, while the still-`pending` `tasks` artifact
retained 15 references to `010_pairing`. The screen was showing a superseded artifact with
no indication it was superseded.

**Change.** When a phase is `pending` after a rewind, either clear its rendered artifact or
mark it visibly stale. This one is cheap and directly cost debugging time.

---

## Suggested order

1. **Item 3** (surface the base pre-build) — highest value per unit of work; makes every
   remaining base defect visible instead of silent.
2. **Item 1** (fast-forward a commitless existing branch) — closes the actual hole.
3. **Item 5** (`linkNodeModules`) — small, self-contained, removes a silent failure that
   every multi-project repo hits on every worktree.
4. **Item 11** (stale artifact rendering) — cheap, prevents a recurring misdiagnosis.
5. **Item 2** (record base provenance) and **item 7** (surface landing failures) — both are
   instrumentation, and both are prerequisites for diagnosing what is left.
6. **Items 4, 6, 9, 10** — larger, and better decided once the instrumentation exists.
7. **Item 8** — depends on how sibling-blueprint context is assembled; scope it after the rest.

## Non-goals

- Do not rework `TRACK_LAND` / `landed_into` behaviour before item 7's instrumentation
  reproduces the failure. The circulating diagnosis is disproven and would send an
  implementer down the wrong path.
- Do not change `track.service.ts:1058`'s existing-branch semantics beyond the
  no-unique-commits fast-forward in item 1. Using a branch's own tip is correct in general;
  only the commitless case is safe to move.
- Nothing here requires a resident orchestrator LLM or `repomap-mcp`; both were rejected
  with evidence in the existing improvement plan v2 §7.
