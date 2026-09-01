/**
 * The track a blueprint run works in.
 *
 * BUILD used to run every one of its (up to six) parallel agents with
 * `cwd = workspace.repoPath` — the branch the *user* is sitting on, with the
 * user's uncommitted edits in it. The only protection was a process-wide lock
 * that serialised blueprint against chat, which bought safety by giving up the
 * parallelism the whole subsystem exists for, and did nothing about the fact
 * that the output landed in someone's working copy either way.
 *
 * A blueprint run now owns a branch and a worktree of its own, exactly like a
 * chat does. The visible consequence is worth naming: build output arrives as a
 * branch you merge, not as edits already sitting in your checkout.
 *
 * BUILD and VERIFY share one track, keyed on the blueprint id — VERIFY has to
 * see what BUILD wrote, and its deterministic quality gates have to run where
 * that code actually is.
 */

import simpleGit from 'simple-git'
import log from 'electron-log'
import { trackService, TrackConflictError } from './track.service'
import { trackRepository } from '../db/repositories/track.repository'
import { workspaceRepository } from '../db/repositories/workspace.repository'
import { blueprintRepository } from '../db/repositories/blueprint.repository'
import type { ExecutionTarget, TrackOwnerKind } from '../../shared/track-types'
import type { BlueprintBranchChoice } from '../../shared/blueprint-types'
import {
  buildBlueprintBranchName,
  readBlueprintBranchName,
  readJiraIssueKey
} from '../../shared/blueprint-branch-name'

const trackLog = log.scope('blueprint-track')

/** Owner kind + id every blueprint phase resolves its execution path by. */
export function blueprintTrackOwner(blueprintId: string): {
  ownerKind: 'blueprint'
  ownerId: string
} {
  return { ownerKind: 'blueprint', ownerId: blueprintId }
}

/**
 * Branch name for a blueprint run.
 *
 * Slug for a human scanning `git branch`, id suffix for uniqueness — two
 * blueprints with the same title are common and must not collide, since git
 * allows a branch in exactly one worktree repo-wide.
 */
export function blueprintTrackBranch(blueprintId: string, title: string | undefined): string {
  const slug = (title || 'blueprint')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
  return `blueprint/${slug || 'run'}-${blueprintId.slice(0, 8)}`
}

/** The work holding a blueprint's branch, when that work is not the blueprint. */
export interface BranchHolder {
  branchName: string
  ownerKind: TrackOwnerKind
  /** `—` for a retained (ownerless) track: the work outlived whatever produced it. */
  ownerId: string
  /** The worktree the branch is checked out in — where writes for it have to land. */
  path: string
}

/** Where a blueprint runs, plus why it is not isolated when it is not. */
export interface BlueprintExecutionTarget extends ExecutionTarget {
  /**
   * Null when the requested branch choice was honoured exactly.
   *
   * Isolation being declined used to be a log line, which meant the user asked
   * for a branch, silently got the shared checkout, and found out when build
   * output appeared in their working copy. Carrying the reason back lets the
   * caller say so.
   */
  reason: string | null
  /**
   * Set ONLY when the fallback to the primary tree was caused by another owner
   * holding this blueprint's branch.
   *
   * Every other fallback — the workspace opted out of auto-branching, the
   * blueprint was set to run in the checkout, the repo has no commits, the
   * checkout is already on the branch — leaves this undefined. Those are
   * legitimate and must keep running; this one is a split brain (R046), where
   * output written in the primary tree can never reach the branch the run's
   * work lives on, so the caller refuses instead of proceeding.
   *
   * A `reason` string cannot carry that distinction: it is prose, and it is set
   * on every fallback.
   */
  heldBy?: BranchHolder
}

/**
 * Refuse to run a phase whose output cannot reach its own branch.
 *
 * Named holder, not a boolean: "the branch is busy" is not actionable, and the
 * whole point of refusing is being able to say who to go and look at — the id
 * below is the one thing the user currently has no way to see from the app.
 */
export function branchHeldElsewhereError(holder: BranchHolder): Error {
  return new Error(
    `Branch ${holder.branchName} is held by ${holder.ownerKind}:${holder.ownerId} at ` +
      `${holder.path}. This phase would run in the workspace checkout instead, so its ` +
      `output could never join that branch and verification would grade a tree the ` +
      `agents never wrote in. Release the branch — end the ${holder.ownerKind} holding ` +
      `it, or set this blueprint's branch choice to takeover — then retry.`
  )
}

/**
 * Who holds `branchName`, when it is not this blueprint.
 *
 * Best-effort: a bookkeeping read failure must not be what decides a run's
 * fate, so a throw here reads as "nobody" and the old degrade-and-run
 * behaviour stands.
 */
