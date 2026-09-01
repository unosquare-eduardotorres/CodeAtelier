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
import { priorityImportance } from './jira-list-view'

/** Longest title a derived group title may reach. */
const MAX_TITLE_CHARS = 200

/**
 * Per-ticket and whole-group budgets for the grouped brief.
 *
 * The panel fetches issues with a 50,000-character description allowance and 50
 * comments *per ticket*, which is right for a human reading a scroll pane and
 * catastrophic as a Specify input: twenty-five tickets would be well over a
 * million characters. These caps are what makes the grouped brief bounded.
 */
const MAX_BRIEF_CHARS_PER_ISSUE = 8_000
const MAX_GROUPED_BRIEF_CHARS = 60_000

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

// ── Grouping: N tickets, one blueprint ──

/**
 * The minimum a ticket has to carry to be titled as part of a group.
 *
 * Structural rather than tied to one shape so the renderer can derive the same
 * title from a `JiraIssueRow` it already has — showing the title in the
 * selection tray *before* the click is what stops grouping being a surprise.
 * `JiraIssueDetail` spells the parent key `parent`, so it goes through
 * `groupTicketOf`.
 */
export interface JiraGroupTicket {
  key: string
  summary: string
  parentKey?: string
  parentSummary?: string
  parentType?: string
}

/** Narrow a full issue to what the title rules need. */
export function groupTicketOf(issue: JiraIssueDetail): JiraGroupTicket {
  return {
    key: issue.key,
    summary: issue.summary,
    parentKey: issue.parent,
    parentSummary: issue.parentSummary,
    parentType: issue.parentType
  }
}

/** A parent shared by every ticket in a group — usually an epic. */
export interface JiraSharedParent {
  key: string
  summary: string
  /** "Epic", "Story", … — absent when Jira did not say. */
  type?: string
}

/**
 * The parent every ticket in the group hangs off, when there is exactly one and
 * Jira told us its summary.
 *
 * Named "parent" rather than "epic" because Jira Cloud reuses one `parent`
 * field for two relationships: a story's parent is its epic, a sub-task's is
 * its story. Grouping is right in both cases — a shared parent is a shared unit
 * of work — but only `type` says which one the caller is looking at, so callers
 * that show it to a human or a model must use `type` rather than assume.
 *
 * The summary is required: a parent key with no name gives a title like
 * "CHR-12: " , which is worse than falling through to the ticket-derived rule.
 *
 * Returns null on Jira Server / DC classic projects as a matter of course —
 * there the epic link is a per-instance custom field (`customfield_100xx`), not
 * `parent`, so no shared parent is ever reported.
 */
export function sharedParentOf(tickets: readonly JiraGroupTicket[]): JiraSharedParent | null {
  if (tickets.length < 2) return null
  const first = tickets[0].parentKey
  if (!first) return null
  if (!tickets.every((t) => t.parentKey === first)) return null
  const summary = tickets.find((t) => t.parentSummary)?.parentSummary
  if (!summary) return null
  return { key: first, summary, type: tickets.find((t) => t.parentType)?.parentType }
}

/**
 * Title for the one blueprint a selection produces.
 *
 *   1. One ticket            → `CHR-40: Checkout total ignores discounts`
 *   2. All under one parent  → `CHR-12: Checkout revamp`
 *   3. Otherwise             → `CHR-40 +2 more: Checkout total ignores discounts`
 */
export function deriveGroupTitle(tickets: readonly JiraGroupTicket[]): string {
  if (tickets.length === 0) return 'Jira tickets'

  const [first] = tickets
  if (tickets.length === 1) return `${first.key}: ${first.summary}`.slice(0, MAX_TITLE_CHARS)

  const parent = sharedParentOf(tickets)
  if (parent) return `${parent.key}: ${parent.summary}`.slice(0, MAX_TITLE_CHARS)

  return `${first.key} +${tickets.length - 1} more: ${first.summary}`.slice(0, MAX_TITLE_CHARS)
}

/**
 * What the group's blueprint records about where it came from.
 *
 * `anchorKey` is deliberately a single key and is written to `jiraIssueKey`:
 * branch naming and the blueprint→chat handoff both read that field, so keeping
 * it means an epic-grouped blueprint lands on `feature/CHR-12-checkout-revamp`
 * — the epic being the unit of work — and every blueprint predating grouping
 * keeps working untouched.
 */
export interface JiraGroupAnchor {
  /** Every ticket folded into the blueprint, in selection order. */
  issueKeys: string[]
  /**
   * The shared parent, when there is one. Spelled "epic" because that is the
   * normal case and the name is persisted as `jiraEpicKey`; `epicType` says
   * what it actually is when a group of sub-tasks made it a story.
   */
  epicKey?: string
  epicSummary?: string
  epicType?: string
  epicUrl?: string
  /** The shared parent when there is one, else the first ticket. */
  anchorKey: string
  anchorUrl: string
}

/** Swap the issue key in a `/browse/KEY` link, keeping the site it points at. */
function siblingBrowseUrl(browseUrl: string, key: string): string {
  const at = browseUrl.lastIndexOf('/browse/')
  return at === -1 ? browseUrl : `${browseUrl.slice(0, at)}/browse/${key}`
}

