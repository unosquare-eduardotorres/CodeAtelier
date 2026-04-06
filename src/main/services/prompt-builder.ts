import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { BudgetTier, ConversationMode, HandoffBrief, Skill } from '../../shared/types'
import { promptBuilderLogger } from '../logger'
import { coreAgentPromptRepository } from '../db/repositories/core-agent-prompt.repository'
import { skillRepository } from '../db/repositories/skill.repository'
import { DEFAULT_PROMPTS } from './default-prompts'

// ── Non-editable prompts (kept in code — specialist/decomposition) ──
// NOTE: PLAN_MODE_SYSTEM_PROMPT, BUILD_MODE_SYSTEM_PROMPT, GENERALIST_BASE_PROMPT,
// GENERALIST_PLAN_MODE_SECTION, GENERALIST_BUILD_MODE_SECTION have been moved to
// default-prompts.ts and are now stored in the core_agent_prompts DB table (user-editable).

/**
 * Slimmed decomposition prompt (~600 chars vs prior ~1700).
 * Complexity scoring is now computed in code by enrichTasksWithComplexity(),
 * so the LLM only needs to produce the task structure.
 */
const DECOMPOSITION_SYSTEM_PROMPT = `Task decomposer. Return ONLY valid JSON.
Create 1-8 tasks (id t1..tn). Each: exactly one provided specialist, 1-2 sentence actionable description, dependsOn for ordering, verificationCommand (code: "npm run typecheck"; tests: "npm test"; docs: null).
Keep independent tasks parallel. Add dependsOn when tasks touch same files/shared surfaces.
Investigation mode: if summary indicates investigate/diagnose, emit exactly one task per specialist. Each description must end with "Produce a structured investigation report." Plan mode is read-only — no fix/rebuild/deploy.
Required JSON shape: {"tasks":[{id,specialist,description,dependsOn,verificationCommand}]}`

const SPECIALIST_MCP_TOOL_GUIDANCE = `

## Code Intelligence Tools (MANDATORY — use before Read/Grep/Glob)

You have these MCP tools available. Use them FIRST for all code exploration:

- **mcp__code-graph__search_identifiers**: Find classes, functions, types, interfaces by name. ALWAYS use instead of Grep/Glob for symbol lookups.
- **mcp__code-graph__repo_map**: Ranked overview of important files via PageRank. Use to understand codebase structure instead of directory scanning.
- **mcp__semantic-search__semantic_search**: Natural language code search. Use for concept-based queries ("error handling", "authentication flow").
- **mcp__git-context__git_log**: Recent commit history. Use to understand recent changes.
- **mcp__git-context__git_diff**: View staged/unstaged/commit diffs.
- **mcp__git-context__git_blame**: Line-by-line authorship for a file.
- **mcp__code-graph__find_dead_code**: Find unused code definitions with no references. Use when cleaning up after changes, or when asked to find dead/orphaned code. Scope with a path prefix for targeted results.

**Tool priority (ALWAYS follow this order):**
1. mcp__code-graph__search_identifiers → for finding any named symbol
2. mcp__semantic-search__semantic_search → for conceptual/meaning-based search
3. mcp__code-graph__repo_map → for understanding overall structure
4. mcp__code-graph__find_dead_code → for finding unused/orphaned symbols
5. Grep → ONLY for exact string literals, regex, config values
6. Glob → ONLY for file-extension searches when no symbol name is known
7. Read → ONLY after you've identified the right file via tools above`

const SPECIALIST_TASK_SYSTEM_PROMPT = `You are a specialist agent. Complete ONLY your assigned task — do not expand scope.

- Blockers outside your task: describe clearly, do not attempt.
- Investigation: be surgical — use code intelligence tools to find relevant files. Target ≤10 tool calls. Start with mentioned files.
- Verification: if a command is provided, run it. Fix and retry up to 2×.
- When done: list files changed, 1-2 sentence summary, verification result, blockers.
- Investigation reports: max 1,500 characters. Focus on: root cause (1 sentence), affected files (list), proposed fix (1-2 sentences). Skip background context the user already knows. Emit \`\`\`investigation-report\`\`\` JSON with: problem, rootCause, proposedFix, filesAffected [{path, reason}], impact, impactReason.
${SPECIALIST_MCP_TOOL_GUIDANCE}`

/**
 * Micro specialist prompt for simple/haiku-tier tasks (complexity 0-4).
 * Saves ~400 tokens vs the full SPECIALIST_TASK_SYSTEM_PROMPT.
 */
