# Diagnostic: worktree dependency linking + blueprint auto-landing

**Purpose:** hand-off document for an LLM with no prior context on this investigation.
**Written:** 2026-09-01
**Subject app:** Code Atelier (`~/Downloads/AgentStudio`), version 1.0.100, HEAD `4d7686ff`
**Subject repo under automation:** CongruityHR (`~/Downloads/CongruityHR`; git reports the path as `Congruityhr` — macOS case-insensitive FS, same directory)
**Toolchain:** node v25.9.0, npm 11.12.1, macOS (darwin 25.5.0)

Two independent issues are described. **Issue A is confirmed and reproducible; it is now fixed
(2026-09-02).** **Issue B was mis-analysed by this document's first revision: the diagnosis it
called "demonstrably wrong" is in fact correct for shipped code.** Do not conflate them. Read
the "What is NOT established" sections before proposing fixes.

> **Standing methodological rule, added 2026-09-02 after this document got Issue B backwards:**
> when a document makes a claim about a *released version*, cite `git show HEAD:<file>` (or the
> release tag), never the working tree. The first revision's Issue B rebuttal read uncommitted
> WIP from a concurrent session and attributed it to v1.0.100. The line numbers it quoted —
> `blueprint-verify.service.ts:835`, `blueprint-lead-review.service.ts:530` — are exact matches
> for the *dirty* working tree and match nothing at HEAD. Everything downstream of that one
> mistake was wrong.

---

## Background: how the subject repo is shaped

CongruityHR is a **multi-project repo that is not an npm workspace.** The root
`package.json` has no `workspaces` key. Each app is an independent npm project with its own
`package.json`, its own `package-lock.json`, and its own `node_modules`:

```
./package.json                              # root, name "congruity", NO workspaces key
./apps/enrollment/package.json              # Next.js app, port 3002
./apps/web/package.json                     # Next.js app, port 3000
./connectors/isolved-odata-mcp/package.json
./.opencode/package.json                    # tooling state, not a build target
```

This shape matters for Issue A. Any logic that assumes "one repo, one `node_modules`" is wrong
here, and any fix that assumes "npm workspaces will handle it" is also wrong.

---

## Issue A — `linkNodeModules` only links the repo-root `node_modules` (CONFIRMED)

### Severity
Every blueprint build worktree for a multi-project repo starts with missing dependencies, and
the failure is silent at setup time. Surfaces later as `Cannot find module '<dep>'` inside a
build task, where it reads as a code defect rather than a setup defect.

### The code

`src/main/services/track.service.ts:1087`

```ts
private linkNodeModules(repoPath: string, worktreePath: string): boolean {
  const source = join(repoPath, 'node_modules')
  const target = join(worktreePath, 'node_modules')
  if (!existsSync(source)) return true // nothing to link — not a degradation
  if (existsSync(target)) return true

  try {
    symlinkSync(source, target, 'junction')
    wtLog.info(`[linkNodeModules] linked node_modules into ${worktreePath}`)
    return true
  } catch (err) {
    wtLog.warn(
      `[linkNodeModules] could not link dependencies into ${worktreePath}: ` +
        `${(err as Error).message}. The tree is usable for editing and git, but ` +
        `builds, tests and lint will not run in it until dependencies are installed ` +
        `there (or, on Windows, developer mode / elevated privileges allow the junction).`
    )
    return false
  }
}
```

Called from `track.service.ts` inside `ensureTrack`, immediately after `gitAddWorktree`:

```ts
await this.gitAddWorktree(git, path, branchName, baseBranch)
// Best-effort: a worktree without dependencies is degraded, not broken, so
// a failure here must not abort track creation. It is logged loudly instead.
const linked = this.linkNodeModules(repoPath, path)
```

### Why it fails here
The function models exactly one `node_modules`, at the repo root. It has no concept of nested
projects. For CongruityHR the result is a worktree with:

- `node_modules -> /Users/.../Downloads/Congruityhr/node_modules` (symlink, correct)
- `apps/enrollment/node_modules` — **absent**
- `apps/web/node_modules` — **absent**

