/**
 * Pure helpers for the recall MCP server.
 *
 * Kept out of recall-server.ts so unit tests can exercise the merge/format
 * logic without booting a stdio transport.
 *
 * The core problem this solves: plans live in TWO places and neither alone is
 * complete. The `plans` registry can be empty (write-alongside registration is
 * unreliable, see plan gap #2) while the plan text itself always survives in
 * the message that rendered it. So we union both sources and dedupe.
 */

import type { PlanRecord, StructuredPlan } from '../../shared/types'

/**
 * Matches ``` (or ````) plan blocks with a capture group.
 * Mirrors PLAN_BLOCK_CAPTURE_RE in
 * src/renderer/src/components/chat/plan-detection.ts — duplicated rather than
 * imported because the main process must not import renderer modules.
 */
export const PLAN_BLOCK_RE = /`{3,4}plan\n([\s\S]*?)`{3,4}/

// ── Types ──

export interface RecallPlanEntry {
  /** Stable address: `plan:<uuid>` (registry) or `msg:<messageId>` (message-derived) */
  ref: string
  /** Companion ref when a registry row and a message were merged */
  altRef?: string
  title: string
  summary: string
  /** Registry source ('chat' | 'grill' | …) or 'message' for message-derived entries */
  source: string
  /** Registry lifecycle status, null for message-derived entries */
  status: string | null
  planType?: string | null
  conversationId: string | null
  conversationTitle?: string | null
  createdAt: string
  /** True for archived registry rows — an older revision */
  superseded: boolean
  previousPlanId?: string | null
  /** Full plan text — used for search matching and for recall_plan output */
  body: string
}

/** A message row carrying an embedded plan block. */
export interface PlanBlockMessage {
  id: string
  conversationId: string
  conversationTitle: string | null
  createdAt: string
  contentMd: string
}

export type RecallRef = { kind: 'plan' | 'msg' | 'auto'; id: string }

// ── Ref parsing ──

/**
 * Parse a recall ref. Bare ids (no prefix) resolve to kind 'auto' so callers
 * can try both sources — agents copy ids around and shouldn't be punished.
 */
export function parseRecallRef(ref: string): RecallRef | null {
  const trimmed = (ref ?? '').trim()
  if (!trimmed) return null
  const match = /^(plan|msg):(.+)$/.exec(trimmed)
  if (match) return { kind: match[1] as 'plan' | 'msg', id: match[2].trim() }
  return { kind: 'auto', id: trimmed }
}

// ── Timestamps ──

/**
 * Parse a SQLite timestamp. `datetime('now')` yields "YYYY-MM-DD HH:MM:SS" in
 * UTC — without the explicit Z, Date.parse treats it as local time and the
 * 60-second dedupe window silently never matches.
 */
export function parseTs(value: string | null | undefined): number {
  if (!value) return 0
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? 0 : parsed
}

// ── Message-derived entries ──

/** Extract the plan block body from a message, or null when there is none. */
export function extractPlanBlock(contentMd: string): string | null {
  const match = PLAN_BLOCK_RE.exec(contentMd ?? '')
  return match ? match[1].trim() : null
}

function firstLine(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (line) return line
  }
  return ''
}

/** Derive a title from a plan block — first heading, else first line. */
export function deriveTitle(body: string): string {
  const heading = /^#{1,3}\s+(.+)$/m.exec(body)
  const candidate = heading ? heading[1].trim() : firstLine(body).replace(/^[#>*\-\s]+/, '')
  const title = candidate || 'Untitled plan'
  return title.length > 140 ? `${title.slice(0, 137)}…` : title
}

/** Derive a one-line summary — first prose line that isn't the title heading. */
export function deriveSummary(body: string): string {
  const lines = body.split('\n').map((l) => l.trim())
  let seenHeading = false
  for (const line of lines) {
    if (!line) continue
    if (/^#{1,6}\s/.test(line)) {
      if (!seenHeading) {
        seenHeading = true
        continue
      }
      continue
    }
    const clean = line.replace(/^[>*\-\s]+/, '')
    if (clean) return clean.length > 240 ? `${clean.slice(0, 237)}…` : clean
  }
  return ''
}

/**
 * Interpret a plan block. Blocks emitted via emit_plan carry a JSON
 * StructuredPlan; hand-written ones are markdown. Both occur in the wild, so
 * JSON is parsed into readable fields and markdown falls back to heuristics.
 */
export function parsePlanBody(body: string): {
  title: string
  summary: string
  planType: string | null
  rendered: string
} {
  const trimmed = body.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as StructuredPlan
      if (parsed && typeof parsed === 'object' && typeof parsed.title === 'string') {
        return {
          title: parsed.title,
          summary: parsed.summary ?? '',
          planType: parsed.type ?? null,
          rendered: formatStructuredPlan(parsed)
        }
      }
    } catch {
      // Malformed JSON — fall through to the markdown heuristics.
    }
  }
  return {
    title: deriveTitle(body),
    summary: deriveSummary(body),
    planType: null,
    rendered: body
  }
}

