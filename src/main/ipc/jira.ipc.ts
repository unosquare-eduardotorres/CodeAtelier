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
  JiraAttachment,
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
  formatIssueBrief,
  indexBlueprintsByJiraKey,
  mapJiraPriority
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
import { blueprintRepository } from '../db/repositories/blueprint.repository'
import { getManagedDocsDir } from './blueprint.ipc'
import {
  MAX_ATTACHMENT_BYTES,
  safeAttachmentFilename,
  selectAttachments
} from '../services/jira-attachments'

const jiraIpcLog = log.scope('jira-ipc')

/** Longest comment we will forward. Jira itself caps around 32k characters. */
const MAX_COMMENT_CHARS = 30_000

/**
 * Bulk-convert ceiling — each ticket costs one Jira round trip.
 * Shared with the renderer so the toolbar can cap the selection with a visible
 * reason instead of letting the call be rejected after the click.
 */
const MAX_BULK_ISSUES = JIRA_MAX_BULK_ISSUES

/** How far back the duplicate scan looks. Older blueprints are not re-checked. */
const DUPLICATE_SCAN_LIMIT = 500

/**
 * Download an issue's attachments into the blueprint's managed docs directory
 * and return them as reference documents.
 *
 * The managed directory is the same one copy-on-attach uses, so these files are
 * already covered by the loader whitelist and by the cleanup that runs when the
 * blueprint is deleted.
 *
 * A failed download is logged and skipped: losing one screenshot is a far
 * better outcome than failing the whole ticket conversion.
 */
async function importAttachments(
  workspaceId: string,
  blueprintId: string,
  attachments: JiraAttachment[]
): Promise<Array<{ type: string; path: string; name: string }>> {
  const wanted = selectAttachments(attachments)
  if (wanted.length === 0) return []

  const dir = getManagedDocsDir(workspaceId, blueprintId)
  mkdirSync(dir, { recursive: true })

  const docs: Array<{ type: string; path: string; name: string }> = []
  for (const [i, attachment] of wanted.entries()) {
    try {
      const bytes = await downloadAttachment(
        workspaceId,
        attachment.contentUrl,
        MAX_ATTACHMENT_BYTES
      )
      // Index prefix: two attachments on one ticket may share a filename.
      const dest = join(dir, `${i}-${safeAttachmentFilename(attachment.filename)}`)
      writeFileSync(dest, bytes)
      docs.push({ type: 'file', path: dest, name: attachment.filename })
    } catch (err) {
      jiraIpcLog.warn(
        `Attachment "${attachment.filename}" skipped: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
  return docs
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

  // ── Bulk convert issues to blueprints ──
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

      const result: JiraCreateBlueprintsResult = { created: [], failed: [], skipped: [] }

      // Read the existing blueprints once, not per ticket: converting the same
      // ticket twice is the easy mistake to make (the list keeps showing it) and
      // two blueprints for one ticket is invisible until someone builds both.
      const existing = indexBlueprintsByJiraKey(
        blueprintRepository.findByWorkspace(workspaceId, DUPLICATE_SCAN_LIMIT)
      )

      // Sequential on purpose: a burst of parallel requests against an on-prem
      // Jira behind a VPN is what trips rate limiting. One partial failure must
      // not abort the rest, so each ticket is isolated.
      for (const issueKey of issueKeys) {
        const alreadyConverted = existing.get(issueKey.trim().toUpperCase())
        if (alreadyConverted) {
          result.skipped.push({ issueKey, blueprintId: alreadyConverted })
          continue
        }

        try {
          const issue = await getIssue(workspaceId, issueKey)
          const title = `${issue.key}: ${issue.summary}`
          const blueprint = blueprintService.create({
            workspaceId,
            title,
            description: formatIssueBrief(issue),
            priority: mapJiraPriority(issue.priority),
            settingsJson: {
              jiraIssueKey: issue.key,
              jiraUrl: issue.browseUrl
            }
          })

          // Attachments need the blueprint id to know where to land, so they
          // are fetched after create and folded back into settings_json.
          const referenceDocuments = await importAttachments(
            workspaceId,
            blueprint.id,
            issue.attachments ?? []
          )
          if (referenceDocuments.length > 0) {
            blueprintRepository.update(blueprint.id, {
              settingsJson: {
                jiraIssueKey: issue.key,
                jiraUrl: issue.browseUrl,
                referenceDocuments
              }
            })
            jiraIpcLog.info(
              `Imported ${referenceDocuments.length} attachment(s) for ${issue.key} → ${blueprint.id}`
            )
          }

          result.created.push({ issueKey: issue.key, blueprintId: blueprint.id, title })
        } catch (err) {
          const message =
            err instanceof JiraRequestError
              ? err.message
              : err instanceof Error
                ? err.message
                : String(err)
          jiraIpcLog.warn(`Blueprint conversion failed for ${issueKey}: ${message}`)
          result.failed.push({ issueKey, error: message })
        }
      }

      jiraIpcLog.info(
        `Converted ${result.created.length} issue(s) to blueprints, ` +
          `${result.skipped.length} already converted, ${result.failed.length} failed`
      )
      return result
    }
  )
}