Because `apps/*` are separate npm projects, the root symlink does not resolve their
dependencies. `apps/enrollment/package.json` declares `pdf-lib`, `pg`; `apps/web/package.json`
declares `pdf-lib`, `pg`, `nodemailer`, `@azure/storage-blob`. None resolve.

### The reporting defect (arguably the worse half)
The three `return true` paths mean the function reports success in situations where the
worktree is not usable:

1. Root `node_modules` missing → `return true`, commented "nothing to link — not a degradation".
2. Target already exists → `return true`, without checking nested projects.
3. Root symlink succeeds → `return true`, regardless of how many nested projects were left bare.

The `wtLog.warn` at the bottom — the only user-visible signal, and its text is accurate about the
consequences — is unreachable in all three. So the operator gets no warning, and the build agent
discovers the problem as a module-resolution error.

### Observed evidence (2026-09-01)
Worktree created by Code Atelier for blueprint `c4005a82` at
`~/Library/Application Support/Code Atelier/wt/8e2aeb13/feature-CHR-21-3-more-bu-c4005a82`:

```
root node_modules       -> symlink to /Users/.../Downloads/Congruityhr/node_modules   (present)
apps/enrollment/node_modules   NO      pdf-lib: NO
apps/web/node_modules          NO      pdf-lib: NO
```

Merged source files were present and correct in the worktree (`SignedRecordView.tsx`,
`signed-summary-pdf.ts`, `elections-repo.ts`) — this is purely a dependency-provisioning failure,
not a checkout failure.

Manual `npm install` in each app directory (522 + 792 packages) resolved it. Both lockfiles were
left byte-unchanged by the install, confirming the committed lockfiles were already correct and
nothing was missing from version control. `apps/enrollment` typecheck passed afterward.

A previously-built worktree for blueprint `6c854704` **does** have per-app `node_modules` —
consistent with them having been installed during or after that run, not by `linkNodeModules`.

### Reproduction
1. Use a repo with a root `package.json` lacking `workspaces`, plus at least one nested project
   with its own `package.json`/lockfile and a dependency not present at the root.
2. Let Code Atelier create a blueprint build track for it (see "When the worktree is created").
3. Inspect the worktree: root `node_modules` is a symlink, nested `node_modules` are absent.
4. `linkNodeModules` returned `true`; no warning was logged.

### What this analysis missed
One consequence, and it is the kind that turns a fix into a new bug. `hasUncommittedWork`
(`track.service.ts:1027`) filtered the service's own symlink out of `git status` with
`/^\?\?\s+node_modules\/?$/` — **anchored at the repo root.** Add per-project links without
widening that pattern and, in any repo that does not gitignore `node_modules`,
`?? apps/web/node_modules` reads as user work: every worktree is permanently dirty, so no track
is ever clean, so nothing is ever reclaimable and the reaper stops working. The fix is one
regex; missing it would have been a disk-growth regression traced back to the wrong subsystem.

### Resolution (implemented 2026-09-02, `src/main/services/track.service.ts`)
- **`discoverDependencyRoots(primaryPath)`** — bounded walk (depth ≤ 3, ≤ 2000 dirs, never
  descending into `node_modules`, `.git`, `dist`, `build`, `.next`) returning every directory in
  the *primary* tree that has both a `package.json` and a `node_modules`.
- **The `.opencode` caution above was not adopted, deliberately.** This document proposed a
  "is it a real build target?" heuristic (sibling lockfile, referenced by a script). That
  judgement is not needed and is a liability: the rule implemented is *"if the primary tree has
  dependencies there, mirror them"*. One superfluous symlink for `.opencode` costs nothing and
  cannot be wrong; guessing which projects matter can be, and fails silently when it is.
- **`linkNodeModules`** now loops over those roots — the repo root is simply the depth-0 case, so
  single-project repos behave exactly as before. Each link is `symlinkSync(..., 'junction')` in a
  per-project `try`/`catch`, so one Windows privilege failure cannot skip the remaining projects.
  A project the primary has but the checked-out branch does not is **skipped, not created**:
  `mkdir`-ing it would leave an untracked `apps/foo/` reported as `?? apps/foo/`, which the
  `node_modules` filter does not match — the permanently-dirty failure mode again.