/** Build a recall entry from a message that contains a plan block. */
export function entryFromMessage(msg: PlanBlockMessage): RecallPlanEntry | null {
  const body = extractPlanBlock(msg.contentMd)
  if (!body) return null
  const parsed = parsePlanBody(body)
  return {
    ref: `msg:${msg.id}`,
    title: parsed.title,
    summary: parsed.summary,
    source: 'message',
    status: null,
    planType: parsed.planType,
    conversationId: msg.conversationId,
    conversationTitle: msg.conversationTitle,
    createdAt: msg.createdAt,
    superseded: false,
    body: parsed.rendered
  }
}

// ── Registry-derived entries ──

/** Render a StructuredPlan as readable markdown for tool output. */
export function formatStructuredPlan(plan: StructuredPlan): string {
  const parts: string[] = []
  if (plan.summary) parts.push(plan.summary)
  if (plan.goal) parts.push(`**Goal:** ${plan.goal}`)
  if (plan.problemSummary) parts.push(`**Problem:** ${plan.problemSummary}`)
  if (plan.currentState) parts.push(`**Current state:** ${plan.currentState}`)
  if (plan.rootCause) parts.push(`**Root cause:** ${plan.rootCause}`)
  if (plan.rootCauses?.length) {
    parts.push(
      `**Root causes:**\n${plan.rootCauses
        .map((rc) => `- ${rc.title}: ${rc.description}`)
        .join('\n')}`
    )
  }
  if (plan.decisions?.length) {
    parts.push(
      `**Decisions:**\n${plan.decisions.map((d) => `- ${d.what} — ${d.why}`).join('\n')}`
    )
  }
  if (plan.phases?.length) {
    parts.push(
      `**Phases:**\n${plan.phases
        .map(
          (p) =>
            `- [${p.id}] ${p.title} (complexity ${p.complexity}, risk ${p.risk})\n  ${p.description}` +
            (p.files?.length ? `\n  files: ${p.files.map((f) => f.file).join(', ')}` : '')
        )
        .join('\n')}`
    )
  }
  if (plan.steps?.length) {
    parts.push(
      `**Steps:**\n${plan.steps
        .map((s, i) => `- ${i + 1}. ${typeof s === 'string' ? s : JSON.stringify(s)}`)
        .join('\n')}`
    )
  }
  const files = [
    ...(plan.files ?? []),
    ...(plan.filesChanged ?? []).map((f) => `${f.file} — ${f.change}`)
  ]
  if (files.length) parts.push(`**Files:**\n${files.map((f) => `- ${f}`).join('\n')}`)
  if (plan.risks?.length) {
    parts.push(
      `**Risks:**\n${plan.risks
        .map((r) => `- [${r.severity}] ${r.risk}${r.mitigation ? ` → ${r.mitigation}` : ''}`)
        .join('\n')}`
    )
  }
  if (plan.verification?.length) {
    parts.push(`**Verification:**\n${plan.verification.map((v) => `- ${v}`).join('\n')}`)
  }
  if (plan.expectedOutcome) parts.push(`**Expected outcome:** ${plan.expectedOutcome}`)
  if (plan.deferredItems?.length) {
    parts.push(`**Deferred:**\n${plan.deferredItems.map((d) => `- ${d}`).join('\n')}`)
  }
  return parts.join('\n\n')
}

/** Build a recall entry from a registry row. */
export function entryFromPlanRecord(plan: PlanRecord): RecallPlanEntry {
  return {
    ref: `plan:${plan.id}`,
    title: plan.title,
    summary: plan.summary,
    source: plan.source,
    status: plan.status,
    planType: plan.planType,
    conversationId: plan.linkedConversationId,
    createdAt: plan.createdAt,
    superseded: plan.status === 'archived',
    previousPlanId: plan.previousPlanId,
    body: formatStructuredPlan(plan.structuredPlan)
  }
}

// ── Union + dedupe ──

/** Registry rows and message entries collapse when this close together. */
const DEDUPE_WINDOW_MS = 60_000

/**
 * Merge registry and message-derived entries.
 *
 * A registry row and a message entry describe the same plan when they share a
 * conversation and were created within 60s. The registry entry wins (richer
 * metadata) and carries the message ref alongside so recall_conversation can
 * still anchor on the message.
 */
export function mergePlanEntries(
  registry: RecallPlanEntry[],
  fromMessages: RecallPlanEntry[]
): RecallPlanEntry[] {
  const merged = registry.map((entry) => ({ ...entry }))
  const claimed = new Set<number>()

  for (const msgEntry of fromMessages) {
    const matchIdx = merged.findIndex(
      (candidate, idx) =>
        !claimed.has(idx) &&
        !!candidate.conversationId &&
        candidate.conversationId === msgEntry.conversationId &&
        Math.abs(parseTs(candidate.createdAt) - parseTs(msgEntry.createdAt)) <= DEDUPE_WINDOW_MS
    )
    if (matchIdx >= 0) {
      claimed.add(matchIdx)
      merged[matchIdx].altRef = msgEntry.ref
      // The message keeps the conversation title; the registry row has none.
      merged[matchIdx].conversationTitle ??= msgEntry.conversationTitle
      continue
    }
    merged.push({ ...msgEntry })
  }

  return sortEntries(merged)
}

