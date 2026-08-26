/**
 * Pure formatting for Jira → AgentStudio conversions.
 *
 * Both conversion targets need the same brief: the blueprint's Specify phase
 * reads it as the description, and the chat seeds it as the opening message.
 * Keeping one builder means a ticket produces identical context either way.
 *
 * Dependency-free — imported by the main process and the renderer.
 */

import type { BlueprintPriority } from './blueprint-types'
import type { JiraIssueDetail } from './jira.types'

/**
 * Map a Jira priority name onto P1–P3.
 *
 * Priority schemes are configured per Jira instance, so this matches the names
 * shipped by the common defaults (Jira's own Highest/High/…, the Bug scheme's
 * Blocker/Critical/Major) and falls back to P3 rather than guessing.
 */
export function mapJiraPriority(priority: string | undefined): BlueprintPriority {
  const name = (priority ?? '').trim().toLowerCase()
  if (['highest', 'blocker', 'critical', 'p1'].includes(name)) return 'P1'
  if (['high', 'major', 'p2'].includes(name)) return 'P2'
  return 'P3'
}

/**
 * Markdown brief for one issue.
 *
 * Comments are included because acceptance criteria are routinely negotiated in
 * the thread rather than edited back into the description — dropping them loses
 * the part the agent most needs.
 */
export function formatIssueBrief(issue: JiraIssueDetail): string {
  const meta = [
    `**Jira:** [${issue.key}](${issue.browseUrl})`,
    issue.type ? `**Type:** ${issue.type}` : null,
    issue.status ? `**Status:** ${issue.status}` : null,
    issue.priority ? `**Priority:** ${issue.priority}` : null,
    issue.reporter ? `**Reporter:** ${issue.reporter}` : null,
    issue.labels.length > 0 ? `**Labels:** ${issue.labels.join(', ')}` : null
  ].filter((line): line is string => line !== null)

  const sections = [
    `## ${issue.key}: ${issue.summary}`,
    meta.join('\n'),
    `### Description\n\n${issue.description || '_No description provided._'}`
  ]

  if (issue.comments.length > 0) {
    sections.push(
      `### Recent comments\n\n${issue.comments
        .map((c) => `- **${c.author}:** ${c.body}`)
        .join('\n')}`
    )
  }

  // Named so the `[image: ...]` placeholders the description carries can be
  // matched to files. The files themselves arrive as reference documents; the
  // Jira URL is credentialed and useless to the agent.
  if (issue.attachments?.length) {
    sections.push(
      `### Attachments\n\n${issue.attachments.map((a) => `- ${a.filename}`).join('\n')}`
    )
  }

  return sections.join('\n\n')
}

/**
 * Index blueprints by the Jira issue key they were converted from.
 *
 * Converting the same ticket twice produces two blueprints for one piece of
 * work, which is invisible until someone builds both. Callers pass their
 * existing blueprints newest-first, so a duplicate resolves to the newest.
 */
export function indexBlueprintsByJiraKey(
  blueprints: readonly { id: string; settingsJson: Record<string, unknown> }[]
): Map<string, string> {
  const index = new Map<string, string>()
  for (const blueprint of blueprints) {
    const key = blueprint.settingsJson?.jiraIssueKey
    if (typeof key !== 'string' || key.length === 0) continue
    if (!index.has(key)) index.set(key, blueprint.id)
  }
  return index
}

/** Opening chat message for a ticket — the brief plus what to do with it. */
export function buildJiraChatPrompt(issue: JiraIssueDetail): string {
  return `${formatIssueBrief(issue)}\n\nRead the ticket above, then plan how to implement it against this codebase before writing any code.`
}
