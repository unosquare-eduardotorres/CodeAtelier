import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BudgetTier, ConversationMode, HandoffBrief, Skill } from '../../shared/types'
import { promptBuilderLogger } from '../logger'
import { coreAgentPromptRepository } from '../db/repositories/core-agent-prompt.repository'
import { DEFAULT_PROMPTS } from './default-prompts'

// ── Non-editable prompts (kept in code — specialist/decomposition) ──
// NOTE: PLAN_MODE_SYSTEM_PROMPT, BUILD_MODE_SYSTEM_PROMPT, GENERALIST_BASE_PROMPT,
// GENERALIST_PLAN_MODE_SECTION, GENERALIST_BUILD_MODE_SECTION have been moved to
// default-prompts.ts and are now stored in the core_agent_prompts DB table (user-editable).

const DECOMPOSITION_SYSTEM_PROMPT = `Task decomposition + complexity scorer. Return ONLY valid JSON.
Create 2-8 tasks (id t1..tn). Each task: exactly one provided specialist, 1-2 sentence actionable description, dependsOn for ordering. Keep independent tasks parallel; even with one specialist split into logical parallel-safe steps. Prevent merge conflicts by adding dependsOn when tasks may touch same files/shared surfaces. Use context (decisions, constraints, filesDiscussed).
Complexity: total(0-14)=filesAffected+estimatedLines+newDependencies+taskType+riskFlags.
filesAffected 0=1,1=2-3,2=4-6,3=7+; estimatedLines 0=<50,1=50-150,2=150-300,3=300+; newDependencies 0=0,1=1-2,2=3+; taskType 0=docs,1=test,2=impl,3=arch; riskFlags 0=none,1=security,2=external,3=breaking. Map totals: 0-4 simple/haiku, 5-8 moderate/sonnet, 9-14 complex/opus.
verificationCommand per task: code "npm run typecheck" or "npm run lint"; tests "npm test" (or relevant); docs/config-only null. Keep one fast stack-matched command (.NET dotnet build/test; TS npm run typecheck/lint; Python python -m pytest/mypy).
Investigation handling: if summary indicates investigation/diagnosis OR caller indicates plan-mode investigation, emit investigation-only tasks. Plan mode is read-only (no fix/rebuild/restart/deploy/test). If a plan-mode summary is action-oriented, reinterpret as investigation. For investigations, output exactly one task per specialist, and each description must end with "Produce a structured investigation report."
Required JSON shape: {"tasks":[{id,specialist,description,dependsOn,verificationCommand,complexity{filesAffected,estimatedLines,newDependencies,taskType,riskFlags,total,tier,model}}]}`

const SPECIALIST_TASK_SYSTEM_PROMPT = `You are a specialist agent. Complete ONLY your assigned task — do not expand scope.

- Blockers outside your task: describe clearly, do not attempt.
- Investigation: be surgical — read ONLY files related to the error. Target ≤10 tool calls. Start with mentioned files.
- Verification: if a command is provided, run it. Fix and retry up to 2×.
- When done: list files changed, 1-2 sentence summary, verification result, blockers.
- Investigation reports: emit \`\`\`investigation-report\`\`\` JSON with: problem, rootCause, proposedFix, filesAffected [{path, reason}], impact, impactReason.`

/**
 * Self-critique appendix for Opus-tier tasks (budgetTier === 'full').
 * Adds iterative refinement — the specialist reviews its own work before finishing.
 * Adds ~100 output tokens but catches bugs and convention violations pre-merge.
 */
const OPUS_SPECIALIST_APPENDIX = `

## Self-Review (required before finishing)

After completing your implementation, briefly critique it:
- Are there edge cases you missed?
- Does it follow the project conventions from CLAUDE.md?
- Could any part cause a merge conflict with parallel tasks?
If you find issues, fix them before finishing.`

// ── Prompt Builder Types ──

export type PromptRole = 'generalist' | 'specialist'

export interface PromptBuildOptions {
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
  /** Conversation brief context from handoff (specialist only) */
  brief?: HandoffBrief
  /** Feedback memories for this specialist */
  feedbackContext?: string
  /** Dependency task outputs for context (specialist only) */
  dependencyOutputs?: Map<string, string>
  /** Budget tier — controls context size for model-aware prompt budgeting (Strategy 4) */
  budgetTier?: BudgetTier
}