export function resolveGroupAnchor(issues: readonly JiraIssueDetail[]): JiraGroupAnchor {
  const [first] = issues
  const issueKeys = issues.map((issue) => issue.key)
  const parent = sharedParentOf(issues.map(groupTicketOf))

  if (!parent) return { issueKeys, anchorKey: first.key, anchorUrl: first.browseUrl }

  const epicUrl = siblingBrowseUrl(first.browseUrl, parent.key)
  return {
    issueKeys,
    epicKey: parent.key,
    epicSummary: parent.summary,
    epicType: parent.type,
    epicUrl,
    anchorKey: parent.key,
    anchorUrl: epicUrl
  }
}

/**
 * Priority for the group: the most urgent ticket wins.
 *
 * A group containing a Blocker is a P1 blueprint. Averaging would let four
 * trivial tickets bury the one that is on fire.
 */
export function deriveGroupPriority(issues: readonly { priority?: string }[]): BlueprintPriority {
  let worst: string | undefined
  let worstRank = -1
  for (const issue of issues) {
    const rank = priorityImportance(issue.priority) ?? 0
    if (rank > worstRank) {
      worstRank = rank
      worst = issue.priority
    }
  }
  return mapJiraPriority(worst)
}

/** Truncate to a budget, saying so rather than stopping mid-sentence silently. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}\n\n_[…truncated]_`
}

/**
 * Markdown brief for a group of issues.
 *
 * A single ticket returns `formatIssueBrief` verbatim — the grouped intro would
 * be noise, and going through the same builder is what stops the single and
 * grouped briefs drifting apart.
 */
export function formatGroupedIssueBrief(
  issues: readonly JiraIssueDetail[],
  epic?: { key: string; summary?: string; type?: string; url?: string }
): string {
  if (issues.length === 0) return ''
  if (issues.length === 1) return formatIssueBrief(issues[0])

  const intro: string[] = [`# ${issues.length} Jira tickets, one blueprint`]

  if (epic) {
    const label = epic.summary ? ` — ${epic.summary}` : ''
    // Named from the data, not assumed: calling a story's sub-tasks an epic
    // would tell the model the wrong thing about where this work sits.
    const heading = epic.type ?? 'Parent'
    intro.push(
      `**${heading}:** ${epic.url ? `[${epic.key}](${epic.url})` : `\`${epic.key}\``}${label}`
    )
  }

  intro.push(
    '### Tickets in this blueprint\n\n' +
      issues
        .map((issue) => {
          const meta = [issue.type, issue.status, issue.priority]
            .filter((part): part is string => !!part)
            .join(' · ')
          return `- [${issue.key}](${issue.browseUrl}) — ${issue.summary}${
            meta ? ` (${meta})` : ''
          }`
        })
        .join('\n')
  )

  intro.push(
    'Treat these as one piece of work: one plan, one branch, one set of changes. ' +
      'Each ticket’s full brief follows.'
  )

  const sections = [intro.join('\n\n')]
  let used = sections[0].length

  for (const [i, issue] of issues.entries()) {
    const brief = clip(formatIssueBrief(issue), MAX_BRIEF_CHARS_PER_ISSUE)
    if (used + brief.length > MAX_GROUPED_BRIEF_CHARS) {
      sections.push(
        `---\n\n_${issues.length - i} further ticket(s) omitted — the combined brief hit its ` +
          `${MAX_GROUPED_BRIEF_CHARS}-character budget. They are listed above and readable with ` +
          '`mcp__jira__get_issue`._'
      )
      break
    }
    sections.push('---')
    sections.push(brief)
    used += brief.length
  }

  return sections.join('\n\n')
}

/**
 * Index blueprints by the Jira issue keys they were converted from.
 *
 * Converting the same ticket twice produces two blueprints for one piece of
 * work, which is invisible until someone builds both. Callers pass their
 * existing blueprints newest-first, so a duplicate resolves to the newest.
 *
 * `jiraIssueKeys` is the source of truth and every entry is indexed, so all
 * tickets in a group resolve to the same blueprint. `jiraIssueKey` is only read
 * when the list is absent — blueprints created before grouping have nothing
 * else, and on a grouped blueprint it holds the *epic*, which was never one of
 * the selected tickets and must not be badged as converted.
 */
export function indexBlueprintsByJiraKey(
  blueprints: readonly { id: string; settingsJson: Record<string, unknown> }[]
): Map<string, string> {
  const index = new Map<string, string>()
  for (const blueprint of blueprints) {
    const raw = blueprint.settingsJson?.jiraIssueKeys
    const keys = Array.isArray(raw)
      ? raw.filter((key): key is string => typeof key === 'string' && key.length > 0)
      : []

    if (keys.length === 0) {
      const legacy = blueprint.settingsJson?.jiraIssueKey
      if (typeof legacy === 'string' && legacy.length > 0) keys.push(legacy)
    }

    for (const key of keys) {
      if (!index.has(key)) index.set(key, blueprint.id)
    }
  }
  return index
}

/**
 * Opening chat message for a selection — the brief plus what to do with it.
 *
 * Takes a list because the chat handoff groups exactly as the blueprint one
 * does: one chat, one branch, every ticket in the brief.
 */
export function buildJiraChatPrompt(
  issues: readonly JiraIssueDetail[],
  epic?: { key: string; summary?: string; type?: string; url?: string }
): string {
  const subject = issues.length === 1 ? 'the ticket' : 'the tickets'
  return `${formatGroupedIssueBrief(issues, epic)}\n\nRead ${subject} above, then plan how to implement ${
    issues.length === 1 ? 'it' : 'them'
  } against this codebase before writing any code.`
}