const SPECIALIST_MICRO_PROMPT = `Complete your assigned task. Be surgical — ≤10 tool calls. When done: files changed + 1 sentence summary.
Investigation reports: emit \`\`\`investigation-report\`\`\` JSON with: problem, rootCause, proposedFix, filesAffected [{path, reason}], impact, impactReason.
${SPECIALIST_MCP_TOOL_GUIDANCE}`

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
    // Simple questions are short, use interrogative verbs, and DON'T request code changes.
    const isQuestionPattern =
      /\b(what|why|how|where|which|explain|show me|list|describe|tell me|is there)\b/i.test(
        normalized
      )
    const isChangeRequest =
      /\b(fix|implement|build|create|add|refactor|update|change|modify|delete|remove|write|migrate|deploy|scaffold|generate)\b/i.test(
        normalized
      )
    const includeDirectAnswerBoost =
      isQuestionPattern && !isChangeRequest && message.length < 300

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

    // Layer 1: Base role prompt (micro prompt for minimal-budget specialists)
    layers.push(this.getRolePrompt(options.role, options.mode, budgetTier))

    // Layer 2: Specialist identity (skip for minimal-budget haiku tasks — just the micro prompt + task is enough)
    if (options.role === 'specialist' && options.specialistId && budgetTier !== 'minimal') {
      layers.push(`## Specialist: ${options.specialistId}`)
    }

    // Layer 2b: Specialist persona prompt from YAML/DB — always injected (even when skills are disabled).
    // Strategy A: This gives the LLM role context like "You are the .NET architect" without the
    // full SKILL.md implementation guide. Skipped for minimal-budget haiku tasks.
    if (options.role === 'specialist' && options.specialistPrompt && budgetTier !== 'minimal') {
      layers.push(`## Role\n\n${options.specialistPrompt}`)
    }

    // Layer 2c: Self-critique appendix for Opus-tier BUILD tasks (not needed for investigations)
    if (options.role === 'specialist' && options.mode === 'build' && budgetTier === 'full') {
      layers.push(OPUS_SPECIALIST_APPENDIX)
    }

    // Layer 3: Skill content — ONLY for specialists in BUILD mode, ONLY their assigned skills
    // Plan-mode specialists only read/analyze — they don't need implementation guides
    // Strategy 3: Tiered skill loading with budget-aware truncation
    // Strategy 8: Selective loading — pass task context for relevance ranking
    // Strategy A: When skillsEnabled=false (no active specialists), skip SKILL.md entirely
    if (options.role === 'specialist' && options.skillsEnabled === false) {
      log.info(
        `Skill-free mode: specialist=${options.specialistId} — persona-only, no SKILL.md content (saves ~400-1,140 tokens)`
      )
    }
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
    // Strategy 4: Minimal tier skips CLAUDE.md for specialists (haiku tasks)
    // Strategy 5: Minimal tier generalist gets a micro-summary (turn 5+, already has full CLAUDE.md in history)
    if (options.workspacePath && !(budgetTier === 'minimal' && options.role === 'specialist')) {
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

    // Layer 5: Auto Memory context (generalist only)
    if (options.role === 'generalist' && options.memoryContext) {
      layers.push(`## Auto Memory\n\n${options.memoryContext}`)
    }

    // Strategy 8: Layers 6 & 7 (brief, feedback) moved to buildDynamicContext() for specialists.
    // The system prompt now contains only STATIC content (role + identity + persona + skills + CLAUDE.md)
    // which is identical for all tasks of the same specialist → maximizes Claude prompt cache hits (90% discount).
    // Dynamic per-task content (brief + feedback) is prepended to the user prompt instead.
    //
    // For generalist: brief and feedback don't apply (generalist has its own memory system).

    return layers.join('\n\n---\n\n')
  }

  /**
   * Strategy 8: Build dynamic per-task context that varies between specialist tasks.
   * This content is prepended to the user prompt (NOT the system prompt) so that
   * the system prompt stays stable across tasks and benefits from Claude's prompt caching.
   *
   * Returns an empty string if no dynamic context is needed.
   */
  buildDynamicContext(options: Pick<PromptBuildOptions, 'role' | 'brief' | 'feedbackContext' | 'budgetTier'>): string {
    const budgetTier = options.budgetTier ?? 'standard'
    if (options.role !== 'specialist' || budgetTier === 'minimal') return ''

    const sections: string[] = []

    // Brief context (from handoff)
    if (options.brief) {
      sections.push(this.buildBriefContext(options.brief))
    }

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
   */
  getDecompositionPrompt(): string {
    return DECOMPOSITION_SYSTEM_PROMPT
  }

  // ── Private layer builders ──

  private getRolePrompt(role: PromptRole, mode: ConversationMode, budgetTier?: BudgetTier): string {
    if (role === 'generalist') {
      // Read from DB (user-editable). Falls back to defaults if DB is empty.
      const dbPrompt = coreAgentPromptRepository.findByRoleAndMode(role, mode)
      if (dbPrompt) return dbPrompt.promptText
      // Fallback to defaults (safety net for fresh installs before migration runs)
      return DEFAULT_PROMPTS[role]?.[mode] ?? SPECIALIST_TASK_SYSTEM_PROMPT
    }
    // Minimal-budget specialists (haiku-tier, complexity 0-4) get a micro prompt
    // to save ~400 tokens on simple tasks like quick reads and investigations
    if (budgetTier === 'minimal') return SPECIALIST_MICRO_PROMPT
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
      // Primary skill gets full budget; secondary skills only included for full budget tier
      // Strategy 6: Skip secondary skills entirely for non-full budget (200-char excerpts are useless)
      const isPrimary = i === 0
      if (!isPrimary && budgetTier !== 'full') continue
      const budget = isPrimary ? baseBudget : Math.min(200, baseBudget)

      try {
        // Try pre-computed semantic summary first (token-optimized, ~50-60% savings)
        const summaryTier = isPrimary ? budgetTier : 'minimal'
        const summary = skillRepository.getSummary(skill.id, summaryTier)

        let selected: string
        if (summary) {
          selected = summary
          log.info(
            `Skill "${skill.name}" using pre-computed ${summaryTier} summary (${summary.length} chars)`
          )
        } else {
          // Fallback: read from disk if summaries not yet generated
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
      log.info(`Skill content hard-capped: ${totalContent.length} → ${accumulated.length} chars (${SKILL_HARD_CAP} limit)`)
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
    mode: ConversationMode = 'build',
    budgetTier: BudgetTier = 'standard'
  ): string {
    const INLINE_SPECIALIST_CONTEXT = `Tech: Electron 40, React 19, TypeScript 5.9 strict, Tailwind CSS 4, better-sqlite3, Zustand 5.\nConventions: ES modules, @renderer/ alias, kebab-case files, PascalCase components. Never require() in renderer, never disable contextIsolation.`
    if (role === 'specialist') return INLINE_SPECIALIST_CONTEXT

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
