import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { BudgetTier, ConversationMode, Skill } from '../../shared/types'
import { promptBuilderLogger } from '../logger'
import { coreAgentPromptRepository } from '../db/repositories/core-agent-prompt.repository'
import { skillRepository } from '../db/repositories/skill.repository'
import { DEFAULT_PROMPTS } from './default-prompts'

// ── Prompt Builder Types ──

type PromptRole = 'da-vinci'

interface PromptBuildOptions {
  /** Which agent role is this prompt for (currently always 'da-vinci') */
  role: PromptRole
  /** Conversation mode (plan or build) */
  mode: ConversationMode
  /** Workspace path for CLAUDE.md project context injection */
  workspacePath?: string
  /** Include auto memory context (generalist only) */
  memoryContext?: string
  /** Budget tier — controls context size for model-aware prompt budgeting (Strategy 4) */
  budgetTier?: BudgetTier
  /** Persona specialist ID for generalist impersonation (null = no persona) */
  personaSpecialistId?: string | null
  /** Persona specialist prompt content (from specialist.prompt field) */
  personaPrompt?: string
  /** Skills assigned to the persona specialist */
  personaSkills?: Skill[]
  /** Per-conversation skill overrides for the persona specialist */
  personaSkillOverrides?: string[]
}

export interface GeneralistConditionalSections {
  includeAskQuestionPrompt: boolean
  includeMemoryProtocolPrompt: boolean
  includeImageAttachmentsPrompt: boolean
  /** Strategy 3: Nudge generalist to answer directly for simple questions */
  includeDirectAnswerBoost: boolean
}

// ── Prompt Builder ──

const log = promptBuilderLogger

/**
 * Centralized prompt assembly for the DaVinci generalist.
 *
 * Assembles: optional persona overlay (when impersonating a specialist) + base role prompt
 * + CLAUDE.md project context + auto memory context.
 *
 * Note: Project Specialists use their own dedicated adapter (project-specialist.adapter.ts)
 * that reads `specialists.prompt` directly — they do not go through this builder.
 */
export class PromptBuilder {
  /**
   * Strategy G: In-memory CLAUDE.md cache with mtime invalidation.
   * Eliminates disk I/O on every turn — reads once and re-reads only when the file changes.
   */
  private claudeMdCache: Map<string, { content: string; mtimeMs: number }> = new Map()

  /**
   * Strategy O: In-memory skill file cache with mtime invalidation.
   * SKILL.md files rarely change during a session — cache them to eliminate
   * per-turn readFileSync() calls and truncation overhead.
   */
  private skillFileCache: Map<string, { content: string; mtimeMs: number }> = new Map()

  /** Turn-based budget profile for generalist prompt assembly (S17 adaptive prompt). */
  getGeneralistBudgetTierForTurn(turnCount: number): BudgetTier {
    if (turnCount <= 1) return 'full'
    if (turnCount <= 4) return 'standard'
    return 'minimal'
  }

  /**
   * Lightweight heuristics to decide which optional generalist prompt sections
   * should be injected for the current user turn (S12 conditional injection).
   */
  getGeneralistConditionalSections(
    message: string,
    hasImages: boolean
  ): GeneralistConditionalSections {
    const normalized = message.toLowerCase()

    const includeAskQuestionPrompt =
      /\b(which|choose|choice|option|pick|select|either|vs|versus|should i|what do you prefer)\b/i.test(
        normalized
      )

    const includeMemoryProtocolPrompt =
      /\b(remember|preference|prefer|i like|i dislike|always|never|for future|from now on|note this|keep in mind)\b/i.test(
        normalized
      )

    // Strategy 3: Direct Answer Boost — classify simple questions that can be answered directly.
    // Simple questions are short, use interrogative verbs, and DON'T request code mutations.
    // Analysis verbs (investigate, diagnose, audit, review) do NOT suppress the boost —
    // they're questions the generalist can often answer directly from context.
    const isQuestionPattern =
      /\b(what|why|how|where|which|explain|show me|list|describe|tell me|is there)\b/i.test(
        normalized
      )
    const isMutationRequest =
      /\b(fix|implement|build|create|add|refactor|update|change|modify|delete|remove|write|migrate|deploy|scaffold|generate)\b/i.test(
        normalized
      )
    const includeDirectAnswerBoost = isQuestionPattern && !isMutationRequest && message.length < 300

    return {
      includeAskQuestionPrompt,
      includeMemoryProtocolPrompt,
      includeImageAttachmentsPrompt: hasImages,
      includeDirectAnswerBoost
    }
  }