- **The reporting defect is fixed.** After linking, the *worktree* is scanned for directories
  with a `package.json` and no `node_modules`; any survivors are named in the warning and the
  function returns `false`. The three silent `return true` paths are gone and the previously
  unreachable `wtLog.warn` is now reachable.
- **`hasUncommittedWork`** regex widened to `/^\?\?\s+(?:.*\/)?node_modules\/?$/`.
- **`unlinkNodeModules`** now unlinks *every* symlinked `node_modules` in the worktree, reusing
  the same bounded walk and keeping the `lstat`-not-`stat` guard. Teardown is
  `rmSync(recursive, force)`; a nested link left behind is exactly the walk into the primary's
  dependencies that rule 4 of this service exists to make impossible.

Four tests in `src/main/services/__tests__/track.service.test.ts` (real git, temp repo): nested
projects are linked and resolve *their own* deps; a bare project makes the function return
`false`; teardown leaves nested primary deps intact; a nested link does not make the tree dirty.
The last one was confirmed to fail against the un-widened regex before being kept.

**Not done:** no `npm install` fallback. The primary checkout had `node_modules` for all four
nested projects, so symlinking covers the reported case completely; auto-installing during track
creation is minutes of blocking network work and a much larger behaviour change. That is the
follow-up for a repo that ever lacks them.

### Possible related signal (correlation only, NOT established as causal)
Baseline telemetry for this app records ~40% of build tasks retrying and ~25% of Claude attempts
needing a recovery nudge. A silent missing-dependency failure is a plausible contributor. **This
is a hypothesis.** Nobody has attributed retries to module-resolution errors in the data. Do not
present it as a finding without doing that attribution.

---

## When the build worktree is created (context needed to reason about both issues)

Confirmed by reading the code:

- `src/main/services/blueprint-build.service.ts:384` calls
  `ensureBlueprintTrack({ blueprintId, workspaceId, workspacePath })` as step 1 of the build run,
  immediately after `blueprintService.markPipelineRunning(workspaceId, blueprintId, 'build')`.
- **The clarify and task-creation phases do not touch git.** The worktree appears at BUILD start.
- `src/main/services/blueprint-track.ts` resolves the branch name and base, then calls
  `trackService.ensureTrack(...)`.
- `src/main/services/track.service.ts:1058` decides how the worktree is added:

```ts
const exists = await this.branchExists(git, branch)
const args = exists
  ? ['worktree', 'add', path, branch]                    // existing branch: uses its CURRENT tip
  : ['worktree', 'add', '-b', branch, path, baseBranch]  // new branch: forks from baseBranch
```

Consequence worth noting for anyone chasing "blueprints fork from a stale point": **if the branch
already exists, `baseBranch` is ignored entirely and the branch's current tip is used.** The
stale-fork window exists only when the branch is created for the first time. This was verified
empirically: a branch manually fast-forwarded to a newer commit before the build phase produced a
worktree at that newer commit.

---

## Issue B — `landed_into` is never populated (the original diagnosis was RIGHT)

### The claim under examination
An earlier analysis (source: a different model, presented as a table of tracks with
`commits ahead` and `landed = never`) concluded:

> `TRACK_LAND` is called from exactly two places: the Tracks UI (`TRACK_LAND` IPC) and chat
> `/complete`. **No blueprint completion path calls it.** So every blueprint forks from the same
> stale point. … 51 commits stranded on task-15-16 alone.

### That claim is correct for shipped code. This document's first revision was wrong.

The first revision asserted that `autoLandBlueprint` exists and is wired into two completion
sites, and concluded "so 'no blueprint completion path calls it' is false". **It read the
uncommitted working tree of a concurrent development session and attributed it to v1.0.100.**

Verified 2026-09-02 against the exact HEAD this document names, `4d7686ff`
(`chore(release): v1.0.100`):

