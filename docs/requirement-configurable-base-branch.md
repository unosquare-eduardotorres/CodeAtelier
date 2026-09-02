# Requirement: an explicit, configurable base branch for blueprint tracks

**Audience:** an engineer or LLM implementing this in Code Atelier. Assumes no prior context.
**Subject app:** Code Atelier (`~/Downloads/AgentStudio`), version 1.0.100, HEAD `4d7686ff`
**Written:** 2026-09-02
**Status:** requirement / proposal. Nothing below is implemented yet.

---

## 1. Summary of the ask

Today the branch a blueprint forks from is **implicit**: it is whatever branch the workspace's
primary git checkout happens to have checked out at the moment the BUILD phase starts. There is
no stored setting for it, and the Settings UI field that looks like one is a read-only mirror.

The requirement is to make the base branch an **explicit, persisted, user-visible setting**, so
that blueprint runs fork from a deliberately chosen branch rather than from an incidental
property of the user's working copy.

---

## 2. Current behaviour (verified against source, not inferred)

### 2.1 Where the base actually comes from

`src/main/services/track.service.ts:655`, inside `ensureTrack`:

```ts
const baseBranch = opts.baseBranch ?? primaryBranch ?? 'main'
```

`primaryBranch` is a **live read of the primary checkout's HEAD** —
`src/main/services/track.service.ts:1004`:

```ts
private async currentBranch(git: ReturnType<typeof simpleGit>): Promise<string | null> {
  try {
    const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim()
    // Detached HEAD reports the literal string "HEAD".
    return branch && branch !== 'HEAD' ? branch : null
  } catch (err) {
    wtLog.warn(`[currentBranch] failed: ${(err as Error).message}`)
    return null
  }
}
```

That base is then used only when the branch does not yet exist —
`src/main/services/track.service.ts:1058`:

```ts
const exists = await this.branchExists(git, branch)
const args = exists
  ? ['worktree', 'add', path, branch]                    // existing branch: CURRENT TIP, base ignored
  : ['worktree', 'add', '-b', branch, path, baseBranch]  // new branch: forks from baseBranch
```

**Consequence:** the base matters exactly once per blueprint — at first worktree creation. After
that the branch exists and its own tip wins.

### 2.2 When it is evaluated

`src/main/services/blueprint-build.service.ts:384` calls `ensureBlueprintTrack(...)` as step 1 of
the BUILD run, right after `markPipelineRunning(workspaceId, blueprintId, 'build')`.

**The clarify, specify, plan and task-creation phases do not touch git.** So the base is captured
at BUILD start — potentially hours or days after the user created the blueprint, and after any
number of unrelated branch switches in their working copy.

### 2.3 What `opts.baseBranch` can already be

`src/main/services/blueprint-track.ts` sets it only in one case:

```ts
if (choice.mode === 'fork') {
  branchName = choice.name ?? autoName
  baseBranch = choice.branch
} else if (choice.mode === 'takeover') {
  if (choice.branch) branchName = choice.branch
  ...
}
```

`choice` comes from `readBranchChoice(blueprint.settingsJson)`. The type
(`src/shared/blueprint-types.ts:266`):

```ts
export type BlueprintBranchMode = 'auto' | 'fork' | 'takeover' | 'primary'

export interface BlueprintBranchChoice {
  mode: BlueprintBranchMode
  /** `fork`: the base to branch from. `takeover`: the branch to work on. */
  branch?: string
  /** `fork` only — overrides the generated branch name. */
  name?: string
}
```

So a **per-blueprint** base already exists, but only under the opt-in `fork` mode. The default
mode is `auto`, which leaves `baseBranch` undefined and falls through to primary HEAD.

### 2.4 The one other override

`resolveAutoForkBase(repoPath)` in `blueprint-track.ts` prefers an integration branch when one
exists **and is genuinely ahead** of the current branch:

- computes `integration = integrationBranchFor(current)` (`landing.service.ts:86`)
- returns `undefined` if that ref does not resolve, or if `current..integration` is 0 commits
- returning `undefined` "restores the old behaviour of forking from primary HEAD"

### 2.5 The UI field is NOT a setting

