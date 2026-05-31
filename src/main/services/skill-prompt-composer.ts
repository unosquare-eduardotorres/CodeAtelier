import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { BudgetTier, Skill } from '../../shared/types'
import { promptBuilderLogger } from '../logger'
import { skillRepository } from '../db/repositories/skill.repository'
import { BASELINE_SKILL_FILENAMES } from '../../shared/constants'

const log = promptBuilderLogger

/**
 * Encapsulates all skill-related prompt composition logic.
 *
 * Extracted from PromptBuilder to reduce complexity and enable independent testing.
 * Handles tiered skill loading, relevance scoring, section extraction,
 * and baseline skill assembly with an mtime-based file cache.
 */
export class SkillPromptComposer {
  /**
   * Strategy O: In-memory skill file cache with mtime invalidation.
   * SKILL.md files rarely change during a session — cache them to eliminate
   * per-turn readFileSync() calls and truncation overhead.
   */
  private skillFileCache: Map<string, { content: string; mtimeMs: number }> = new Map()

  /**
   * Applies optional per-conversation skill overrides to the assigned skill list.
   * When no overrides are provided, preserves the original list.
   */
  filterAssignedSkills(skills: Skill[], skillOverrides?: string[]): Skill[] {
    if (!skillOverrides) return skills

    const overrideSet = new Set(
      skillOverrides.map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0)
    )