```
$ git grep -n "autoLandBlueprint" HEAD -- 'src/**'
(no output — zero occurrences repo-wide)

$ git grep -n "landOwner" HEAD -- 'src/**'
HEAD:src/main/services/landing.service.ts:236:  async landOwner(      # the definition, and nothing else

$ git grep -n "landingService\.land(" HEAD -- 'src/main/ipc/**'
HEAD:src/main/ipc/track.ipc.ts:113            # TRACK_LAND — Tracks UI, user-initiated
HEAD:src/main/ipc/chat-completion.ipc.ts:248  # chat /complete
```

| First revision's claim | Verified at HEAD `4d7686ff` |
|---|---|
| `autoLandBlueprint` exists in `blueprint-track.ts` | **Absent repo-wide** — 0 occurrences |
| Called from `blueprint-verify.service.ts:835` | 0 occurrences in that file |
| Called from `blueprint-lead-review.service.ts:530` | 0 occurrences in that file |
| "'No blueprint completion path calls it' is false" | It is **true**. `landOwner` has zero callers |
| `landed_into` unset is "a genuine anomaly" | Fully explained — **no shipped code sets it** |

The two landing call sites at HEAD are exactly the two the original claim named. Its list was
complete and its conclusion followed.

**Where the wrong evidence came from.** The cited line numbers are not approximate matches for
the working tree — they are exact:

```
$ git grep -n "autoLandBlueprint" -- 'src/**'          # working tree, uncommitted
src/main/services/blueprint-track.ts:610:export async function autoLandBlueprint(params: {
src/main/services/blueprint-verify.service.ts:835:              void autoLandBlueprint({
src/main/services/blueprint-lead-review.service.ts:530:    void autoLandBlueprint({
```

`autoLandBlueprint` is a *feature being written right now* in a parallel session, not shipped
behaviour. Reading it as released is the whole of the error.

**Corroboration from HEAD itself.** The comment immediately above the one blueprint-capable
landing call at `track.ipc.ts:113` states the gap in the shipped code's own words:

```ts
// The route home for work that is not a chat. A blueprint run owns a branch
// and a worktree exactly like a chat does, but `/complete` only ever knew
// about conversations — so before this, blueprint output had nowhere to go.
```

That route is an IPC handler behind a button in the Tracks UI. **A human has to press it.**
Nothing on the blueprint completion path does.

For the record, the mechanics the first revision described are real and unchanged:
`landIntegration` calls `trackRepository.markLanded(track.id, integrationBranch)`
(`landing.service.ts:440`), the sole writer of `landed_into` alongside `landing.service.ts:353`
(`landIndependent`); repository method `src/main/db/repositories/track.repository.ts:173`. The
error was about *what calls them*, not about what they do.

### One part of the first revision survives: the headline harm has a different explanation
This is worth preserving, because it is still true and it is the one thing the *original* claim
over-reached on.

The "51 commits stranded" branch is `blueprint/task-15-16-8bb7c4de`, owned by blueprint
`8bb7c4de`. Its status in the app database is **`failed`**.

Any auto-landing fires on *completion* — including the `autoLandBlueprint` now being written,
which is gated on `overallStatus` being `passed` or `human_needed`. A failed blueprint correctly
does not land. So that specific branch was stranded by the blueprint failing at verify, and
landing wiring — present or absent — would not have saved it. The original analysis picked the
wrong example for a real defect.

(For the record, that work was not lost: it was manually merged and pushed on 2026-09-01. It
contained 51 unique commits of real feature work. But the *mechanism* that stranded it was
blueprint failure, not landing.)

### The database state, now fully explained
Database state at time of writing (`~/Library/Application Support/Code Atelier/code-atelier.db`):

| blueprint | status | track branch | track status | `landed_into` |
|---|---|---|---|---|
| `8bb7c4de` Task 15-16 | **failed** | `blueprint/task-15-16-8bb7c4de` | active | — |
| `6c854704` CHR-34 +3 more | **complete** | `feature/CHR-34-3-more-build-scene-17-platform` | active | — |
| `05208b44` Task 11-14 | **complete** | `blueprint/task-11-14-05208b44` | active | — |
| `45efdb29` Enrollment Batch 1 | complete | (no track) | — | — |
| `c4005a82` CHR-21 +3 more | building | `feature/CHR-21-3-more-build-scene-6-authorized-contact` | active | — |

