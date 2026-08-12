/**
 * memory-projection — renders the fact database as reviewable markdown.
 *
 * Facts live only in SQLite, which makes them invisible in a pull request,
 * impossible to diff, and impossible to hand-correct. This projects them to
 * `.agentstudio/memory/` as a bounded index plus per-topic files:
 *
 *   .agentstudio/memory/
 *   ├── MEMORY.md      generated index, one line per fact, highest tier first
 *   └── <topic>.md     per-tag detail, read on demand
 *
 * The database stays the source of truth; markdown is a generated view. Each
 * file carries `modified:` and `factIds:` frontmatter so a later round-trip can
 * tell which facts an edited file came from.
 *
 * The index is budgeted rather than truncated. A silently cut-off index is
 * worse than a smaller one: you cannot tell whether a convention is absent or
 * merely off the end. When the budget binds, the lowest-value facts are pruned
 * and the count is reported so the caller can say so.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log'
import type { MemoryFact } from '../../shared/types'
import { memoryFactRepository } from '../db/repositories/memory-fact.repository'

const projLog = log.scope('memory-projection')

// ── Configuration ───────────────────────────────────────────────────────────

/** Directory this app owns inside a workspace (matches hook-engine.service). */
export const MEMORY_DIR = join('.agentstudio', 'memory')

export const INDEX_FILENAME = 'MEMORY.md'

/**
 * Index budget. Borrowed from Claude Code's auto-memory limits: an index that
 * is always loaded has to stay small enough to be worth always loading.
 */
export const MAX_INDEX_LINES = 200
export const MAX_INDEX_BYTES = 25_000

/** Facts per topic file. Beyond this a topic is too coarse to be useful. */
const MAX_FACTS_PER_TOPIC = 100

/** Topics with fewer than this many facts are folded into `general`. */
const MIN_TOPIC_SIZE = 3

/** Tags that describe provenance rather than subject matter. */
const NON_TOPIC_TAGS = new Set([
  'bootstrap',
  'docs',
  'architecture',
  'history',
  'stack',
  'structure',
  'instructions',
  'session',
  'commit',
  'manual',
  'agent-exploration'
])

const TIER_LABELS = ['Observed', 'Confirmed', 'Established', 'Wisdom'] as const

export interface ProjectionResult {
  indexPath: string
  topicPaths: string[]
  factsProjected: number
  /** Facts dropped from the index to stay inside the budget. */
  factsPruned: number
  warnings: string[]
}

// ── Service ─────────────────────────────────────────────────────────────────

class MemoryProjectionService {
  /**
   * Write the whole projection for a workspace.
   *
   * Safe to call repeatedly: every file is regenerated from the database, so a
   * stale topic file from a previous run is overwritten rather than merged.
   */
  project(workspaceId: string, workspacePath: string): ProjectionResult {
    const facts = memoryFactRepository.findByWorkspace(workspaceId, 'active')
    return this.projectFacts(facts, workspacePath)
  }

  /** Projection from an explicit fact list — the testable core of `project`. */
  projectFacts(facts: MemoryFact[], workspacePath: string): ProjectionResult {
    const dir = join(workspacePath, MEMORY_DIR)
    mkdirSync(dir, { recursive: true })

    const now = new Date().toISOString()
    const warnings: string[] = []

    const { kept, pruned } = selectForIndex(facts)
    if (pruned > 0) {
      warnings.push(
        `${pruned} fact(s) omitted from MEMORY.md to stay within the ` +
          `${MAX_INDEX_LINES}-line / ${Math.round(MAX_INDEX_BYTES / 1000)}KB index budget. ` +
          `They remain in the database and in their topic files.`
      )
    }

    const topics = groupByTopic(facts)
    const topicPaths: string[] = []

    for (const [topic, topicFacts] of topics) {
      const filename = `${topic}.md`
      const path = join(dir, filename)
      writeFileSync(path, renderTopicFile(topic, topicFacts, now), 'utf-8')
      topicPaths.push(join(MEMORY_DIR, filename))
    }

    const indexPath = join(dir, INDEX_FILENAME)
    writeFileSync(indexPath, renderIndex(kept, [...topics.keys()], now), 'utf-8')

    projLog.info(
      `[project] Wrote ${kept.length} fact(s) to MEMORY.md and ` +
        `${topicPaths.length} topic file(s) (${pruned} pruned from index)`
    )

    return {
      indexPath: join(MEMORY_DIR, INDEX_FILENAME),
      topicPaths,
      factsProjected: kept.length,
      factsPruned: pruned,
      warnings
    }
  }