  /**
   * Build a complete system prompt for the DaVinci generalist role.
   * Composes prompt from layers (persona overlay, role, project context, memory).
   */
  build(options: PromptBuildOptions): string {
    const layers: string[] = []
    const budgetTier = options.budgetTier ?? 'standard'

    this.appendPersonaLayer(layers, options, budgetTier)
    this.appendRoleAndIdentityLayers(layers, options)
    this.appendProjectContextLayer(layers, options, budgetTier)
    this.appendMemoryContextLayer(layers, options)

    return layers.join('\n\n---\n\n')
  }

  /**
   * Build the CLAUDE.md project-context layer as a standalone string.
   *
   * Used by ProjectSpecialistRoleAdapter — specialists assemble their own
   * system prompt (mode + identity + CLAUDE.md + MCP guidance) instead of
   * going through `build()`. The mtime-based `claudeMdCache` shared with
   * the generalist path keeps disk reads cheap.
   *
   * Returns the formatted block (`## Workspace Project Context (from CLAUDE.md)\n\n<extracted>`)
   * or an empty string when no CLAUDE.md exists or the workspace is unset.
   */
  buildClaudeMdLayer(
    workspacePath: string,
    mode: ConversationMode,
    budgetTier: BudgetTier = 'standard'
  ): string {
    if (!workspacePath) return ''
    const projectContext = this.readProjectContext(workspacePath, 'da-vinci', mode, budgetTier)
    if (!projectContext) return ''
    return `## Workspace Project Context (from CLAUDE.md)\n\n${projectContext}`
  }

  /**
   * Layer 0: Persona specialist identity + skills.
   * Injected BEFORE the DaVinci role prompt so the LLM sees itself as the specialist first.
   */
  private appendPersonaLayer(
    layers: string[],
    options: PromptBuildOptions,
    budgetTier: BudgetTier
  ): void {
    if (!options.personaSpecialistId || !options.personaPrompt) {
      return
    }
    layers.push(
      `## Your Specialized Identity\n\n` +
        `You are operating with the following domain expertise. ` +
        `Apply it to all conversations and analyses.\n\n` +
        options.personaPrompt
    )
    if (options.personaSkills && options.personaSkills.length > 0) {
      const filtered = this.filterAssignedSkills(
        options.personaSkills,
        options.personaSkillOverrides
      )
      if (filtered.length > 0) {
        const content = this.buildSkillContent(filtered, budgetTier)
        if (content) layers.push(`## Domain Skills\n\n${content}`)
      }
    }
  }

  /**
   * Layer 1: Base role prompt (from DB, user-editable).
   */
  private appendRoleAndIdentityLayers(layers: string[], options: PromptBuildOptions): void {
    layers.push(this.getRolePrompt(options.role, options.mode))
  }

  /**
   * Layer 4: Workspace project context (CLAUDE.md — project sections only).
   * Progressive by mode: build slim, plan ultra-light.
   */
  private appendProjectContextLayer(
    layers: string[],
    options: PromptBuildOptions,
    budgetTier: BudgetTier
  ): void {
    if (!options.workspacePath) return

    const projectContext = this.readProjectContext(
      options.workspacePath,
      options.role,
      options.mode,
      budgetTier
    )
    if (projectContext) {
      layers.push(`## Workspace Project Context (from CLAUDE.md)\n\n${projectContext}`)
    }
  }

  /**
   * Layer 5: Auto Memory context.
   */
  private appendMemoryContextLayer(layers: string[], options: PromptBuildOptions): void {
    if (options.memoryContext) {
      layers.push(`## Auto Memory\n\n${options.memoryContext}`)
    }
  }

  // ── Private layer builders ──

  private getRolePrompt(role: PromptRole, mode: ConversationMode): string {
    // Read from DB (user-editable). Falls back to defaults if DB is empty.
    const dbPrompt = coreAgentPromptRepository.findByRoleAndMode(role, mode)
    if (dbPrompt) return dbPrompt.promptText
    // Fallback to defaults (safety net for fresh installs before migration runs)
    return DEFAULT_PROMPTS[role]?.[mode] ?? ''
  }