Blueprint status counts overall: `complete` 3, `failed` 4, `building` 1, `draft` 1.

`6c854704` and `05208b44` reached `complete` **and** have tracks. The first revision called their
empty `landed_into` "a genuine anomaly". It is not an anomaly and there is nothing left to
investigate: **`landed_into` is empty because no shipped code path writes it for a blueprint.**
`markLanded` is reached only through `landingService.land`, whose only two callers are the Tracks
UI button and chat `/complete`. Neither ran for these blueprints. The table is exactly what the
code predicts.

The corroborating observations the first revision gathered were all consistent with this and were
read as pointing at a failure instead of an absence:

- **No track has status `conflicted`** — all 11 rows in `work_tracks` are `active`. Nothing
  attempted a merge, so nothing conflicted.
- **No `integration/*` branch and no integration worktree exist.** `ensureIntegrationTree` would
  have created one. It was never called.
- **Zero `[land]` log lines** across `main.log` and `main.old.log`. Not log rotation — no landing
  ever started.

Three independent signals of "this code did not run", correctly collected, then explained away as
a silent failure of code that did not exist.

### What is NOT established
- **Whether the WIP `autoLandBlueprint` actually works.** It is unreleased and unexercised here.
  Nothing in this document tests it; the evidence above predates it and says nothing about it.
- Whether landing *should* be automatic on blueprint completion, or should stay a human decision
  with the gap closed by surfacing "this blueprint has N unlanded commits" in the UI instead.
  That is a product call, not a bug fix, and this document does not make it.
- Whether any other owner kind (MPA campaigns) has the same gap. Not examined.

### Recommended next steps for whoever picks this up
1. **The original claim was right; treat blueprint landing as genuinely unwired in v1.0.100.**
   The first revision's instruction not to rework it was based on WIP misread as shipped code.
   Note that the rework is *already underway* in a parallel session (`autoLandBlueprint`), so
   coordinate rather than starting a second implementation.
2. Recommendation “surface `autoLandBlueprint` errors” **already exists in that WIP** — both call
   sites are `void`-ed fire-and-forget wrapping a catch that only logs, with the sound in-code
   rationale that "a merge is not allowed to un-complete a completed blueprint". The rationale is
   right and the consequence still needs handling: a landing failure must leave a persisted
   blueprint event or a notification, not just a log line. Raise it against that branch.
3. Re-verify this document's Issue B conclusions against whatever HEAD is current when you read
   it. It was written across a window in which this exact area was being actively changed.

---

## Summary for a triager

| # | Issue | Status | Action |
|---|---|---|---|
| A | `linkNodeModules` handles only root `node_modules`; reports success anyway | **Confirmed → fixed 2026-09-02** | Done: per-project discovery + linking, `false` when any project left bare, widened dirty-check, nested unlink. 4 tests |
| B | `landed_into` unset on completed blueprints | **Explained — no shipped code writes it** | Original diagnosis confirmed at HEAD `4d7686ff`. Rework already in flight in a parallel session; coordinate, don't duplicate |

The two are unrelated. A was a provisioning bug and is fixed. B is not an anomaly and not an
observability gap — blueprint auto-landing simply does not exist in v1.0.100, which is what the
original analysis said. The one thing that analysis got wrong is the harm it chose to illustrate
with: the 51 stranded commits are explained by a blueprint that failed verification, and no
landing wiring would have saved them.

---

## Revision history

| Date | Change |
|---|---|
| 2026-09-01 | First revision. Issue A confirmed. Issue B's original diagnosis declared wrong. |
| 2026-09-02 | Issue A fixed in `track.service.ts` (+4 tests) and the `.opencode` heuristic rejected with reasons. **Issue B reversed:** the first revision's rebuttal was sourced from an uncommitted working tree and is retracted; the original diagnosis is confirmed against HEAD `4d7686ff`. Methodological rule added at the top. |