`src/renderer/src/components/workspace/RepositorySettingsTab.tsx` renders a "Repository & GitHub"
panel showing `Path` and `Branch`. The `Branch` value comes from `RepoInfo.currentBranch`, built
in `src/main/services/repo.service.ts:498`:

```ts
currentBranch = await git.revparse(['--abbrev-ref', 'HEAD'])
```

That is the **same git command on the same path** as `track.service.ts:1004`. The panel is a live
mirror of the checkout, not a stored preference.

Confirmed: there is **no** base-branch field persisted anywhere on the workspace.
`WorkspaceSettings` (`src/shared/types.ts`, ~line 2018) has `gitAutoBranch?: boolean` and
`landingMode?: 'independent' | 'integration'`, but nothing naming a base branch. Tracks do store
`work_tracks.base_branch`, but that is written *after* the fact, recording what was used.

---

## 3. Why this needs to change

### 3.1 Observed harm (real incident, this workspace)

Every blueprint track created in this workspace recorded
`base_branch = feat/open-enrollment-scaffold` — not because anyone chose it, but because the
primary checkout happened to be sitting on that branch. Eleven `work_tracks` rows show it.

A later blueprint (`feature/CHR-21-...`) was created off a stale point for the same reason, and
had to be manually fast-forwarded 105 commits before its build would start from current code. The
correction was invisible in the UI: nothing anywhere said "this run will fork from X".

### 3.2 The failure is silent and mistimed

- Nothing surfaces the base before BUILD starts.
- The gap between blueprint creation and BUILD is arbitrary, so the user's mental model
  ("I created this blueprint while on `main`") can silently diverge from reality.
- A user switching branches for an unrelated reason — reviewing a PR, checking an old branch —
  changes the fork point of every blueprint that has not yet reached BUILD.
- The Settings panel showing `Branch: main` actively invites the misreading that a base has been
  configured. It has not.

### 3.3 Detached HEAD

`currentBranch` returns `null` on detached HEAD, so `baseBranch` falls back to the literal
`'main'` regardless of what the user is working on — a silently wrong base in a repo whose
mainline is `develop`, `master`, or anything else.

---

## 4. Requirements

### R1 — Persist an explicit workspace-level base branch (MUST)
Add a base-branch setting to `WorkspaceSettings` (`src/shared/types.ts`), alongside
`gitAutoBranch` and `landingMode`. It is the default base for every blueprint in the workspace.

- Persisted through `workspaceRepository.getSettings` / the existing settings write path.
- Must survive app restart.
- Must be respected by the shadow-workspace merge if it is a routing-relevant key (see
  `mergeShadowRoutingSettings` in `workspace.repository.ts` — decide explicitly whether this key
  participates; do not leave it accidental).

### R2 — Make it settable in the UI (MUST)
In `RepositorySettingsTab.tsx`, add a base-branch control. It must be **visually distinct from
the existing read-only `Branch` mirror**, which stays (it is useful) but must be relabelled so the
two are not confused — e.g. `Checked out` for the live value, `Base branch for new work` for the
setting.

- Populate from the real branch list. `load-branch-options.ts` and `BlueprintBranchOption`
  (`blueprint-types.ts`) already model selectable branches with `isPrimaryHead` and `heldBy`;
  reuse rather than re-derive.
- Offer a "follow the checked-out branch" option that reproduces today's behaviour, so existing
  users are not forced into a choice.

### R3 — Defined precedence (MUST)
Resolution order for a blueprint's base, highest first:

1. Per-blueprint `BlueprintBranchChoice.branch` when `mode === 'fork'` — existing behaviour, unchanged.
2. Integration branch via `resolveAutoForkBase`, when it resolves and is strictly ahead — existing behaviour, unchanged.
3. **New:** the workspace base-branch setting (R1), when set to an explicit branch.
4. Primary checkout HEAD — today's fallback, now reachable only when the setting says
   "follow checkout" or is unset.
5. `'main'` — last-resort literal, unchanged.

Rationale for putting the new setting *below* 1 and 2: both are deliberate, narrower signals
(an explicit per-run pick; an integration branch that demonstrably carries landed work). Placing
the workspace default above them would silently override intent that already exists.