function findBranchHolder(
  workspaceId: string,
  blueprintId: string,
  branchName: string
): BranchHolder | null {
  try {
    const holder = trackRepository.findByBranch(workspaceId, branchName)
    if (!holder) return null
    if (holder.ownerKind === 'blueprint' && holder.ownerId === blueprintId) return null
    return {
      branchName,
      ownerKind: holder.ownerKind,
      ownerId: holder.ownerId ?? '—',
      path: holder.path
    }
  } catch (err) {
    trackLog.debug(`[holder] lookup failed for ${branchName}: ${(err as Error).message}`)
    return null
  }
}

/**
 * The branch choice a blueprint was created with.
 *
 * Read defensively: `settings_json` is free-form and every blueprint created
 * before branch selection existed has no `branchChoice` at all — for which
 * `auto` is both the old behaviour and the right answer.
 */
export function readBranchChoice(settings: Record<string, unknown>): BlueprintBranchChoice {
  const raw = settings.branchChoice as Partial<BlueprintBranchChoice> | undefined
  const mode = raw?.mode
  if (mode !== 'fork' && mode !== 'takeover' && mode !== 'primary') return { mode: 'auto' }
  return {
    mode,
    branch: typeof raw?.branch === 'string' && raw.branch ? raw.branch : undefined,
    name: typeof raw?.name === 'string' && raw.name ? raw.name : undefined
  }
}

/**
 * Does this repository have a first commit yet?
 *
 * An unborn HEAD has no branches to fork from and nothing to isolate: git
 * rejects `worktree add -b x <path> <base>` outright. Deliberately not
 * `--quiet`, which would silence stderr — and simple-git only rejects when a
 * failing git wrote something there.
 */
export async function repoHasCommits(repoPath: string): Promise<boolean> {
  try {
    await simpleGit(repoPath).revparse(['--verify', 'HEAD'])
    return true
  } catch {
    return false
  }
}

/** Merge the resolved branch name into a blueprint's settings blob. */
function persistBranchName(
  blueprintId: string,
  settings: Record<string, unknown> | undefined,
  branchName: string
): void {
  blueprintRepository.update(blueprintId, {
    settingsJson: { ...(settings ?? {}), branchName }
  })
}

/**
 * Name a blueprint's branch, and create the ref, when the run starts.
 *
 * The branch used to appear at BUILD — three phases and often an hour after the
 * user pressed Start — which meant that for most of a run there was no answer
 * to "where is this work going?", and the status bar's workspace branch filled
 * the gap with the wrong one.
 *
 * Only the ref is created: `git branch <name>`, never a checkout and never a
 * worktree. That is the chat precedent, it costs milliseconds, and it leaves
 * the shared HEAD where it is — moving it would redirect anything else running
 * in the primary tree. The worktree still materialises at BUILD.
 *
 * Returns the reserved name, or null when this workspace/blueprint should not
 * have one. Never throws: a run must not fail because a ref could not be made.
 */
export async function reserveBlueprintBranch(params: {
  blueprintId: string
  workspaceId: string
  workspacePath: string
}): Promise<string | null> {
  const { blueprintId, workspaceId, workspacePath } = params

  try {
    // Same three opt-outs `ensureBlueprintTrack` applies, for the same reasons.
    const settings = workspaceRepository.getSettings(workspaceId)
    if (settings.gitAutoBranch === false) return null

    const blueprint = blueprintRepository.findById(blueprintId)
    if (!blueprint) return null

    // Idempotent: a resumed or restarted blueprint keeps the name it already
    // has, because that is the name its track (and possibly its commits) use.
    const existing = readBlueprintBranchName(blueprint.settingsJson)
    if (existing) return existing

    const choice = readBranchChoice(blueprint.settingsJson ?? {})
    if (choice.mode === 'primary') return null
    if (!(await repoHasCommits(workspacePath))) return null

    // Takeover names nothing new — the whole point is to inherit a branch that
    // exists, with whatever its current holder left in the tree.
    if (choice.mode === 'takeover' && choice.branch) {
      persistBranchName(blueprintId, blueprint.settingsJson, choice.branch)
      return choice.branch
    }

    const git = simpleGit(workspacePath)
    const local = await git.branchLocal()
    const taken = new Set<string>(local.all)
    for (const track of trackRepository.findByWorkspace(workspaceId)) {
      if (track.branchName) taken.add(track.branchName)
    }

    const baseBranch = choice.mode === 'fork' ? choice.branch : undefined
    const branchName =
      choice.mode === 'fork' && choice.name
        ? choice.name
        : buildBlueprintBranchName({
            title: blueprint.title,
            jiraIssueKey: readJiraIssueKey(blueprint.settingsJson),
            blueprintId,
            taken
          })

    if (local.all.includes(branchName)) {
      trackLog.info(`[reserve] blueprint ${blueprintId} reuses existing branch ${branchName}`)
    } else {
      await git.raw(baseBranch ? ['branch', branchName, baseBranch] : ['branch', branchName])
      trackLog.info(`[reserve] blueprint ${blueprintId} → ${branchName} (created, not checked out)`)
    }

    persistBranchName(blueprintId, blueprint.settingsJson, branchName)
    return branchName
  } catch (err) {
    trackLog.warn(
      `[reserve] blueprint ${blueprintId}: could not reserve a branch ` +
        `(${(err as Error).message}) — BUILD will resolve one instead`
    )
    return null
  }
}