export interface GeneralistConditionalSections {
  includeAskQuestionPrompt: boolean
  includeMemoryProtocolPrompt: boolean
  includeImageAttachmentsPrompt: boolean
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
 * (those are handled by the AgentRegistry and PromptBuilder layers).
 */
export class PromptBuilder {
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

    return {
      includeAskQuestionPrompt,
      includeMemoryProtocolPrompt,
      includeImageAttachmentsPrompt: hasImages
    }
  }

  /**
   * Build a complete system prompt for any agent role.
   * Composes prompt from layers, deduplicating skill content.
   */
  build(options: PromptBuildOptions): string {
    const layers: string[] = []
    const budgetTier = options.budgetTier ?? 'standard'

    // Layer 1: Base role prompt
    layers.push(this.getRolePrompt(options.role, options.mode))

    // Layer 2: Specialist identity
    if (options.role === 'specialist' && options.specialistId) {
      layers.push(`## Specialist: ${options.specialistId}`)
    }

    // Layer 2b: Self-critique appendix for Opus-tier BUILD tasks (not needed for investigations)
    if (options.role === 'specialist' && options.mode === 'build' && budgetTier === 'full') {
      layers.push(OPUS_SPECIALIST_APPENDIX)
    }

    // Layer 3: Skill content — ONLY for specialists in BUILD mode, ONLY their assigned skills
    // Plan-mode specialists only read/analyze — they don't need implementation guides
    // Strategy 3: Tiered skill loading with budget-aware truncation
    // Strategy 8: Selective loading — pass task context for relevance ranking
    if (
      options.role === 'specialist' &&
      options.mode === 'build' &&
      options.assignedSkills &&
      options.skillsEnabled !== false
    ) {
      const assignedSkills = this.filterAssignedSkills(
        options.assignedSkills,
        options.skillOverrides
      )
      if (assignedSkills.length > 0) {
        const taskContext = options.brief?.summary || options.specialistPrompt || ''
        const skillContent = this.buildSkillContent(assignedSkills, budgetTier, taskContext)
        if (skillContent) {
          layers.push(skillContent)
        }
      }
    }

    // Layer 4: Workspace project context (CLAUDE.md — project sections only)
    // Strategy 1: Progressive CLAUDE.md by role:
    // - Generalist build: slim project sections only
    // - Generalist plan: ultra-light sections for investigation/Q&A
    // - Specialist: essential sections with explicit heavy-section skips
    // Strategy 4: Minimal tier skips CLAUDE.md entirely (haiku tasks)
    if (options.workspacePath && budgetTier !== 'minimal') {
      const projectContext = this.readProjectContext(
        options.workspacePath,
        options.role,
        options.mode
      )
      if (projectContext) {
        layers.push(`## Workspace Project Context (from CLAUDE.md)\n\n${projectContext}`)
      }
    }

    // Layer 5: Auto Memory context (generalist only)
    if (options.role === 'generalist' && options.memoryContext) {
      layers.push(`## Auto Memory\n\n${options.memoryContext}`)
    }

    // Layer 6: Conversation brief context (specialist only — from handoff)
    if (options.role === 'specialist' && options.brief) {
      layers.push(this.buildBriefContext(options.brief))
    }

    // Layer 7: Feedback memories (specialist only)
    if (options.role === 'specialist' && options.feedbackContext) {
      layers.push(options.feedbackContext)
    }

    return layers.join('\n\n---\n\n')
  }

  /**
   * Get the decomposition system prompt (used by generalist.decompose()).
   * This is a standalone prompt, not composed with layers.
   */
  getDecompositionPrompt(): string {
    return DECOMPOSITION_SYSTEM_PROMPT
  }

  // ── Private layer builders ──

