/**
 * IPC handlers for the Jira tickets panel.
 *
 * These talk to Jira over REST directly (see `jira-rest.service`) rather than
 * through the bundled MCP server — the panel has to work whether or not the
 * user has enabled the Jira integration for chat.
 *
 * Credentials never cross the boundary: the renderer sends a workspace id and
 * the main process resolves the stored token itself.
 */

import { ipcMain } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log/main'
import { IPC_CHANNELS } from '../../shared/constants'
import type {
  JiraBoard,
  JiraCreateBlueprintsResult,
  JiraCurrentUser,
  JiraIssueDetail,
  JiraProject,
  JiraSearchResult,
  JiraSprint,
  JiraTransition
} from '../../shared/jira.types'
import { JIRA_MAX_BULK_ISSUES, JIRA_MAX_JQL_CHARS } from '../../shared/jira.types'
import {
  deriveGroupPriority,
  deriveGroupTitle,
  formatGroupedIssueBrief,
  groupTicketOf,
  indexBlueprintsByJiraKey,
  resolveGroupAnchor
} from '../../shared/jira-format'
import { validateSender } from './validate-sender'
import {
  optionalNumber,
  optionalString,
  requireObject,
  requireString,
  requireStringArray
} from './validate-args'
import {
  JiraRequestError,
  addComment,
  assignToMe,
  downloadAttachment,
  getIssue,
  listBoards,
  listProjects,
  listSprints,
  listTransitions,
  searchIssues,
  transitionIssue
} from '../services/jira-rest.service'
import { blueprintService } from '../services/blueprint.service'
import { syncBlueprintInProgress } from '../services/jira-issue-sync.service'
import { blueprintRepository } from '../db/repositories/blueprint.repository'
import { getManagedDocsDir } from './blueprint.ipc'
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_GROUP,
  attachmentDestFilename,
  selectAttachments
} from '../services/jira-attachments'

const jiraIpcLog = log.scope('jira-ipc')

/** Longest comment we will forward. Jira itself caps around 32k characters. */
const MAX_COMMENT_CHARS = 30_000

/**
 * How many tickets may be folded into one blueprint — each costs one Jira round
 * trip. Shared with the renderer so the toolbar can cap the selection with a
 * visible reason instead of letting the call be rejected after the click.
 */
const MAX_BULK_ISSUES = JIRA_MAX_BULK_ISSUES

/** How far back the duplicate scan looks. Older blueprints are not re-checked. */
const DUPLICATE_SCAN_LIMIT = 500

/**
 * Download every issue's attachments into the blueprint's managed docs
 * directory and return them as reference documents.
 *
 * The managed directory is the same one copy-on-attach uses, so these files are
 * already covered by the loader whitelist and by the cleanup that runs when the
 * blueprint is deleted.
 *
 * Filenames are prefixed with the issue key as well as an index: one blueprint
 * can now be built from several tickets, and two tickets both attaching
 * `screenshot.png` is the common case, not an edge one.
 *
 * A failed download is logged and skipped: losing one screenshot is a far
 * better outcome than failing the whole conversion.
 */