  /**
   * Fact ids referenced by the projection currently on disk.
   *
   * The round-trip path uses this to tell which facts a hand-edited file was
   * generated from, without having to re-derive the grouping.
   */
  readProjectedIds(workspacePath: string): Map<string, string[]> {
    const dir = join(workspacePath, MEMORY_DIR)
    const out = new Map<string, string[]>()
    if (!existsSync(dir)) return out

    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return out
    }

    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue
      try {
        const raw = readFileSync(join(dir, entry), 'utf-8')
        out.set(entry, parseFactIds(raw))
      } catch {
        /* unreadable file — skip */
      }
    }
    return out
  }
}

// ── Index selection ─────────────────────────────────────────────────────────

/**
 * Choose which facts the always-loaded index carries.
 *
 * Ranked by tier then confidence, then pruned by two cheap rules before the
 * budget is applied by simple truncation of the ranked tail:
 *   1. near-duplicate titles collapse to their highest-tier representative
 *   2. tier-0 observations go first, since they are the least established
 */
export function selectForIndex(facts: MemoryFact[]): { kept: MemoryFact[]; pruned: number } {
  const ranked = [...facts].sort(rankForIndex)

  // Collapse near-duplicates: same normalised title keeps the best-ranked one.
  const bestByTitle = new Map<string, MemoryFact>()
  for (const fact of ranked) {
    const key = normalizeTitle(fact.title)
    if (!bestByTitle.has(key)) bestByTitle.set(key, fact)
  }
  const deduped = [...bestByTitle.values()]

  // Apply the budget, dropping the weakest first (the list is already ranked).
  const kept: MemoryFact[] = []
  let bytes = 0
  let lines = 0

  for (const fact of deduped) {
    const line = renderIndexLine(fact)
    if (lines + 1 > MAX_INDEX_LINES || bytes + line.length > MAX_INDEX_BYTES) break
    kept.push(fact)
    lines++
    bytes += line.length
  }

  return { kept, pruned: facts.length - kept.length }
}

/** Highest tier first, then most confident, then most recently updated. */
function rankForIndex(a: MemoryFact, b: MemoryFact): number {
  if (b.tier !== a.tier) return b.tier - a.tier
  if (b.confidence !== a.confidence) return b.confidence - a.confidence
  return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
}

/** Titles differing only in case, punctuation or spacing are the same title. */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// ── Topic grouping ──────────────────────────────────────────────────────────

/**
 * Group facts into topic files by their most specific subject tag.
 *
 * Provenance tags (`bootstrap`, `docs`, …) say where a fact came from, not what
 * it is about, so they never name a topic. A fact with no subject tag falls
 * back to its category, which always exists.
 */
export function groupByTopic(facts: MemoryFact[]): Map<string, MemoryFact[]> {
  const byTopic = new Map<string, MemoryFact[]>()

  for (const fact of facts) {
    const topic = pickTopic(fact)
    const bucket = byTopic.get(topic)
    if (bucket) bucket.push(fact)
    else byTopic.set(topic, [fact])
  }

  // Fold thin topics together so the directory does not fill with one-fact files.
  const general: MemoryFact[] = []
  for (const [topic, bucket] of [...byTopic]) {
    if (bucket.length < MIN_TOPIC_SIZE && topic !== 'general') {
      general.push(...bucket)
      byTopic.delete(topic)
    }
  }
  if (general.length > 0) {
    byTopic.set('general', [...(byTopic.get('general') ?? []), ...general])
  }

  for (const [topic, bucket] of byTopic) {
    bucket.sort(rankForIndex)
    if (bucket.length > MAX_FACTS_PER_TOPIC) {
      byTopic.set(topic, bucket.slice(0, MAX_FACTS_PER_TOPIC))
    }
  }

  return new Map([...byTopic].sort((a, b) => a[0].localeCompare(b[0])))
}