  private getRolePrompt(role: PromptRole, mode: ConversationMode): string {
    if (role === 'generalist') {
      // Read from DB (user-editable). Falls back to defaults if DB is empty.
      const dbPrompt = coreAgentPromptRepository.findByRoleAndMode(role, mode)
      if (dbPrompt) return dbPrompt.promptText
      // Fallback to defaults (safety net for fresh installs before migration runs)
      return DEFAULT_PROMPTS[role]?.[mode] ?? SPECIALIST_TASK_SYSTEM_PROMPT
    }
    return SPECIALIST_TASK_SYSTEM_PROMPT
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
      // Primary skill gets full budget; secondary skills get condensed summary
      const isPrimary = i === 0 || budgetTier === 'full'
      const budget = isPrimary ? baseBudget : Math.min(200, baseBudget)

      try {
        const content = readFileSync(skill.filePath, 'utf-8')

        let selected: string
        if (content.length <= budget) {
          selected = content
        } else if (!isPrimary || budgetTier === 'minimal') {
          // Condensed: extract skill title + first paragraph only
          selected = content.substring(0, budget) + '\n\n[... see full skill file for details]'
        } else {
          // Primary skill: smart section extraction
          selected = this.extractSkillSections(content, budget)
        }

        sections.push(`## Skill: ${skill.name}\n${selected}`)

        if (content.length > budget) {
          log.info(
            `Skill "${skill.name}" ${isPrimary ? 'trimmed' : 'condensed'} from ${content.length} to ~${budget} chars (budget: ${budgetTier})`
          )
        }
      } catch {
        log.warn(`Could not read skill file: ${skill.filePath}`)
      }
    }

    const totalContent = sections.join('\n\n')
    if (totalContent.length > 8000) {
      // Truncate from end (lowest-relevance skills already sorted last)
      let accumulated = ''
      const capped: string[] = []
      for (const section of sections) {
        if (accumulated.length + section.length + 2 > 8000) break
        capped.push(section)
        accumulated += section + '\n\n'
      }
      log.info(`Skill content hard-capped: ${totalContent.length} → ${accumulated.length} chars (8000 limit)`)
      return capped.join('\n\n')
    }
    return totalContent
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
   * Returns a count of how many words from the skill name/description appear in the context.
   */
  private skillRelevanceScore(skill: Skill, contextLower: string): number {
    const keywords = skill.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .split(/[\s-]+/)
      .filter((w) => w.length > 2) // skip tiny words like "a", "of"
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
    mode: ConversationMode = 'build'
  ): string {
    const INLINE_SPECIALIST_CONTEXT = `Tech: Electron 40, React 19, TypeScript 5.9 strict, Tailwind CSS 4, better-sqlite3, Zustand 5.\nConventions: ES modules, @renderer/ alias, kebab-case files, PascalCase components. Never require() in renderer, never disable contextIsolation.`
    if (role === 'specialist') return INLINE_SPECIALIST_CONTEXT

    try {
      const claudeMdPath = join(workspacePath, 'CLAUDE.md')
      const content = readFileSync(claudeMdPath, 'utf-8')

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
      'architecture notes',
      'agents'
    ]

    const extracted = this.extractClaudeMdSections(
      content,
      essentialHeadings,
      skipHeadings,
      false
    )
    const profile = mode === 'plan' ? 'generalist-plan (ultra-light)' : 'generalist-build (slim)'
    log.info(`CLAUDE.md progressive injection: ${content.length} → ${extracted.length} chars for ${profile}`)
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

  /**
   * Build conversation brief context from a handoff.
   */
  private buildBriefContext(brief: HandoffBrief): string {
    let context = `## Conversation Context\n\nSummary: ${brief.summary}`

    if (brief.decisions.length > 0) {
      context += `\n\nDecisions made:\n${brief.decisions.map((d) => `- ${d}`).join('\n')}`
    }
    if (brief.constraints.length > 0) {
      context += `\n\nConstraints:\n${brief.constraints.map((c) => `- ${c}`).join('\n')}`
    }
    if (brief.filesDiscussed.length > 0) {
      context += `\n\nFiles discussed:\n${brief.filesDiscussed.map((f) => `- ${f}`).join('\n')}`
    }

    return context
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

// ── Re-exports for backward compatibility ──
// These allow existing code to import from prompt-builder during migration.
// Generalist prompts now come from default-prompts.ts (DB-editable).

export {
  DECOMPOSITION_SYSTEM_PROMPT,
  SPECIALIST_TASK_SYSTEM_PROMPT
}
export {
  PLAN_MODE_SYSTEM_PROMPT,
  BUILD_MODE_SYSTEM_PROMPT
} from './default-prompts'
