import { createHash } from 'node:crypto'
import type { Skill } from '../../shared/types'

/**
 * SkillSummaryService — generates pre-computed semantic summaries from SKILL.md content.
 *
 * Uses deterministic extraction (no LLM needed) at three tiers:
 * - full   (~2000 chars): Preamble + section headers + first paragraph each + critical code fences
 * - standard (~800 chars): Preamble + only high-signal sections (non-negotiable, critical, always/never rules)
 * - minimal  (~200 chars): Skill name + frontmatter description only
 *
 * Summaries are stored in the DB alongside the skill and regenerated when SKILL.md content changes
 * (detected via SHA-256 hash comparison).
 */

/** Budget targets per tier (chars) */
const TIER_BUDGETS = {
  full: 2000,
  standard: 800,
  minimal: 200
} as const

/** Keywords that indicate high-signal sections for standard tier */
const HIGH_SIGNAL_KEYWORDS = [
  'non-negotiable',
  'critical',
  'always',
  'never',
  'key rules',
  'required',
  'must',
  'important',
  'do not',
  'security',
  'mandatory'
]

interface ParsedFrontmatter {
  name: string
  description: string
  body: string
}

interface SkillSummaries {
  full: string
  standard: string
  minimal: string
}

/**
 * Parse YAML frontmatter from SKILL.md content.
 * Returns name, description, and remaining body.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/)
  if (!fmMatch) {
    return { name: '', description: '', body: content }
  }

  const fmBlock = fmMatch[1]
  const body = content.slice(fmMatch[0].length)

  // Extract name field
  const nameMatch = fmBlock.match(/^name:\s*(.+)$/m)
  const name = nameMatch ? nameMatch[1].trim() : ''

  // Extract description — handles both inline and multi-line (>, |) YAML values
  let description = ''
  const descInlineMatch = fmBlock.match(/^description:\s*(.+)$/m)
  const descBlockMatch = fmBlock.match(/^description:\s*[>|]\s*\n((?:[ \t]+.+\n?)+)/m)

  if (descBlockMatch) {
    description = descBlockMatch[1]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .join(' ')
  } else if (descInlineMatch) {
    description = descInlineMatch[1].trim()
  }

  return { name, description, body }
}

/**
 * Split markdown body into sections by ## headings.
 * Returns an array of { header, content } pairs.
 * Content before the first heading is returned with header = '' (preamble).
 */
export function splitSections(body: string): { header: string; content: string }[] {
  const sections: { header: string; content: string }[] = []
  const sectionRegex = /^## .+$/gm
  const matches: { index: number; header: string }[] = []
  let match: RegExpExecArray | null

  while ((match = sectionRegex.exec(body)) !== null) {
    matches.push({ index: match.index, header: match[0] })
  }

  // Preamble (content before first heading)
  if (matches.length > 0) {
    const preamble = body.slice(0, matches[0].index).trim()
    if (preamble) {
      sections.push({ header: '', content: preamble })
    }
  } else {
    // No headings at all — entire body is preamble
    const trimmed = body.trim()
    if (trimmed) sections.push({ header: '', content: trimmed })
    return sections
  }

  for (let i = 0; i < matches.length; i++) {
    const end = i + 1 < matches.length ? matches[i + 1].index : body.length
    const sectionBody = body.slice(matches[i].index + matches[i].header.length, end).trim()
    sections.push({ header: matches[i].header, content: sectionBody })
  }

  return sections
}

/**
 * Extract the first paragraph from section content.
 * A paragraph ends at the first blank line or heading.
 */
export function firstParagraph(content: string): string {
  const lines = content.split('\n')
  const result: string[] = []
  let started = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (!started) {
      if (trimmed.length > 0) {
        started = true
        result.push(line)
      }
    } else {
      if (trimmed.length === 0 || trimmed.startsWith('#')) break
      result.push(line)
    }
  }

  return result.join('\n').trim()
}

/**
 * Check if a section contains high-signal keywords indicating critical rules.
 */
export function isHighSignalSection(header: string, content: string): boolean {
  const combined = (header + ' ' + content).toLowerCase()
  return HIGH_SIGNAL_KEYWORDS.some((kw) => combined.includes(kw))
}

/**
 * Generate a full-tier summary (~2000 chars).
 * Includes: preamble + all section headers + first paragraph of each + critical code fences.
 */