function pickTopic(fact: MemoryFact): string {
  const subjectTag = fact.tags.find((t) => t && !NON_TOPIC_TAGS.has(t.toLowerCase()))
  return slugify(subjectTag ?? fact.category)
}

/** Filesystem-safe topic slug. */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || 'general'
}

// ── Rendering ───────────────────────────────────────────────────────────────

/** One index line per fact: tier, category, title, scope, id. */
export function renderIndexLine(fact: MemoryFact): string {
  const tier = `T${fact.tier}`
  const scope = fact.scopePaths.length > 0 ? ` _(${fact.scopePaths.slice(0, 3).join(', ')})_` : ''
  return `- **[${tier}/${fact.category}]** ${oneLine(fact.title)} — ${oneLine(fact.content, 160)}${scope} \`${fact.id}\`\n`
}

/** The always-loaded index. */
export function renderIndex(facts: MemoryFact[], topics: string[], now: string): string {
  const header = [
    '---',
    `modified: ${now}`,
    `factCount: ${facts.length}`,
    `factIds: [${facts.map((f) => f.id).join(', ')}]`,
    '---',
    '',
    '# Project Memory',
    '',
    '<!-- Generated from the memory database. The database is the source of',
    '     truth; edits here are read back as proposals, not applied directly. -->',
    ''
  ].join('\n')

  if (facts.length === 0) {
    return `${header}\n_No facts recorded yet._\n`
  }

  const sections: string[] = []
  for (let tier = 3; tier >= 0; tier--) {
    const inTier = facts.filter((f) => f.tier === tier)
    if (inTier.length === 0) continue
    sections.push(`## ${TIER_LABELS[tier]} (T${tier})\n\n${inTier.map(renderIndexLine).join('')}`)
  }

  const topicIndex =
    topics.length > 0
      ? `\n## Topic files\n\n${topics.map((t) => `- [\`${t}.md\`](./${t}.md)`).join('\n')}\n`
      : ''

  return `${header}\n${sections.join('\n')}${topicIndex}`
}

/** A per-topic detail file. */
export function renderTopicFile(topic: string, facts: MemoryFact[], now: string): string {
  const header = [
    '---',
    `topic: ${topic}`,
    `modified: ${now}`,
    `factCount: ${facts.length}`,
    `factIds: [${facts.map((f) => f.id).join(', ')}]`,
    '---',
    '',
    `# ${topic}`,
    ''
  ].join('\n')

  const body = facts
    .map((fact) => {
      const meta = [
        `tier ${fact.tier} (${TIER_LABELS[fact.tier] ?? 'Observed'})`,
        `confidence ${(fact.confidence * 100).toFixed(0)}%`,
        fact.scopePaths.length > 0 ? `scope ${fact.scopePaths.join(', ')}` : null,
        fact.sourceRef
          ? `source ${fact.sourceType} (${fact.sourceRef})`
          : `source ${fact.sourceType}`
      ]
        .filter(Boolean)
        .join(' · ')

      return `## ${oneLine(fact.title)}\n\n${fact.content.trim()}\n\n_${meta}_ \`${fact.id}\`\n`
    })
    .join('\n')

  return `${header}\n${body}`
}

/** Collapse newlines so a fact always occupies exactly one index line. */
function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Fact ids listed in a projected file's frontmatter. */
export function parseFactIds(raw: string): string[] {
  const match = /^---[\s\S]*?factIds:\s*\[([^\]]*)\][\s\S]*?^---/m.exec(raw)
  if (!match) return []
  return match[1]
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
}

export const memoryProjectionService = new MemoryProjectionService()