  /**
   * Build deduplicated skill content for a specialist.
   * Each skill's SKILL.md is read once and truncated to a budget.
   *
   * Strategy 3: Tiered skill loading — intelligently selects content:
   * - Tier 1 (core principles, first ~1000 chars) — always included
   * - Tier 2 (remaining content up to budget) — included for standard/full budgets
   * Budget per skill scales with tier: minimal=500, standard=2000, full=4000
   *
   * Strategy 8 (Selective Skill Loading): When multiple skills are assigned,
   * the most relevant skill (by keyword match against task context) gets the
   * full budget; remaining skills get a condensed summary (~200 chars) to
   * save 2,000-4,000 tokens per specialist.
   */
  private buildSkillContent(
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
        return scoreB - scoreA // highest relevance first
      })
    }

    const sections: string[] = []

    for (let i = 0; i < rankedSkills.length; i++) {
      const skill = rankedSkills[i]
      // Primary skill gets full budget; secondary skills only included for full budget tier
      // Strategy 6: Skip secondary skills entirely for non-full budget (200-char excerpts are useless)
      const isPrimary = i === 0
      if (!isPrimary && budgetTier !== 'full') continue
      const budget = isPrimary ? baseBudget : Math.min(200, baseBudget)

      try {
        // Phase 7: Progressive skill loading — use tier data when available
        // For minimal budget: inject tier2_instructions only (~500 tokens)
        // For standard budget: inject tier2 + pre-computed summary
        // For full budget: inject full content (tier3)

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
            // Condensed: extract skill title + first paragraph only
            selected = content.substring(0, budget) + '\n\n[... see full skill file for details]'
          } else {
            // Primary skill: smart section extraction
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

    // Strategy 6: Reduced hard cap from 8K to 4K — skills are implementation guides; 4K is enough
    const SKILL_HARD_CAP = 4000
    const totalContent = sections.join('\n\n')
    if (totalContent.length > SKILL_HARD_CAP) {
      // Truncate from end (lowest-relevance skills already sorted last)
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
   * Strategy O: Read a skill file with in-memory caching and mtime invalidation.
   * SKILL.md files rarely change during a session — this eliminates redundant disk I/O.
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
      // stat failed — fall back to direct read (file may not exist)
      const content = readFileSync(filePath, 'utf-8')
      return content
    }
  }

  /**
   * Applies optional per-conversation skill overrides to the assigned skill list.
   * When no overrides are provided, preserves the original list.
   */
  private filterAssignedSkills(skills: Skill[], skillOverrides?: string[]): Skill[] {
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
   * Scores a skill's relevance to the given task context by keyword matching.
   * Phase 7: Uses Tier 1 keywords (from structured tier1_json) for fast matching.
   * Falls back to name-based keywords when tier1_json is not available.
   * Returns a count of how many keywords appear in the context.
   */
  private skillRelevanceScore(skill: Skill, contextLower: string): number {
    let keywords: string[]

    // Prefer Tier 1 structured keywords (richer, includes heading terms + bold terms)
    if (skill.tier1Json) {
      try {
        const tier1 = JSON.parse(skill.tier1Json) as { keywords?: string[] }
        keywords = tier1.keywords ?? []
      } catch {
        keywords = []
      }
    } else {
      // Fallback: derive from name only
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
    // Split into sections by ## headings
    const sectionRegex = /^## .+$/gm
    const sections: { start: number; header: string }[] = []
    let match: RegExpExecArray | null

    while ((match = sectionRegex.exec(content)) !== null) {
      sections.push({ start: match.index, header: match[0] })
    }

    if (sections.length === 0) {
      // No section headers — fall back to simple truncation
      return content.substring(0, budget) + '\n\n[... truncated]'
    }

    // Always include content before first heading (preamble) + as many complete sections as fit
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
        // Can't fit whole section — add truncation notice and stop
        const remaining = budget - result.length - 30 // leave room for truncation marker
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

  /**
   * Read workspace CLAUDE.md as project context for the generalist.
   *
   * Strategy 1: Progressive CLAUDE.md injection
   * - Build mode: slim core project sections only
   * - Plan mode: ultra-light context for investigation/Q&A
   */
  private readProjectContext(
    workspacePath: string,
    _role: PromptRole = 'da-vinci',
    mode: ConversationMode = 'build',
    budgetTier: BudgetTier = 'standard'
  ): string {
    // Strategy 5: Minimal-budget generalist (turn 5+) already has CLAUDE.md in history —
    // send a micro-summary instead of re-extracting sections (~600 tokens saved per turn)
    if (budgetTier === 'minimal') {
      return 'Tech: Electron 40, React 19, TS 5.9, Tailwind 4, SQLite, Zustand 5. See CLAUDE.md in prior context for conventions/structure.'
    }

    try {
      const claudeMdPath = join(workspacePath, 'CLAUDE.md')

      // Strategy G: Check in-memory cache first — only re-read from disk when mtime changes.
      // Eliminates readFileSync() on every generalist turn (saves ~1-5ms disk I/O per turn).
      const cached = this.claudeMdCache.get(claudeMdPath)
      let content: string

      try {
        const stat = statSync(claudeMdPath)
        if (cached && cached.mtimeMs === stat.mtimeMs) {
          content = cached.content
        } else {
          content = readFileSync(claudeMdPath, 'utf-8')
          this.claudeMdCache.set(claudeMdPath, { content, mtimeMs: stat.mtimeMs })
          if (cached) {
            log.info(`[PIPELINE:claude-md-cache] Invalidated — file changed (${claudeMdPath})`)
          }
        }
      } catch {
        // stat failed — fall back to direct read
        content = readFileSync(claudeMdPath, 'utf-8')
      }

      return this.extractGeneralistClaudeMdSections(content, mode)
    } catch {
      return ''
    }
  }

  /**
   * Extracts a slim CLAUDE.md slice for generalist context.
   * - Build mode: broader project context for execution planning.
   * - Plan mode: ultra-light context for investigation/Q&A.
   */
  private extractGeneralistClaudeMdSections(content: string, mode: ConversationMode): string {
    const essentialHeadings =
      mode === 'plan'
        ? ['tech stack', 'key commands', 'conventions', 'what not to do']
        : [
            'overview',
            'project structure',
            'tech stack',
            'key commands',
            'conventions',
            'what not to do',
            'error handling'
          ]

    const skipHeadings = [
      'skills',
      'available skills',
      'electron skill trigger',
      'deprecation notes',
      'electron documentation reference',
      'electron documentation',
      'architecture notes',
      'agents',
      'design system'
    ]

    const extracted = this.extractClaudeMdSections(content, essentialHeadings, skipHeadings, false)
    const profile = mode === 'plan' ? 'generalist-plan (ultra-light)' : 'generalist-build (slim)'
    log.info(
      `CLAUDE.md progressive injection: ${content.length} → ${extracted.length} chars for ${profile}`
    )
    return extracted
  }

  /**
   * Shared CLAUDE.md section extractor.
   */
  private extractClaudeMdSections(
    content: string,
    essentialHeadings: string[],
    skipHeadings: string[],
    keepUnmatchedSections: boolean
  ): string {
    const lines = content.split('\n')
    const result: string[] = []
    let currentSection = ''
    let isKeeping = true // Keep preamble (before first heading)

    for (const line of lines) {
      const headingMatch = line.match(/^##\s+(.+)$/)
      if (headingMatch) {
        currentSection = headingMatch[1].trim().toLowerCase()
        const isEssential = essentialHeadings.some((h) => currentSection.includes(h))
        const isSkipped = skipHeadings.some((h) => currentSection.includes(h))

        // Explicit keep > explicit skip > default behavior by profile
        isKeeping = isEssential || (!isSkipped && keepUnmatchedSections)
      }

      if (isKeeping) {
        result.push(line)
      }
    }

    return result.join('\n').trim()
  }

  // ── Prompt Size Estimation (Strategy: prevent context overflow) ──

  /**
   * Estimate token count from character length.
   * Rule of thumb: ~4 characters per token for English text / code.
   * Returns a conservative (high) estimate.
   */
  static estimateTokens(text: string): number {
    return Math.ceil(text.length / 3.5) // Slightly conservative — 3.5 chars/token
  }

  /** Token budget thresholds per model tier */
  static readonly TOKEN_BUDGETS: Record<string, { warn: number; max: number }> = {
    haiku: { warn: 30_000, max: 50_000 },
    sonnet: { warn: 60_000, max: 100_000 },
    opus: { warn: 100_000, max: 180_000 }
  } as const

  /**
   * Check if a prompt exceeds safe size for the target model.
   * Returns warning/error info if the prompt is too large.
   */
  static checkPromptSize(
    systemPrompt: string,
    userPrompt: string,
    modelTier: string
  ): { ok: boolean; estimatedTokens: number; warning?: string } {
    const totalChars = systemPrompt.length + userPrompt.length
    const estimatedTokens = PromptBuilder.estimateTokens(systemPrompt + userPrompt)
    const budget = PromptBuilder.TOKEN_BUDGETS[modelTier] ?? PromptBuilder.TOKEN_BUDGETS.sonnet

    if (estimatedTokens > budget.max) {
      return {
        ok: false,
        estimatedTokens,
        warning: `Prompt exceeds ${modelTier} max budget: ~${estimatedTokens} tokens > ${budget.max} limit (${totalChars} chars). Context will be truncated by the model.`
      }
    }

    if (estimatedTokens > budget.warn) {
      return {
        ok: true,
        estimatedTokens,
        warning: `Prompt approaching ${modelTier} budget: ~${estimatedTokens} tokens > ${budget.warn} warning threshold (${totalChars} chars)`
      }
    }

    return { ok: true, estimatedTokens }
  }
}

/** Singleton instance */
export const promptBuilder = new PromptBuilder()
