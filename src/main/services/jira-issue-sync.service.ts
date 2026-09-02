/**
 * Jira status write-back for the blueprint pipeline.
 *
 * Everything the pipeline writes to Jira goes through here. That is the point:
 * one place to audit, one place to disable, one place where the rules about
 * *when* it is acceptable to move someone else's ticket live.
 *
 * Three rules the rest of the codebase depends on:
 *
 *  1. **It never throws.** A Jira 403, an expired token, a VPN that dropped —
 *     none of these may fail a blueprint. The status write is a side effect of
 *     the work, not part of it.
 *  2. **It is off unless the workspace turned it on** (`jiraSyncStatus`). Every
 *     other Jira write in the app is explicitly user-initiated; a default-on
 *     automatic write would reverse that convention silently.
 *  3. **It only touches tickets that were actually selected.** The blueprint's
 *     `jiraIssueKey` anchor may be an epic nobody picked, and closing someone's
 *     epic because three of its stories built is not ours to do.
 */

import log from 'electron-log/main'
import { blueprintRepository } from '../db/repositories/blueprint.repository'
import { workspaceRepository } from '../db/repositories/workspace.repository'
import { readJiraIssueKeys } from '../../shared/blueprint-branch-name'
import { findTransitionTo } from '../../shared/jira-transition-match'
import { isCompletedWithWarnings } from '../../shared/blueprint-types'
import type { JiraSyncIntent, JiraSyncOutcome } from '../../shared/jira.types'
import { readJiraSyncLog } from '../../shared/jira.types'
import type { UnverifiedItem } from '../../shared/gate-types'
import {
  addComment,
  listTransitions,
  resolveJiraConfig,
  transitionIssue
} from './jira-rest.service'

const syncLog = log.scope('jira-sync')

/** Workspace setting that arms the whole feature. Default off. */
export const JIRA_SYNC_STATUS_SETTING = 'jiraSyncStatus'

/** Workspace setting: move to Done even when the run finished UNPROVEN. */
export const JIRA_DONE_ON_WARNINGS_SETTING = 'jiraDoneOnWarnings'

/** Most unverified items quoted in a warning comment before it is truncated. */
const MAX_COMMENTED_ITEMS = 10

/**
 * Seam for tests.
 *
 * The alternative is a module mock, which forces the whole suite into dynamic
 * requires. One object of function references keeps the production path a plain
 * static import and lets a test replace exactly the calls that would hit the
 * network or SQLite.
 */
export const jiraSyncDeps = {
  listTransitions,
  transitionIssue,
  addComment,
  isJiraConfigured: (workspaceId: string): boolean => resolveJiraConfig(workspaceId) !== null,
  getWorkspaceSettings: (workspaceId: string): Record<string, unknown> =>
    workspaceRepository.getSettings(workspaceId) as Record<string, unknown>,
  findBlueprint: (blueprintId: string) => blueprintRepository.findById(blueprintId),
  saveBlueprintSettings: (blueprintId: string, settings: Record<string, unknown>): void => {
    blueprintRepository.update(blueprintId, { settingsJson: settings })
  }
}

/**
 * Runs already in flight, keyed `blueprintId:intent`.
 *
 * Several services write the terminal `complete` status depending on which path
 * the run took, and the done hook is fire-and-forget from each of them. Without
 * this, two of them landing together would transition the same ticket twice.
 */
const inFlight = new Set<string>()

