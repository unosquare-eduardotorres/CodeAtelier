import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { BudgetTier, ConversationMode, Skill } from '../../shared/types'
import { promptBuilderLogger } from '../logger'
import { coreAgentPromptRepository } from '../db/repositories/core-agent-prompt.repository'
import { skillRepository } from '../db/repositories/skill.repository'
import {
  buildDecompositionPrompt,
  buildSpecialistMcpGuidance,
  DEFAULT_PROMPTS,
  getDeepPersona,
  OPUS_SPECIALIST_APPENDIX,
  SPECIALIST_MICRO_PROMPT,
  SPECIALIST_TASK_SYSTEM_PROMPT
} from './default-prompts'
import type { SpecialistMcpFlags } from './default-prompts'

// ── Specialist behavioral prompts consolidated ──
// All prompt constants now live in default-prompts.ts (single source of truth).
// Specialist MCP guidance is assembled conditionally via buildSpecialistMcpGuidance()
// to avoid injecting guidance for unconfigured MCP servers.

// ── Prompt Builder Types ──

type PromptRole = 'generalist' | 'specialist'

interface PromptBuildOptions {
  /** Which agent role is this prompt for */
  role: PromptRole
  /** Conversation mode (plan or build) */
  mode: ConversationMode
  /** Specialist agentId — required when role is 'specialist' */
  specialistId?: string
  /** Specialist prompt from DB/YAML — injected for specialists */
  specialistPrompt?: string
  /** Skills assigned to this specialist (pre-resolved, no LLM needed) */
  assignedSkills?: Skill[]
  /** Whether specialist skills should be injected for this prompt (defaults to true) */
  skillsEnabled?: boolean
  /** Optional per-conversation skill override list (filters assignedSkills when provided) */
  skillOverrides?: string[]
  /** Workspace path for CLAUDE.md project context injection */
  workspacePath?: string
  /** Include auto memory context (generalist only) */
  memoryContext?: string
  /** Feedback memories for this specialist */
  feedbackContext?: string
  /** Dependency task outputs for context (specialist only) */
  dependencyOutputs?: Map<string, string>
  /** Budget tier — controls context size for model-aware prompt budgeting (Strategy 4) */
  budgetTier?: BudgetTier
  /** Which MCP servers are active — controls conditional tool guidance injection */
  enabledMcpServers?: SpecialistMcpFlags
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
  /** Strategy 3: Nudge generalist to answer directly for simple questions (saves ~10K tokens by skipping handoff) */
  includeDirectAnswerBoost: boolean
}

// ── Prompt Builder ──

const log = promptBuilderLogger