/**
 * Give a blueprint run its own working tree, or say why it could not have one.
 *
 * Never throws. Every failure mode here — the workspace opted out of branching,
 * the branch is held by other work, the repo has no commits, git refused —
 * degrades to the primary tree, which is exactly where blueprints ran before
 * this existed. Failing the whole BUILD phase because a worktree could not be
 * created would be a regression; running in the shared tree is merely the old
 * behaviour, and the caller takes the primary-tree lock when `isolated` comes
 * back false.
 */
export async function ensureBlueprintTrack(params: {
  blueprintId: string
  workspaceId: string
  /** The workspace's primary tree. Stays the workspace identity key throughout. */
  workspacePath: string
}): Promise<BlueprintExecutionTarget> {
  const { blueprintId, workspaceId, workspacePath } = params
  const primary = (reason: string | null, heldBy?: BranchHolder): BlueprintExecutionTarget => ({
    path: workspacePath,
    branchName: null,
    isolated: false,
    reason,
    ...(heldBy ? { heldBy } : {})
  })

  // Hoisted out of the try so both catch arms can name the branch they failed
  // on: `TrackConflictError` carries it, a raw git failure does not.
  let resolvedBranch: string | undefined

  try {
    // Same opt-out as chats: an explicit `false` means the user does not want
    // us creating branches in this workspace. Anything else is a yes.
    const settings = workspaceRepository.getSettings(workspaceId)
    if (settings.gitAutoBranch === false) {
      trackLog.info(
        `[ensure] workspace ${workspaceId} opted out of auto-branching — ` +
          `blueprint ${blueprintId} runs in the primary tree`
      )
      return primary('this workspace has automatic branching turned off')
    }

    const blueprint = blueprintRepository.findById(blueprintId)
    const choice = readBranchChoice(blueprint?.settingsJson ?? {})

    if (choice.mode === 'primary') {
      trackLog.info(`[ensure] blueprint ${blueprintId} was set to run in the primary tree`)
      return primary('this blueprint was set to run in the workspace checkout')
    }

    // Manufacturing a first commit in someone else's repository to make a
    // worktree possible is far too surprising to do quietly, and there is
    // nothing to isolate from until there is one.
    if (!(await repoHasCommits(workspacePath))) {
      trackLog.info(`[ensure] ${workspacePath} has no commits — blueprint runs in the primary tree`)
      return primary('this repository has no commits yet')
    }

    // The name resolved at start wins over anything recomputed here.
    // `ensureTrack` treats a different branch name for the same owner as a
    // stale track and rebuilds it, so recomputing from a title that Specify (or
    // the user) has since edited would silently relocate a live run.
    const autoName =
      readBlueprintBranchName(blueprint?.settingsJson) ??
      blueprintTrackBranch(blueprintId, blueprint?.title)
    let branchName = autoName
    let baseBranch: string | undefined

    if (choice.mode === 'fork') {
      branchName = choice.name ?? autoName
      baseBranch = choice.branch
    } else if (choice.mode === 'takeover') {
      if (choice.branch) branchName = choice.branch
      else trackLog.warn(`[ensure] blueprint ${blueprintId}: takeover with no branch — using auto`)
    }
    resolvedBranch = branchName

    // Takeover is a handoff, not a checkout: the branch may already belong to a
    // chat, and the point is that the blueprint inherits that tree with the
    // files the chat left in it rather than a fresh one.
    if (choice.mode === 'takeover' && choice.branch) {
      const holder = trackRepository.findByBranch(workspaceId, branchName)
      const alreadyOurs = holder?.ownerKind === 'blueprint' && holder.ownerId === blueprintId
      if (holder && !alreadyOurs) {
        const outcome = trackService.transferOwner(holder.id, {
          ownerKind: 'blueprint',
          ownerId: blueprintId
        })
        if (outcome.ok) {
          trackLog.info(
            `[ensure] blueprint ${blueprintId} took over ${branchName} at ${outcome.track.path}`
          )
          return {
            path: outcome.track.path,
            branchName: outcome.track.branchName,
            isolated: true,
            reason: null
          }
        }
        if (outcome.reason === 'busy') {
          const who = outcome.holder.label ?? outcome.holder.ownerId ?? 'other work'
          return primary(
            `${who} is using ${branchName} right now — ${outcome.because}`,
            findBranchHolder(workspaceId, blueprintId, branchName) ?? undefined
          )
        }
        // 'no-tree' or 'absent': the bookkeeping outlived the directory, so fall
        // through and let ensureTrack rebuild one for the branch.
      }
    }

    const target = await trackService.ensureTrack({
      ownerKind: 'blueprint',
      ownerId: blueprintId,
      workspaceId,
      repoPath: workspacePath,
      branchName,
      baseBranch
    })

    if (target.isolated) {
      trackLog.info(`[ensure] blueprint ${blueprintId} → ${target.path} (${target.branchName})`)
      return { ...target, reason: null }
    }

    // Rule 3: the workspace checkout is sitting on this branch, so git will not
    // allow a second worktree for it. Correct, and invisible unless said out
    // loud — the user picked a branch and is getting the shared tree.
    //
    // Deliberately no `heldBy`: the primary tree IS on the branch, so writes
    // here do join the work. This is the one non-isolated case that is not a
    // split brain, and blocking it would be a regression.
    trackLog.info(
      `[ensure] blueprint ${blueprintId} runs in the primary tree — it already holds ${branchName}`
    )
    return {
      ...target,
      reason: `your workspace checkout is already on ${branchName}, so it cannot also be checked out separately`
    }
  } catch (err) {
    if (err instanceof TrackConflictError) {
      trackLog.warn(
        `[ensure] blueprint ${blueprintId}: branch ${err.branchName} is held by other work — ` +
          `running in the primary tree instead`
      )
      return primary(
        `branch ${err.branchName} is held by other work`,
        findBranchHolder(workspaceId, blueprintId, err.branchName) ?? undefined
      )
    }
    trackLog.error(
      `[ensure] blueprint ${blueprintId}: could not create a worktree ` +
        `(${(err as Error).message}) — running in the primary tree instead`
    )
    // git can refuse for reasons that have nothing to do with ownership (disk,
    // permissions), so the holder lookup decides: a row holding the branch is a
    // split brain whatever error git chose to raise, and no row is not.
    return primary(
      `a working tree could not be created (${(err as Error).message})`,
      resolvedBranch
        ? (findBranchHolder(workspaceId, blueprintId, resolvedBranch) ?? undefined)
        : undefined
    )
  }
}