function generateFullSummary(
  frontmatter: ParsedFrontmatter,
  sections: ReturnType<typeof splitSections>
): string {
  const budget = TIER_BUDGETS.full
  const parts: string[] = []

  // Start with identity line
  if (frontmatter.name) {
    const identity = frontmatter.description
      ? `# ${frontmatter.name}\n${frontmatter.description}`
      : `# ${frontmatter.name}`
    parts.push(identity)
  }

  for (const section of sections) {
    const paragraph = firstParagraph(section.content)
    if (section.header) {
      // Include header + first paragraph
      const entry = paragraph ? `${section.header}\n${paragraph}` : section.header
      parts.push(entry)
    } else if (paragraph && !frontmatter.description) {
      // Preamble — include if no frontmatter description
      parts.push(paragraph)
    }
  }

  // Build and truncate to budget
  return truncateToBudget(parts, budget)
}

/**
 * Generate a standard-tier summary (~800 chars).
 * Includes: identity + only high-signal sections (non-negotiable, critical, always/never).
 */
function generateStandardSummary(
  frontmatter: ParsedFrontmatter,
  sections: ReturnType<typeof splitSections>
): string {
  const budget = TIER_BUDGETS.standard
  const parts: string[] = []

  // Identity line
  if (frontmatter.name) {
    const identity = frontmatter.description
      ? `# ${frontmatter.name}\n${frontmatter.description}`
      : `# ${frontmatter.name}`
    parts.push(identity)
  }

  // Only include high-signal sections
  for (const section of sections) {
    if (!section.header) continue // skip preamble for standard
    if (isHighSignalSection(section.header, section.content)) {
      const paragraph = firstParagraph(section.content)
      const entry = paragraph ? `${section.header}\n${paragraph}` : section.header
      parts.push(entry)
    }
  }

  // If no high-signal sections found, include headers as a table of contents
  if (parts.length <= 1) {
    const headers = sections.filter((s) => s.header).map((s) => s.header)
    if (headers.length > 0) {
      parts.push(headers.join('\n'))
    }
  }

  return truncateToBudget(parts, budget)
}

/**
 * Generate a minimal-tier summary (~200 chars).
 * Just the skill name + frontmatter description.
 */
function generateMinimalSummary(
  frontmatter: ParsedFrontmatter,
  sections: ReturnType<typeof splitSections>
): string {
  const budget = TIER_BUDGETS.minimal

  if (frontmatter.name && frontmatter.description) {
    const text = `${frontmatter.name}: ${frontmatter.description}`
    return text.length <= budget ? text : text.substring(0, budget - 3) + '...'
  }

  if (frontmatter.name) return frontmatter.name.substring(0, budget)

  // Fallback: first line of body
  const preamble = sections.find((s) => !s.header)
  if (preamble) {
    const firstLine = preamble.content.split('\n')[0].replace(/^#+ /, '').trim()
    return firstLine.substring(0, budget)
  }

  return ''
}

/**
 * Join parts with double newlines, truncating to budget.
 * Preserves complete parts where possible.
 */
function truncateToBudget(parts: string[], budget: number): string {
  let result = ''

  for (const part of parts) {
    const separator = result ? '\n\n' : ''
    if (result.length + separator.length + part.length <= budget) {
      result += separator + part
    } else {
      // Try to fit a truncated version of this part
      const remaining = budget - result.length - separator.length
      if (remaining > 50) {
        result += separator + part.substring(0, remaining - 3) + '...'
      }
      break
    }
  }

  return result.trim()
}

// ── Public API ──

export class SkillSummaryService {
  /** Generate tiered summaries for a skill's SKILL.md content */
  generateSummaries(skillContent: string): SkillSummaries {
    const frontmatter = parseFrontmatter(skillContent)
    const sections = splitSections(frontmatter.body)

    return {
      full: generateFullSummary(frontmatter, sections),
      standard: generateStandardSummary(frontmatter, sections),
      minimal: generateMinimalSummary(frontmatter, sections)
    }
  }

  /** SHA-256 hash of content for staleness detection */
  contentHash(content: string): string {
    return createHash('sha256').update(content).digest('hex')
  }

  /** Check if summaries need regeneration */
  isStale(skill: Skill, currentContent: string): boolean {
    if (!skill.summaryHash || !skill.summaryFull) return true
    return skill.summaryHash !== this.contentHash(currentContent)
  }
}

export const skillSummaryService = new SkillSummaryService()