### R4 — Surface the base before BUILD (MUST)
The resolved base must be visible to the user **before** the build phase starts — on the blueprint
view, in the pre-build confirmation, or both. It must name the branch and the commit it resolves to.

This is the requirement that actually prevents the incident in §3.1. R1–R3 without R4 still leaves
the user unable to notice a wrong base until after the run.

### R5 — Validate at resolution time (MUST)
Before use, verify the resolved base ref exists (`git rev-parse --verify <base>^{commit}`).
On failure: do not silently fall back. Log at warn, surface to the user, and fall through the
precedence chain explicitly. A base branch deleted or renamed after being configured is a normal
occurrence, not an exception.

### R6 — Do not change existing-branch semantics (MUST NOT)
`track.service.ts:1058` must keep using the branch's current tip when the branch already exists.
The base applies only to branch creation. Changing this would silently rewind live work.

### R7 — Record what was used (SHOULD)
`work_tracks.base_branch` already stores the base. Extend it, or add a sibling column, to record
**which rule in the R3 chain supplied it**. Without this, diagnosing "why did it fork from there"
requires re-deriving state that has since changed — exactly the problem that made the original
incident hard to see.

### R8 — Detached HEAD (SHOULD)
When the checkout is detached and no explicit setting applies, do not fall back to the literal
`'main'`. Resolve the repository's actual default branch (e.g. `legacy/HEAD` symbolic ref, or the
remote's default), or refuse and ask. Note this repo's remote default is discoverable:
`git symbolic-ref refs/remotes/<remote>/HEAD`.

---

## 5. Acceptance criteria

1. With the workspace base set to `main` and the checkout on an unrelated branch, a **new**
   blueprint's first BUILD creates its worktree forked from `main`. Verify:
   `git -C <worktree> merge-base --is-ancestor main HEAD` succeeds.
2. Switching the primary checkout between blueprint creation and BUILD does **not** change the
   resolved base, when an explicit setting is in force.
3. With the setting on "follow the checked-out branch", behaviour is byte-identical to today.
4. A per-blueprint `fork` choice still wins over the workspace setting (R3.1).
5. An integration branch that is strictly ahead still wins over the workspace setting (R3.2).
6. A configured base that no longer exists produces a visible warning and a defined fallback,
   never a silent `'main'`.
7. The resolved base and its commit are shown to the user before BUILD begins.
8. An existing branch is still checked out at its own tip, never reset to the base (R6).

---

## 6. Files likely in scope

| File | Why |
|---|---|
| `src/shared/types.ts` (~2018) | add the setting to `WorkspaceSettings` |
| `src/main/db/repositories/workspace.repository.ts` | persistence; decide on shadow-merge participation |
| `src/renderer/src/components/workspace/RepositorySettingsTab.tsx` | the control; relabel the existing mirror |
| `src/main/services/blueprint-track.ts` | precedence chain; currently sets `baseBranch` only for `fork` |
| `src/main/services/track.service.ts` (655, 1004, 1058) | consumes `opts.baseBranch`; leave 1058 semantics alone |
| `src/main/ipc/load-branch-options.ts` | branch list for the picker |
| `src/main/services/repo.service.ts` (498) | source of the read-only mirror; unchanged, but relabelled in UI |
| `src/main/db/index.ts` | migration if R7 adds a column |

---

## 7. Explicit non-goals

- Not changing how landing / integration branches work (`landing.service.ts`).
- Not changing `TRACK_LAND` or `landed_into` behaviour — that is a separate open issue with a
  separate diagnostic; do not bundle them.
- Not auto-updating existing branches to the base. R6 forbids it.
- Not adding per-task or per-phase base selection. Blueprint-level is the unit.

---

## 8. Open questions for the implementer

1. Should the workspace setting be a branch **name** or a "follow checkout" sentinel plus a name?
   A sentinel makes today's behaviour representable and is recommended.
2. Should the setting participate in `mergeShadowRoutingSettings`? Shadow workspaces are created
   per worktree path; a base branch is arguably a parent-workspace property. Decide deliberately.
3. Should a blueprint snapshot the resolved base at **creation** time rather than BUILD time?
   That removes the timing gap in §3.2 entirely, but changes semantics for blueprints that sit in
   `draft` across real branch movement. Worth considering; not specified here.