/**
 * Where a blueprint run is executing right now, without creating anything.
 *
 * VERIFY's entry point: BUILD already created the tree, and a re-run of VERIFY
 * long after the fact should follow the work to wherever it actually is rather
 * than resurrecting a branch. Falls back to the primary tree, which is correct
 * when BUILD never had a track or the track has since been landed.
 */
export function resolveBlueprintTrack(blueprintId: string, workspacePath: string): ExecutionTarget {
  const target = trackService.resolveTrack('blueprint', blueprintId, workspacePath)
  if (!target.isolated) {
    const holder = findHandoffHolder(blueprintId)
    if (holder) {
      trackLog.warn(
        `[resolve] blueprint ${blueprintId} is running in ${workspacePath}, but its branch ` +
          `${holder.branchName} is held by ${holder.ownerKind}:${holder.ownerId} at ${holder.path}. ` +
          `Output written here will not join the work on that branch.`
      )
    }
  }
  return target
}

/**
 * Who is holding this blueprint's branch after it fell back to the primary tree.
 *
 * `resolveTrack` looks up by owner, and a Blueprint → Chat handoff reassigns the
 * track row to the chat. From here that is indistinguishable from "never had a
 * track", so a resumed or re-verified blueprint quietly runs in the workspace
 * checkout while its output sits on a branch someone else is holding — VERIFY
 * then grades the wrong tree. Nothing here can safely take the branch back (the
 * chat may be mid-turn); naming the holder turns a silent wrong answer into a
 * traceable one, and lets the caller decide whether to refuse or merely say so.
 */
export function findHandoffHolder(blueprintId: string): BranchHolder | null {
  try {
    const blueprint = blueprintRepository.findById(blueprintId)
    if (!blueprint) return null

    const choice = readBranchChoice(blueprint.settingsJson ?? {})
    const branchName =
      choice.mode === 'takeover' && choice.branch
        ? choice.branch
        : (readBlueprintBranchName(blueprint.settingsJson) ??
          (choice.mode === 'fork' && choice.name
            ? choice.name
            : blueprintTrackBranch(blueprintId, blueprint.title)))

    return findBranchHolder(blueprint.workspaceId, blueprintId, branchName)
  } catch (err) {
    // Diagnostics must never break the execution path they describe.
    trackLog.debug(`[resolve] hand-off check failed for ${blueprintId}: ${(err as Error).message}`)
    return null
  }
}