/** Current plans first, then newest first. */
export function sortEntries(entries: RecallPlanEntry[]): RecallPlanEntry[] {
  return [...entries].sort(
    (a, b) =>
      Number(a.superseded) - Number(b.superseded) ||
      parseTs(b.createdAt) - parseTs(a.createdAt)
  )
}

/** Case-insensitive match across title, summary and plan body. */
export function matchesQuery(entry: RecallPlanEntry, query: string | undefined): boolean {
  const term = (query ?? '').trim().toLowerCase()
  if (!term) return true
  return (
    entry.title.toLowerCase().includes(term) ||
    entry.summary.toLowerCase().includes(term) ||
    entry.body.toLowerCase().includes(term)
  )
}

// ── Output formatting ──

function shortDate(value: string): string {
  const ts = parseTs(value)
  return ts ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') : value
}

export function formatEntryList(entries: RecallPlanEntry[], query?: string): string {
  if (entries.length === 0) {
    return query
      ? `No past plans matched "${query}" in this workspace.`
      : 'No past plans recorded for this workspace.'
  }
  const header = query
    ? `${entries.length} plan(s) matching "${query}":`
    : `${entries.length} plan(s) in this workspace (newest first):`

  const lines = entries.map((entry, idx) => {
    const flags = entry.superseded ? ' [superseded]' : ''
    const meta = [
      `source: ${entry.source}`,
      entry.status ? `status: ${entry.status}` : null,
      `date: ${shortDate(entry.createdAt)}`,
      entry.conversationTitle ? `conversation: "${entry.conversationTitle}"` : null,
      entry.altRef ? `also: ${entry.altRef}` : null
    ]
      .filter(Boolean)
      .join(' · ')
    return (
      `${idx + 1}. [${entry.ref}]${flags} ${entry.title}\n` +
      `   ${meta}` +
      (entry.summary ? `\n   ${entry.summary}` : '')
    )
  })

  return `${header}\n\n${lines.join('\n\n')}\n\nUse recall_plan(ref) for the full plan, recall_conversation(ref) for the discussion around it.`
}

export function formatPlanDetail(
  entry: RecallPlanEntry,
  lineage?: { previous?: RecallPlanEntry | null; superseding?: RecallPlanEntry | null }
): string {
  const head = [
    `# ${entry.title}`,
    `ref: ${entry.ref}${entry.altRef ? ` (also ${entry.altRef})` : ''}`,
    `source: ${entry.source}${entry.status ? ` · status: ${entry.status}` : ''}${
      entry.planType ? ` · type: ${entry.planType}` : ''
    } · created: ${shortDate(entry.createdAt)}`,
    entry.superseded ? '⚠ This plan was superseded — a newer revision exists.' : null,
    lineage?.previous ? `previous revision: ${lineage.previous.ref} — ${lineage.previous.title}` : null,
    lineage?.superseding
      ? `superseded by: ${lineage.superseding.ref} — ${lineage.superseding.title}`
      : null
  ]
    .filter(Boolean)
    .join('\n')

  return `${head}\n\n---\n\n${entry.body || entry.summary || '(empty plan body)'}`
}

export interface RecallMessage {
  id: string
  role: string
  createdAt: string
  contentMd: string
}

/** Per-message cap in the conversation window. */
const MESSAGE_CHAR_CAP = 1500

/**
 * Slice a bounded window of messages around an anchor index.
 * The anchor itself is always included.
 */
export function sliceWindow<T>(
  messages: T[],
  anchorIndex: number,
  before: number,
  after: number
): { window: T[]; startIndex: number } {
  const start = Math.max(0, anchorIndex - before)
  const end = Math.min(messages.length, anchorIndex + after + 1)
  return { window: messages.slice(start, end), startIndex: start }
}

export function formatConversationWindow(opts: {
  conversationTitle: string | null
  anchorRef: string
  anchorId: string | null
  messages: RecallMessage[]
  totalInConversation: number
}): string {
  const { conversationTitle, anchorRef, anchorId, messages, totalInConversation } = opts
  if (messages.length === 0) {
    return `No messages found around ${anchorRef}.`
  }
  const body = messages
    .map((msg) => {
      const marker = msg.id === anchorId ? ' ← plan' : ''
      const content =
        msg.contentMd.length > MESSAGE_CHAR_CAP
          ? `${msg.contentMd.slice(0, MESSAGE_CHAR_CAP)}\n[…truncated]`
          : msg.contentMd
      return `### ${msg.role} · ${shortDate(msg.createdAt)}${marker}\n${content}`
    })
    .join('\n\n')

  return (
    `Conversation${conversationTitle ? ` "${conversationTitle}"` : ''} — ` +
    `${messages.length} of ${totalInConversation} messages around ${anchorRef}\n\n${body}`
  )
}