async function importAttachments(
  workspaceId: string,
  blueprintId: string,
  issues: readonly JiraIssueDetail[]
): Promise<Array<{ type: string; path: string; name: string }>> {
  const grouped = issues.length > 1
  const docs: Array<{ type: string; path: string; name: string }> = []
  let dir: string | null = null

  for (const issue of issues) {
    for (const [i, attachment] of selectAttachments(issue.attachments ?? []).entries()) {
      if (docs.length >= MAX_ATTACHMENTS_PER_GROUP) {
        jiraIpcLog.warn(
          `Attachment budget of ${MAX_ATTACHMENTS_PER_GROUP} reached; remaining files skipped.`
        )
        return docs
      }
      try {
        const bytes = await downloadAttachment(
          workspaceId,
          attachment.contentUrl,
          MAX_ATTACHMENT_BYTES
        )
        // Created lazily so a group with no readable attachments leaves no
        // empty directory behind.
        if (dir === null) {
          dir = getManagedDocsDir(workspaceId, blueprintId)
          mkdirSync(dir, { recursive: true })
        }
        const dest = join(dir, attachmentDestFilename(issue.key, i, attachment.filename))
        writeFileSync(dest, bytes)
        docs.push({
          type: 'file',
          path: dest,
          // The key is part of the display name too, so a list of five
          // `screenshot.png` rows says which ticket each came from.
          name: grouped ? `${issue.key} — ${attachment.filename}` : attachment.filename
        })
      } catch (err) {
        jiraIpcLog.warn(
          `Attachment "${attachment.filename}" on ${issue.key} skipped: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    }
  }
  return docs
}

/** A Jira or unexpected error, reduced to something safe to show the user. */
function errorText(err: unknown): string {
  if (err instanceof JiraRequestError) return err.message
  return err instanceof Error ? err.message : String(err)
}

/**
 * Re-throw with a user-facing message.
 *
 * `JiraRequestError` messages are already curated (mapHttpStatus /
 * mapNetworkError) and safe to render. Anything else is logged and replaced,
 * so an unexpected stack or a URL carrying credentials never reaches the UI.
 */
function toUserFacing(err: unknown, channel: string): Error {
  if (err instanceof JiraRequestError) return new Error(err.message)
  jiraIpcLog.error(`${channel} failed:`, err)
  return new Error('Jira request failed. Check the connection settings in the Jira tab.')
}

export function registerJiraIpc(): void {
  // ── Search issues (JQL) ──
  ipcMain.handle(
    IPC_CHANNELS.JIRA_SEARCH_ISSUES,
    async (event, rawArgs: unknown): Promise<JiraSearchResult> => {
      validateSender(event)
      const ch = IPC_CHANNELS.JIRA_SEARCH_ISSUES
      const args = requireObject(rawArgs, ch)
      const workspaceId = requireString(args, 'workspaceId', ch)
      const jql = requireString(args, 'jql', ch)
      const maxResults = optionalNumber(args, 'maxResults', ch)
      const cursor = optionalString(args, 'cursor', ch)

      if (jql.length > JIRA_MAX_JQL_CHARS) {
        throw new Error(`Query too long: ${jql.length} characters (max ${JIRA_MAX_JQL_CHARS}).`)
      }

      try {
        return await searchIssues(workspaceId, jql, maxResults ?? 25, cursor)
      } catch (err) {
        throw toUserFacing(err, ch)
      }
    }
  )

  // ── Projects (scoping dropdown) ──
  ipcMain.handle(
    IPC_CHANNELS.JIRA_LIST_PROJECTS,
    async (event, rawArgs: unknown): Promise<JiraProject[]> => {
      validateSender(event)
      const ch = IPC_CHANNELS.JIRA_LIST_PROJECTS
      const workspaceId = requireString(requireObject(rawArgs, ch), 'workspaceId', ch)
      try {
        return await listProjects(workspaceId)
      } catch (err) {
        throw toUserFacing(err, ch)
      }
    }
  )

  // ── Boards for a project (Agile API — absent on Jira Core) ──
  ipcMain.handle(
    IPC_CHANNELS.JIRA_LIST_BOARDS,
    async (event, rawArgs: unknown): Promise<JiraBoard[]> => {
      validateSender(event)
      const ch = IPC_CHANNELS.JIRA_LIST_BOARDS
      const args = requireObject(rawArgs, ch)
      const workspaceId = requireString(args, 'workspaceId', ch)
      const projectKey = requireString(args, 'projectKey', ch)
      try {
        return await listBoards(workspaceId, projectKey)
      } catch (err) {
        throw toUserFacing(err, ch)
      }
    }
  )

  // ── Sprints on a board ──
  ipcMain.handle(
    IPC_CHANNELS.JIRA_LIST_SPRINTS,
    async (event, rawArgs: unknown): Promise<JiraSprint[]> => {
      validateSender(event)
      const ch = IPC_CHANNELS.JIRA_LIST_SPRINTS
      const args = requireObject(rawArgs, ch)
      const workspaceId = requireString(args, 'workspaceId', ch)
      const boardId = optionalNumber(args, 'boardId', ch)
      if (boardId === undefined) throw new Error(`${ch}: field 'boardId' must be a finite number`)
      try {
        return await listSprints(workspaceId, boardId)
      } catch (err) {
        throw toUserFacing(err, ch)
      }
    }
  )

  // ── Which tickets already have a blueprint ──
  ipcMain.handle(
    IPC_CHANNELS.JIRA_CONVERTED_KEYS,
    async (event, rawArgs: unknown): Promise<Record<string, string>> => {
      validateSender(event)
      const ch = IPC_CHANNELS.JIRA_CONVERTED_KEYS
      const workspaceId = requireString(requireObject(rawArgs, ch), 'workspaceId', ch)

      try {
        // Same query the bulk convert already runs to dedupe. Surfacing it up
        // front is what turns "already converted" from a line in the result box
        // after the click into a badge on the row before it.
        const index = indexBlueprintsByJiraKey(
          blueprintRepository.findByWorkspace(workspaceId, DUPLICATE_SCAN_LIMIT)
        )
        return Object.fromEntries(index)
      } catch (err) {
        throw toUserFacing(err, ch)
      }
    }
  )

  // ── Assign an issue to the credentialed account ──
  ipcMain.handle(
    IPC_CHANNELS.JIRA_ASSIGN_TO_ME,
    async (event, rawArgs: unknown): Promise<JiraCurrentUser> => {
      validateSender(event)
      const ch = IPC_CHANNELS.JIRA_ASSIGN_TO_ME
      const args = requireObject(rawArgs, ch)
      const workspaceId = requireString(args, 'workspaceId', ch)
      const issueKey = requireString(args, 'issueKey', ch)
      try {
        return await assignToMe(workspaceId, issueKey)
      } catch (err) {
        throw toUserFacing(err, ch)
      }
    }
  )

  // ── Workflow transitions available on an issue ──
  ipcMain.handle(
    IPC_CHANNELS.JIRA_LIST_TRANSITIONS,
    async (event, rawArgs: unknown): Promise<JiraTransition[]> => {
      validateSender(event)
      const ch = IPC_CHANNELS.JIRA_LIST_TRANSITIONS
      const args = requireObject(rawArgs, ch)
      const workspaceId = requireString(args, 'workspaceId', ch)
      const issueKey = requireString(args, 'issueKey', ch)
      try {
        return await listTransitions(workspaceId, issueKey)
      } catch (err) {
        throw toUserFacing(err, ch)
      }
    }
  )

  // ── Execute a workflow transition ──
  ipcMain.handle(
    IPC_CHANNELS.JIRA_TRANSITION_ISSUE,
    async (event, rawArgs: unknown): Promise<{ success: true }> => {
      validateSender(event)
      const ch = IPC_CHANNELS.JIRA_TRANSITION_ISSUE
      const args = requireObject(rawArgs, ch)
      const workspaceId = requireString(args, 'workspaceId', ch)
      const issueKey = requireString(args, 'issueKey', ch)
      const transitionId = requireString(args, 'transitionId', ch)
      try {
        await transitionIssue(workspaceId, issueKey, transitionId)
        return { success: true }
      } catch (err) {
        throw toUserFacing(err, ch)
      }
    }
  )

  // ── Get one issue ──
  ipcMain.handle(
    IPC_CHANNELS.JIRA_GET_ISSUE,
    async (event, rawArgs: unknown): Promise<JiraIssueDetail> => {
      validateSender(event)
      const ch = IPC_CHANNELS.JIRA_GET_ISSUE
      const args = requireObject(rawArgs, ch)
      const workspaceId = requireString(args, 'workspaceId', ch)
      const issueKey = requireString(args, 'issueKey', ch)

      try {
        return await getIssue(workspaceId, issueKey)
      } catch (err) {
        throw toUserFacing(err, ch)
      }
    }
  )

  // ── Post a comment ──
  ipcMain.handle(
    IPC_CHANNELS.JIRA_ADD_COMMENT,
    async (event, rawArgs: unknown): Promise<{ success: true }> => {
      validateSender(event)
      const ch = IPC_CHANNELS.JIRA_ADD_COMMENT
      const args = requireObject(rawArgs, ch)
      const workspaceId = requireString(args, 'workspaceId', ch)
      const issueKey = requireString(args, 'issueKey', ch)
      const body = requireString(args, 'body', ch)

      if (body.length > MAX_COMMENT_CHARS) {
        throw new Error(`Comment too long: ${body.length} characters (max ${MAX_COMMENT_CHARS}).`)
      }

      try {
        await addComment(workspaceId, issueKey, body)
        return { success: true }
      } catch (err) {
        throw toUserFacing(err, ch)
      }
    }
  )

  // ── Convert a selection of issues into ONE blueprint ──
  //
  // One blueprint, not one per ticket. Ten tickets under an epic are ten
  // branches, ten Specify runs and ten plans that each know about a tenth of the
  // work — which is not what "convert these" means to anyone selecting them.
  ipcMain.handle(
    IPC_CHANNELS.JIRA_CREATE_BLUEPRINTS,
    async (event, rawArgs: unknown): Promise<JiraCreateBlueprintsResult> => {
      validateSender(event)
      const ch = IPC_CHANNELS.JIRA_CREATE_BLUEPRINTS
      const args = requireObject(rawArgs, ch)
      const workspaceId = requireString(args, 'workspaceId', ch)
      const issueKeys = requireStringArray(args, 'issueKeys', ch)

      if (issueKeys.length > MAX_BULK_ISSUES) {
        throw new Error(
          `${ch}: too many issues (${issueKeys.length}); select at most ${MAX_BULK_ISSUES}.`
        )
      }

      const result: JiraCreateBlueprintsResult = { created: null, failed: [], skipped: [] }

      // Read the existing blueprints once: converting the same ticket twice is
      // the easy mistake to make (the list keeps showing it) and two blueprints
      // for one ticket is invisible until someone builds both.
      const existing = indexBlueprintsByJiraKey(
        blueprintRepository.findByWorkspace(workspaceId, DUPLICATE_SCAN_LIMIT)
      )

      // Partial overlap is resolved by skipping, not by refusing: a selection of
      // three where one is already converted builds the blueprint from the other
      // two and reports both outcomes.
      const pending = issueKeys.filter((issueKey) => {
        const alreadyConverted = existing.get(issueKey.trim().toUpperCase())
        if (!alreadyConverted) return true
        result.skipped.push({ issueKey, blueprintId: alreadyConverted })
        return false
      })

      // Sequential on purpose: a burst of parallel requests against an on-prem
      // Jira behind a VPN is what trips rate limiting. One unreadable ticket must
      // not lose the rest of the group, so each fetch is isolated.
      const issues: JiraIssueDetail[] = []
      for (const issueKey of pending) {
        try {
          issues.push(await getIssue(workspaceId, issueKey))
        } catch (err) {
          const message = errorText(err)
          jiraIpcLog.warn(`Could not read ${issueKey}: ${message}`)
          result.failed.push({ issueKey, error: message })
        }
      }

      if (issues.length === 0) {
        jiraIpcLog.info(
          `No blueprint created — ${result.skipped.length} already converted, ` +
            `${result.failed.length} unreadable`
        )
        return result
      }

      const anchor = resolveGroupAnchor(issues)
      const title = deriveGroupTitle(issues.map(groupTicketOf))
      const epic = anchor.epicKey
        ? {
            key: anchor.epicKey,
            summary: anchor.epicSummary,
            type: anchor.epicType,
            url: anchor.epicUrl
          }
        : undefined

      // `jiraIssueKey` is kept alongside the list: branch naming and the
      // blueprint→chat handoff both read it, and it is what makes a grouped
      // blueprint land on the epic's branch rather than the first ticket's.
      const settingsJson: Record<string, unknown> = {
        jiraIssueKeys: anchor.issueKeys,
        jiraIssueKey: anchor.anchorKey,
        ...(anchor.epicKey ? { jiraEpicKey: anchor.epicKey } : {}),
        jiraUrl: anchor.anchorUrl
      }

      try {
        const blueprint = blueprintService.create({
          workspaceId,
          title,
          description: formatGroupedIssueBrief(issues, epic),
          priority: deriveGroupPriority(issues),
          settingsJson
        })

        // Attachments need the blueprint id to know where to land, so they are
        // fetched after create and folded back into settings_json.
        const referenceDocuments = await importAttachments(workspaceId, blueprint.id, issues)
        if (referenceDocuments.length > 0) {
          blueprintRepository.update(blueprint.id, {
            settingsJson: { ...settingsJson, referenceDocuments }
          })
          jiraIpcLog.info(
            `Imported ${referenceDocuments.length} attachment(s) for ${anchor.issueKeys.join(
              ', '
            )} → ${blueprint.id}`
          )
        }

        result.created = { blueprintId: blueprint.id, title, issueKeys: anchor.issueKeys }

        // Move the tickets to In Progress, if the workspace opted in. Deliberately
        // not awaited: a slow or unreachable Jira must not stall the response for
        // a blueprint that already exists. The service never throws and records
        // what it did on the blueprint, so nothing is lost by letting it run on.
        //
        // This is the one call to move if the board should instead reflect work
        // actually underway — BUILD-phase start rather than conversion.
        void syncBlueprintInProgress(blueprint.id)
      } catch (err) {
        const message = errorText(err)
        jiraIpcLog.warn(
          `Blueprint conversion failed for ${anchor.issueKeys.join(', ')}: ${message}`
        )
        for (const issue of issues) result.failed.push({ issueKey: issue.key, error: message })
      }

      jiraIpcLog.info(
        `${result.created ? `Created 1 blueprint from ${result.created.issueKeys.length} issue(s)` : 'Created no blueprint'}, ` +
          `${result.skipped.length} already converted, ${result.failed.length} failed`
      )
      return result
    }
  )
}