/**
 * Centralized prompt assembly — single place to build system prompts for all agent roles.
 *
 * Design rules:
 * - **Generalist** gets: role prompt + CLAUDE.md (project context) + auto memory. NO skill content.
 * - **Specialist** gets: role prompt + specialist prompt + assigned skills only + CLAUDE.md (project context) + brief + feedback.
 *
 * CLAUDE.md is injected as **project context only** — agent/skill listings are NOT included
 * (those are handled by the DB specialist/skill registry and PromptBuilder layers).
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
   * per-specialist-task readFileSync() calls and truncation overhead.
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

    // Strategy 3: Direct Answer Boost — classify simple questions that don't need specialist handoff.
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
   * Build a complete system prompt for any agent role.
   * Composes prompt from layers, deduplicating skill content.
   */
  build(options: PromptBuildOptions): string {
    const layers: string[] = []
    const budgetTier = options.budgetTier ?? 'standard'

    this.appendPersonaLayer(layers, options, budgetTier)
    this.appendRoleAndIdentityLayers(layers, options, budgetTier)
    this.appendSkillContentLayer(layers, options, budgetTier)
    this.appendProjectContextLayer(layers, options, budgetTier)
    this.appendMemoryContextLayer(layers, options)

    // Strategy 8: Brief + feedback live in buildDynamicContext(), not here — keeps system prompt
    // stable across tasks for maximum Claude prompt cache hits (90% discount).
    return layers.join('\n\n---\n\n')
  }

  /**
   * Layer 0: Persona specialist identity + skills (generalist only).
   * Injected BEFORE the generalist role prompt so the LLM sees itself as the specialist first.
   */
  private appendPersonaLayer(
    layers: string[],
    options: PromptBuildOptions,
    budgetTier: BudgetTier
  ): void {
    if (options.role !== 'generalist' || !options.personaSpecialistId || !options.personaPrompt) {
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
   * Layers 1-2c: Role prompt, specialist identity, persona prompt, deep persona, Opus appendix.
   */
  private appendRoleAndIdentityLayers(
    layers: string[],
    options: PromptBuildOptions,
    budgetTier: BudgetTier
  ): void {
    // Layer 1: Base role prompt
    layers.push(
      this.getRolePrompt(options.role, options.mode, budgetTier, options.enabledMcpServers)
    )

    if (options.role !== 'specialist' || budgetTier === 'minimal') {
      return
    }

    // Layer 2: Specialist identity header
    if (options.specialistId) {
      layers.push(`## Specialist: ${options.specialistId}`)
    }

    // Layer 2b: Specialist persona prompt from YAML/DB
    if (options.specialistPrompt) {
      layers.push(`## Role\n\n${options.specialistPrompt}`)
    }

    // Layer 2b2: Deep persona enrichment (Phase 10A)
    if (options.specialistId) {
      const persona = getDeepPersona(options.specialistId)
      if (persona) {
        layers.push(persona)
      }
    }

    // Layer 2c: Self-critique appendix for Opus-tier BUILD tasks
    if (options.mode === 'build' && budgetTier === 'full') {
      layers.push(OPUS_SPECIALIST_APPENDIX)
    }
  }

  /**
   * Layer 3: Skill content (SKILL.md files) for specialists.
   * Plan-mode specialists get skills at minimal budget tier for grounded analysis.
   */
  private appendSkillContentLayer(
    layers: string[],
    options: PromptBuildOptions,
    budgetTier: BudgetTier
  ): void {
    if (options.role !== 'specialist') return

    if (options.skillsEnabled === false) {
      log.info(
        `Skill-free mode: specialist=${options.specialistId} — persona-only, no SKILL.md content (saves ~400-1,140 tokens)`
      )
      return
    }

    if (!options.assignedSkills) return

    const effectiveBudgetTier = options.mode === 'plan' ? ('minimal' as BudgetTier) : budgetTier
    const assignedSkills = this.filterAssignedSkills(
      options.assignedSkills,
      options.skillOverrides
    )
    if (assignedSkills.length === 0) return

    const taskContext = options.specialistPrompt || ''
    const skillContent = this.buildSkillContent(assignedSkills, effectiveBudgetTier, taskContext)
    if (skillContent) {
      layers.push(skillContent)
    }
  }

  /**
   * Layer 4: Workspace project context (CLAUDE.md — project sections only).
   * Progressive by role: generalist-build slim, generalist-plan ultra-light, specialist essentials.
   * Strategy 4: Minimal tier skips CLAUDE.md for specialists (haiku tasks).
   */
  private appendProjectContextLayer(
    layers: string[],
    options: PromptBuildOptions,
    budgetTier: BudgetTier
  ): void {
    if (!options.workspacePath) return
    if (budgetTier === 'minimal' && options.role === 'specialist') return

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
   * Layer 5: Auto Memory context (generalist only).
   */
  private appendMemoryContextLayer(layers: string[], options: PromptBuildOptions): void {
    if (options.role === 'generalist' && options.memoryContext) {
      layers.push(`## Auto Memory\n\n${options.memoryContext}`)
    }
  }

  /**
   * Strategy 8: Build dynamic per-task context that varies between specialist tasks.
   * This content is prepended to the user prompt (NOT the system prompt) so that
   * the system prompt stays stable across tasks and benefits from Claude's prompt caching.
   *
   * Returns an empty string if no dynamic context is needed.
   */
  buildDynamicContext(
    options: Pick<PromptBuildOptions, 'role' | 'feedbackContext' | 'budgetTier'>
  ): string {
    const budgetTier = options.budgetTier ?? 'standard'
    if (options.role !== 'specialist' || budgetTier === 'minimal') return ''

    const sections: string[] = []

    // Feedback memories
    if (options.feedbackContext) {
      sections.push(options.feedbackContext)
    }

    if (sections.length === 0) return ''
    return `## Context\n\n${sections.join('\n\n')}\n\n## Task\n\n`
  }

  /**
   * Get the decomposition system prompt (used by generalist.decompose()).
   * This is a standalone prompt, not composed with layers.
   * Mode-aware: plan-mode decomposition produces investigation tasks,
   * build-mode produces implementation tasks.
   */
  getDecompositionPrompt(mode: ConversationMode = 'build'): string {
    return buildDecompositionPrompt(mode)
  }

  // ── Private layer builders ──

  private getRolePrompt(
    role: PromptRole,
    mode: ConversationMode,
    budgetTier?: BudgetTier,
    mcpFlags?: SpecialistMcpFlags
  ): string {
    if (role === 'generalist') {
      // Read from DB (user-editable). Falls back to defaults if DB is empty.
      const dbPrompt = coreAgentPromptRepository.findByRoleAndMode(role, mode)
      if (dbPrompt) return dbPrompt.promptText
      // Fallback to defaults (safety net for fresh installs before migration runs)
      return DEFAULT_PROMPTS[role]?.[mode] ?? SPECIALIST_TASK_SYSTEM_PROMPT
    }
    // Assemble specialist MCP guidance conditionally (only active servers)
    const mcpGuidance = buildSpecialistMcpGuidance(mcpFlags)
    // Minimal-budget specialists (haiku-tier, complexity 0-4) get a micro prompt
    // to save ~400 tokens on simple tasks like quick reads and investigations
    const basePrompt =
      budgetTier === 'minimal' ? SPECIALIST_MICRO_PROMPT : SPECIALIST_TASK_SYSTEM_PROMPT
    return basePrompt + mcpGuidance
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
   * Read workspace CLAUDE.md as project context.
   *
   * Strategy 1: Progressive CLAUDE.md injection
   * - Generalist build: slim core project sections only
   * - Generalist plan: ultra-light context for investigation/Q&A
   * - Specialist: essential sections with explicit skip list for heavy metadata
   */
  private readProjectContext(
    workspacePath: string,
    role: PromptRole = 'generalist',
    mode: ConversationMode = 'build',
    budgetTier: BudgetTier = 'standard'
  ): string {
    // Dynamic specialist CLAUDE.md extraction: try reading CLAUDE.md for the workspace
    // and extracting the sections most relevant to specialists. Falls back to a hardcoded
    // inline summary if CLAUDE.md is unavailable.
    if (role === 'specialist') {
      return this.extractSpecialistClaudeMd(workspacePath)
    }

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
   * Extracts a specialist-focused CLAUDE.md slice.
   * Specialists need conventions, error handling, and key commands — not project overview
   * or architecture notes (those are covered by the specialist persona + skills).
   * Falls back to a hardcoded inline summary if CLAUDE.md is unavailable.
   */
  private extractSpecialistClaudeMd(workspacePath: string): string {
    const INLINE_FALLBACK = `Tech: Electron 40, React 19, TypeScript 5.9 strict, Tailwind CSS 4, better-sqlite3 (raw SQL, no ORM), Zustand 5.
Conventions: ES modules with type-only imports, @renderer/ alias, kebab-case.service.ts for services, PascalCase.tsx for components.
IPC: ipcRenderer.invoke/ipcMain.handle only. Channels defined in src/shared/constants.ts (IPC_CHANNELS). Never use sendSync or expose raw ipcRenderer.
DB: Repository pattern in src/main/db/repositories/. Raw SQL via better-sqlite3. No ORM.
Errors: throw in IPC handlers (propagates to renderer). try-catch + log.error() in services.
Never: require() in renderer, disable contextIsolation, use remote module, string-concat SQL.`

    try {
      const claudeMdPath = join(workspacePath, 'CLAUDE.md')

      // Reuse mtime cache from generalist extraction
      const cached = this.claudeMdCache.get(claudeMdPath)
      let content: string

      try {
        const stat = statSync(claudeMdPath)
        if (cached && cached.mtimeMs === stat.mtimeMs) {
          content = cached.content
        } else {
          content = readFileSync(claudeMdPath, 'utf-8')
          this.claudeMdCache.set(claudeMdPath, { content, mtimeMs: stat.mtimeMs })
        }
      } catch {
        content = readFileSync(claudeMdPath, 'utf-8')
      }

      const specialistHeadings = [
        'tech stack',
        'conventions',
        'key commands',
        'what not to do',
        'error handling'
      ]
      const specialistSkipHeadings = [
        'overview',
        'skills',
        'available skills',
        'electron skill trigger',
        'deprecation notes',
        'electron documentation',
        'architecture notes',
        'agents',
        'design system',
        'project structure'
      ]

      const extracted = this.extractClaudeMdSections(
        content,
        specialistHeadings,
        specialistSkipHeadings,
        false
      )

      if (extracted.length > 100) {
        log.info(`CLAUDE.md specialist extraction: ${content.length} → ${extracted.length} chars`)
        return extracted
      }
    } catch {
      // CLAUDE.md not found or unreadable — fall back
    }

    return INLINE_FALLBACK
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