    return skills.filter((skill) => {
      const id = skill.id.toLowerCase()
      const name = skill.name.toLowerCase()
      const filename = skill.filename.toLowerCase()
      return overrideSet.has(id) || overrideSet.has(name) || overrideSet.has(filename)
    })
  }

  /**
   * Build deduplicated skill content for a specialist.
   *
   * Strategy 3: Tiered skill loading — intelligently selects content:
   * - Tier 1 (core principles, first ~1000 chars) — always included
   * - Tier 2 (remaining content up to budget) — included for standard/full budgets
   * Budget per skill scales with tier: minimal=500, standard=2000, full=4000
   *
   * Strategy 8 (Selective Skill Loading): When multiple skills are assigned,
   * the most relevant skill (by keyword match against task context) gets the
   * full budget; remaining skills get a condensed summary (~200 chars).
   */
  buildSkillContent(
    skills: Skill[],
    budgetTier: BudgetTier = 'standard',
    taskContext?: string
  ): string {
    const activeSkills = skills.filter((s) => s.isActive)
    if (activeSkills.length === 0) return ''
    const normalizedTaskContext = taskContext?.trim().toLowerCase()
    if (normalizedTaskContext) {
      const hasRelevantSkill = activeSkills.some(
        (skill) => this.skillRelevanceScore(skill, normalizedTaskContext) > 0
      )
      if (!hasRelevantSkill) {
        log.info('Skipping skill content: no active skill matches task context relevance')
        return ''
      }
    }

    const baseBudget = budgetTier === 'minimal' ? 500 : budgetTier === 'full' ? 4000 : 2000

    // Selective skill loading: rank skills by relevance when >1 skill and we have task context
    let rankedSkills = activeSkills
    if (activeSkills.length > 1 && normalizedTaskContext && budgetTier !== 'full') {
      rankedSkills = [...activeSkills].sort((a, b) => {
        const scoreA = this.skillRelevanceScore(a, normalizedTaskContext)
        const scoreB = this.skillRelevanceScore(b, normalizedTaskContext)
        return scoreB - scoreA
      })
    }

    const sections: string[] = []

    for (let i = 0; i < rankedSkills.length; i++) {
      const skill = rankedSkills[i]
      const isPrimary = i === 0
      // Strategy 6: Skip secondary skills entirely for non-full budget
      if (!isPrimary && budgetTier !== 'full') continue
      const budget = isPrimary ? baseBudget : Math.min(200, baseBudget)

      try {
        let selected: string | null = null

        // Try tier2_instructions for minimal/standard budgets (fast path, no disk I/O)
        if (skill.tier2Instructions && budgetTier === 'minimal') {
          selected = skill.tier2Instructions.substring(0, budget)
          log.info(
            `Skill "${skill.name}" using tier2 instructions (${selected.length} chars, budget: minimal)`
          )
        }

        // Try pre-computed semantic summary (token-optimized, ~50-60% savings)
        if (!selected) {
          const summaryTier = isPrimary ? budgetTier : 'minimal'
          const summary = skillRepository.getSummary(skill.id, summaryTier)

          if (summary) {
            selected = summary
            log.info(
              `Skill "${skill.name}" using pre-computed ${summaryTier} summary (${summary.length} chars)`
            )
          }
        }

        // For standard budget with tier2: use tier2 + summary blend
        if (!selected && skill.tier2Instructions && budgetTier === 'standard') {
          selected = skill.tier2Instructions.substring(0, budget)
          log.info(
            `Skill "${skill.name}" using tier2 instructions (${selected.length} chars, budget: standard)`
          )
        }

        // Fallback: read from disk if no pre-computed data available
        if (!selected) {
          const content = this.readSkillFile(skill.filePath)

          if (content.length <= budget) {
            selected = content
          } else if (!isPrimary || budgetTier === 'minimal') {
            selected = content.substring(0, budget) + '\n\n[... see full skill file for details]'
          } else {
            selected = this.extractSkillSections(content, budget)
          }

          if (content.length > budget) {
            log.info(
              `Skill "${skill.name}" ${isPrimary ? 'trimmed' : 'condensed'} from ${content.length} to ~${budget} chars (budget: ${budgetTier}, fallback — no summary)`
            )
          }
        }

        sections.push(`## Skill: ${skill.name}\n${selected}`)
      } catch {
        log.warn(`Could not read skill file: ${skill.filePath}`)
      }
    }

    // Strategy 6: 4K hard cap on total skill content
    const SKILL_HARD_CAP = 4000
    const totalContent = sections.join('\n\n')
    if (totalContent.length > SKILL_HARD_CAP) {
      let accumulated = ''
      const capped: string[] = []
      for (const section of sections) {
        if (accumulated.length + section.length + 2 > SKILL_HARD_CAP) break
        capped.push(section)
        accumulated += section + '\n\n'
      }
      log.info(
        `Skill content hard-capped: ${totalContent.length} → ${accumulated.length} chars (${SKILL_HARD_CAP} limit)`
      )
      return capped.join('\n\n')
    }
    return totalContent
  }

  /**
   * Build the always-on baseline skills layer.
   *
   * Reads SKILL.md files listed in BASELINE_SKILL_FILENAMES from .claude/skills/.
   * These are behavioral guidelines (not domain skills) injected into every
   * prompt path — DaVinci, Project Specialist, and local LLM.
   */
  buildBaselineSkillsLayer(budgetTier: BudgetTier = 'standard'): string {
    const sections: string[] = []
    const baseBudget = budgetTier === 'minimal' ? 2500 : budgetTier === 'full' ? 4000 : 2000

    for (const filename of BASELINE_SKILL_FILENAMES) {
      const filePath = join(this.getBaselineSkillsDir(), filename, 'SKILL.md')
      try {
        const content = this.readSkillFile(filePath)
        const trimmed = content.length > baseBudget
          ? content.substring(0, baseBudget) + '\n\n[... truncated]'
          : content
        sections.push(trimmed)
      } catch {
        log.warn(`Baseline skill not found: ${filePath}`)
      }
    }

    if (sections.length === 0) return ''
    return `## Coding Principles\n\n${sections.join('\n\n')}`
  }

  // ── Private helpers ──

  /**
   * Strategy O: Read a skill file with in-memory caching and mtime invalidation.
   */
  private readSkillFile(filePath: string): string {
    const cached = this.skillFileCache.get(filePath)
    try {
      const stat = statSync(filePath)
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        return cached.content
      }
      const content = readFileSync(filePath, 'utf-8')
      this.skillFileCache.set(filePath, { content, mtimeMs: stat.mtimeMs })
      return content
    } catch {
      const content = readFileSync(filePath, 'utf-8')
      return content
    }
  }

  /**
   * Scores a skill's relevance to the given task context by keyword matching.
   * Uses Tier 1 keywords (from structured tier1_json) for fast matching.
   */
  private skillRelevanceScore(skill: Skill, contextLower: string): number {
    let keywords: string[]

    if (skill.tier1Json) {
      try {
        const tier1 = JSON.parse(skill.tier1Json) as { keywords?: string[] }
        keywords = tier1.keywords ?? []
      } catch {
        keywords = []
      }
    } else {
      keywords = skill.name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .split(/[\s-]+/)
        .filter((w) => w.length > 2)
    }

    return keywords.reduce((score, kw) => score + (contextLower.includes(kw) ? 1 : 0), 0)
  }

  /**
   * Extracts skill content intelligently by preserving complete markdown sections
   * up to the budget limit, rather than cutting mid-sentence.
   */
  private extractSkillSections(content: string, budget: number): string {
    const sectionRegex = /^## .+$/gm
    const sections: { start: number; header: string }[] = []
    let match: RegExpExecArray | null

    while ((match = sectionRegex.exec(content)) !== null) {
      sections.push({ start: match.index, header: match[0] })
    }

    if (sections.length === 0) {
      return content.substring(0, budget) + '\n\n[... truncated]'
    }

    let result = ''
    const preamble = content.substring(0, sections[0].start).trim()
    if (preamble) {
      result = preamble + '\n\n'
    }

    for (let i = 0; i < sections.length; i++) {
      const sectionEnd = i + 1 < sections.length ? sections[i + 1].start : content.length
      const sectionContent = content.substring(sections[i].start, sectionEnd)

      if (result.length + sectionContent.length <= budget) {
        result += sectionContent
      } else {
        const remaining = budget - result.length - 30
        if (remaining > 100) {
          result += sectionContent.substring(0, remaining) + '\n\n[... truncated]'
        } else {
          result += '\n\n[... additional sections omitted]'
        }
        break
      }
    }

    return result.trim()
  }

  /** Returns the .claude/skills/ directory path */
  private getBaselineSkillsDir(): string {
    try {
      const { app } = require('electron')
      return app.isPackaged
        ? join(app.getPath('userData'), '.claude', 'skills')
        : join(process.cwd(), '.claude', 'skills')
    } catch {
      return join(process.cwd(), '.claude', 'skills')
    }
  }
}

/** Singleton instance */
export const skillPromptComposer = new SkillPromptComposer()