function emptyOutcome(intent: JiraSyncIntent): JiraSyncOutcome {
  return { intent, at: new Date().toISOString(), moved: [], skipped: [], failed: [] }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Tickets this blueprint may write to.
 *
 * The epic anchor is excluded deliberately — see the header. When the blueprint
 * came from a single ticket, that ticket *is* the anchor and is kept.
 */
function targetIssueKeys(settings: Record<string, unknown>): string[] {
  const epicKey = typeof settings.jiraEpicKey === 'string' ? settings.jiraEpicKey : undefined
  return readJiraIssueKeys(settings).filter((key) => key !== epicKey)
}

/** Persist what happened, so the blueprint pane can show it after a reload. */
function recordOutcome(blueprintId: string, outcome: JiraSyncOutcome): void {
  try {
    const blueprint = jiraSyncDeps.findBlueprint(blueprintId)
    if (!blueprint) return
    const existing = readJiraSyncLog(blueprint.settingsJson)
    jiraSyncDeps.saveBlueprintSettings(blueprintId, {
      ...blueprint.settingsJson,
      jiraSync: { ...existing, [outcome.intent]: outcome }
    })
  } catch (err) {
    syncLog.warn(`Could not record Jira sync outcome for ${blueprintId}: ${errorText(err)}`)
  }
}

/** True when this workspace has opted into automatic status writes. */
function isSyncEnabled(workspaceId: string): boolean {
  try {
    return jiraSyncDeps.getWorkspaceSettings(workspaceId)[JIRA_SYNC_STATUS_SETTING] === true
  } catch {
    return false
  }
}

/**
 * Move every ticket this blueprint covers to `intent`.
 *
 * Per ticket: read the workflow, match a transition, execute it. A ticket whose
 * workflow offers no match is **skipped, not failed** — plenty of workflows have
 * no "In Progress", and that is not an error anyone can act on. One ticket
 * failing never stops the rest.
 */
export async function syncBlueprintIssues(
  blueprintId: string,
  intent: JiraSyncIntent
): Promise<JiraSyncOutcome> {
  const outcome = emptyOutcome(intent)
  const guardKey = `${blueprintId}:${intent}`
  if (inFlight.has(guardKey)) return outcome
  inFlight.add(guardKey)

  try {
    const blueprint = jiraSyncDeps.findBlueprint(blueprintId)
    if (!blueprint) return outcome
    if (!isSyncEnabled(blueprint.workspaceId)) return outcome

    const keys = targetIssueKeys(blueprint.settingsJson)
    if (keys.length === 0) return outcome
    // Checked once rather than per ticket: with no credentials every request
    // would fail identically and report N failures for one missing token.
    if (!jiraSyncDeps.isJiraConfigured(blueprint.workspaceId)) return outcome

    // Sequential, like every other Jira loop in the app: a burst of parallel
    // requests against an on-prem instance behind a VPN is what trips rate
    // limiting.
    for (const key of keys) {
      try {
        const transition = findTransitionTo(
          await jiraSyncDeps.listTransitions(blueprint.workspaceId, key),
          intent
        )
        if (!transition) {
          outcome.skipped.push(key)
          continue
        }
        await jiraSyncDeps.transitionIssue(blueprint.workspaceId, key, transition.id)
        outcome.moved.push(key)
      } catch (err) {
        outcome.failed.push({ key, error: errorText(err) })
      }
    }

    syncLog.info(
      `Blueprint ${blueprintId} → ${intent}: ` +
        `moved [${outcome.moved.join(', ')}], ` +
        `skipped [${outcome.skipped.join(', ')}], ` +
        `failed [${outcome.failed.map((f) => f.key).join(', ')}]`
    )
    recordOutcome(blueprintId, outcome)
    return outcome
  } catch (err) {
    // Belt and braces: reaching here means something outside the per-ticket
    // try/catch threw. It still must not reach the caller.
    syncLog.warn(`Jira sync for ${blueprintId} (${intent}) aborted: ${errorText(err)}`)
    return outcome
  } finally {
    inFlight.delete(guardKey)
  }
}

/**
 * The work has started — move the tickets to In Progress.
 *
 * Called once, when a selection is converted into a blueprint. Moving on
 * BUILD-phase start instead would make the board reflect work actually
 * underway; that is a one-line move of this call, nothing here changes.
 */
export function syncBlueprintInProgress(blueprintId: string): Promise<JiraSyncOutcome> {
  return syncBlueprintIssues(blueprintId, 'in-progress')
}

/** The warning comment posted in place of a Done that would be a false claim. */
function warningCommentBody(title: string, items: readonly UnverifiedItem[]): string {
  const quoted = items.slice(0, MAX_COMMENTED_ITEMS)
  const lines = quoted.map(
    (item) =>
      `- ${item.taskId}/${item.gate}: ${item.reason}${item.detail ? ` — ${item.detail}` : ''}`
  )
  if (items.length > quoted.length) lines.push(`- …and ${items.length - quoted.length} more`)
  return (
    `Blueprint "${title}" finished, but ${items.length} check` +
    `${items.length === 1 ? '' : 's'} could not be verified. ` +
    'The status has been left unchanged rather than claiming work that was not proven.\n\n' +
    lines.join('\n')
  )
}

/**
 * The blueprint finished — decide what that is worth saying on the board.
 *
 * A clean completion moves the tickets to Done. A completion carrying unverified
 * checks posts a comment naming them and **leaves the status alone**: reverting
 * a wrongly-closed ticket is manual work for whoever notices, and a comment
 * costs nothing. `jiraDoneOnWarnings` opts back into Done regardless.
 *
 * Safe to call more than once — the recorded outcome is the idempotence key, so
 * it survives a restart as well as a double dispatch.
 */
export async function syncBlueprintDone(blueprintId: string): Promise<JiraSyncOutcome> {
  const outcome = emptyOutcome('done')
  try {
    const blueprint = jiraSyncDeps.findBlueprint(blueprintId)
    if (!blueprint || blueprint.status !== 'complete') return outcome
    if (readJiraSyncLog(blueprint.settingsJson).done) return outcome
    if (!isSyncEnabled(blueprint.workspaceId)) return outcome

    const settings = jiraSyncDeps.getWorkspaceSettings(blueprint.workspaceId)
    const unverified = blueprint.unverifiedJson ?? []
    const withWarnings =
      isCompletedWithWarnings(blueprint) && settings[JIRA_DONE_ON_WARNINGS_SETTING] !== true
    if (!withWarnings) return await syncBlueprintIssues(blueprintId, 'done')

    const keys = targetIssueKeys(blueprint.settingsJson)
    if (keys.length === 0) return outcome
    if (!jiraSyncDeps.isJiraConfigured(blueprint.workspaceId)) return outcome

    const body = warningCommentBody(blueprint.title, unverified)
    const commented: string[] = []
    for (const key of keys) {
      try {
        await jiraSyncDeps.addComment(blueprint.workspaceId, key, body)
        commented.push(key)
      } catch (err) {
        outcome.failed.push({ key, error: errorText(err) })
      }
    }
    outcome.commented = commented

    syncLog.info(
      `Blueprint ${blueprintId} finished UNPROVEN — commented on [${commented.join(', ')}], ` +
        'status left unchanged'
    )
    recordOutcome(blueprintId, outcome)
    return outcome
  } catch (err) {
    syncLog.warn(`Jira done-sync for ${blueprintId} aborted: ${errorText(err)}`)
    return outcome
  }
}
