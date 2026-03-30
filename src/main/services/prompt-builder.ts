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

const DECOMPOSITION_SYSTEM_PROMPT = `You are a task decomposition and complexity scoring engine. Given a task summary and a list of available specialists, break the task into concrete sub-tasks AND score each sub-task's complexity.

Rules:
1. Each sub-task must be assigned to exactly one specialist from the provided list.
2. Each sub-task must have a short, actionable description (1-2 sentences).
3. Use "dependsOn" to express ordering constraints — list the IDs of tasks that must complete before this one can start. Tasks with no dependencies can run in parallel.
4. Keep the number of tasks between 2 and 8 — decompose enough for parallelism but not so much that overhead dominates.
5. Assign IDs as "t1", "t2", "t3", etc.
6. If a task spans only one specialist, still decompose into logical steps if they can be parallelized.
7. IMPORTANT: If two tasks are likely to modify the same files (e.g., shared types, config files, package.json, common utilities), set one to depend on the other using the dependsOn array. Only tasks that touch completely independent files should run in parallel. This prevents merge conflicts when agents work in isolated branches.
8. USE the provided conversation context (decisions, constraints, files discussed, recent messages) to:
   - Write more specific task descriptions that reference actual decisions and constraints
   - Identify file conflicts more accurately (you know which files were discussed)
   - Assign appropriate complexity scores based on the scope discussed
   - Ensure no decided constraints are violated in the decomposition

Complexity scoring — for EACH task, evaluate:
- filesAffected (0-3): 1 file=0, 2-3=1, 4-6=2, 7+=3
- estimatedLines (0-3): <50=0, 50-150=1, 150-300=2, 300+=3
- newDependencies (0-2): 0 deps=0, 1-2=1, 3+=2
- taskType (0-3): docs/config=0, test=1, implementation=2, architecture/refactor=3
- riskFlags (0-3): +1 each for security-sensitive, external integration, breaking change

Total = sum of all dimensions (0-14). Assign tier:
- 0-4: "simple" → model: "haiku"
- 5-8: "moderate" → model: "sonnet"
- 9-14: "complex" → model: "opus"

9. For each task, include a "verificationCommand" — a shell command the specialist should run after completing its work to verify correctness. Use the project's available tooling:
   - For code changes: "npm run lint" or "npm run typecheck" (prefer typecheck for type safety)
   - For test-related work: "npm test" or the relevant test command
   - For config/docs changes: null (no verification needed)
   - Keep it to a single, fast command — no chained commands
   - Match the verification command to the task's technology stack:
     - .NET/C# tasks: "dotnet build" or "dotnet test"
     - TypeScript/React tasks: "npm run typecheck" or "npm run lint"
     - Python tasks: "python -m pytest" or "mypy ."
   - NEVER use a frontend verification command for a backend task or vice versa
10. INVESTIGATION DETECTION: If the task summary contains ANY of these patterns:
    - Investigation keywords: "investigate", "look into", "analyze", "review", "diagnose",
      "debug", "find out why", "figure out", "check why"
    - Error keywords paired with ambiguity: "500 error", "NullReferenceException", "crash",
      "not working", "broken", "fails", "exception", "bug", "error"

    WHEN DETECTED:
    - Create ONLY investigation task(s) — ONE task per specialist
    - Do NOT include fix, implementation, or test tasks
    - The investigation will produce a report; fixes are planned AFTER the report
    - Use mode "plan" regardless of handoff mode
    - Each investigation task MUST end with: "Produce a structured investigation report."
    - Impact levels: "very-low" | "low" | "medium" | "high" | "critical"
    - ALSO: If the task is being decomposed in "plan" mode, ALL tasks are read-only investigations.
      Plan-mode tasks NEVER fix, rebuild, restart, deploy, execute, or test.
      They read code, analyze, diagnose, and produce investigation reports.
    - If the task summary starts with "Fix" or another action verb but the mode is "plan",
      reinterpret it as "Investigate the issue described in: [original summary]"

    WRONG (never do this for investigations):
    { "tasks": [{ "id": "t1", "description": "Investigate..." },
                { "id": "t2", "description": "Fix..." },
                { "id": "t3", "description": "Test..." }] }

    CORRECT:
    { "tasks": [{ "id": "t1", "description": "Investigate the issue... Produce a structured investigation report." }] }

Respond with ONLY valid JSON, no markdown, no explanation. Use this exact schema:
{
  "tasks": [
    {
      "id": "t1",
      "specialist": "specialist-id",
      "description": "What to do",
      "dependsOn": [],
      "verificationCommand": "npm run typecheck",
      "complexity": {
        "filesAffected": 1,
        "estimatedLines": 2,
        "newDependencies": 0,
        "taskType": 2,
        "riskFlags": 0,
        "total": 5,
        "tier": "moderate",
        "model": "sonnet"
      }
    }
  ]
}`

const SPECIALIST_TASK_SYSTEM_PROMPT = `You are a specialist agent executing a specific sub-task as part of a larger plan. Focus exclusively on your assigned task.

- Complete ONLY the task described — do not expand scope
- If you encounter a blocker that requires work outside your task, describe it clearly but do not attempt it
- **Investigation tasks:** Be surgical. Read ONLY the files directly related to the error. Do NOT scan the entire codebase. If the task mentions specific files or classes, start there. Target: ≤ 15 tool calls for investigation. Read → analyze → report.
- **Verification (stop hook):** If your task description includes a verification command, you MUST run it before finishing. If it fails, fix the issues and re-run verification. Only mark the task complete when verification passes or you've made 2 fix attempts.
- When done, summarize what you accomplished using this exact format:

## Task Summary
**Files changed:** [list of files created/modified/deleted]
**What was done:** [1-2 sentences]
**Verification:** [passed/failed/skipped — include the command and result]
**Blockers:** [none, or description of what blocked you]

- **Investigation tasks:** If your task description ends with
  "Produce a structured investigation report", emit the following
  block at the end of your response:

  \`\`\`investigation-report
  {
    "problem": "Clear explanation of the problem found",
    "rootCause": "Technical root cause",
    "proposedFix": "How to fix it — step by step",
    "filesAffected": [
      { "path": "src/path/to/file.cs", "reason": "Why this file needs changes" }
    ],
    "impact": "medium",
    "impactReason": "Brief explanation of why this impact level"
  }
  \`\`\``

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
  /**
   * Build a complete system prompt for any agent role.
   * Composes prompt from layers, deduplicating skill content.
   */
  build(options: PromptBuildOptions): string {
    const layers: string[] = []
    const budgetTier = options.budgetTier ?? 'standard'

    // Layer 1: Base role prompt
    layers.push(this.getRolePrompt(options.role, options.mode))

    // Layer 2: Specialist-specific prompt (from YAML body / DB)
    if (options.role === 'specialist' && options.specialistPrompt) {
      layers.push(`## Specialist Role\n${options.specialistPrompt}`)
    }

    // Layer 2b: Self-critique appendix for Opus-tier tasks (full budget = complex tasks)
    if (options.role === 'specialist' && budgetTier === 'full') {
      layers.push(OPUS_SPECIALIST_APPENDIX)
    }

    // Layer 3: Skill content — ONLY for specialists, ONLY their assigned skills
    // Strategy 3: Tiered skill loading with budget-aware truncation
    // Strategy 8: Selective loading — pass task context for relevance ranking
    if (options.role === 'specialist' && options.assignedSkills) {
      const taskContext = options.brief?.summary || options.specialistPrompt || ''
      const skillContent = this.buildSkillContent(options.assignedSkills, budgetTier, taskContext)
      if (skillContent) {
        layers.push(skillContent)
      }
    }

    // Layer 4: Workspace project context (CLAUDE.md — project sections only)
    // Strategy 1: Progressive CLAUDE.md — full for generalist, essential sections for specialists
    // Strategy 4: Minimal tier skips CLAUDE.md entirely (haiku tasks)
    if (options.workspacePath && budgetTier !== 'minimal') {
      const projectContext = this.readProjectContext(options.workspacePath, options.role)
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
   * Budget per skill scales with tier: minimal=500, standard=3000, full=5000
   *
   * Strategy 8 (Selective Skill Loading): When multiple skills are assigned,
   * the most relevant skill (by keyword match against task context) gets the
   * full budget; remaining skills get a condensed summary (~300 chars) to
   * save 2,000-4,000 tokens per specialist.
   */
  private buildSkillContent(
    skills: Skill[],
    budgetTier: BudgetTier = 'standard',
    taskContext?: string
  ): string {
    const activeSkills = skills.filter((s) => s.isActive)
    if (activeSkills.length === 0) return ''

    const baseBudget = budgetTier === 'minimal' ? 500 : budgetTier === 'full' ? 5000 : 3000

    // Selective skill loading: rank skills by relevance when >1 skill and we have task context
    let rankedSkills = activeSkills
    if (activeSkills.length > 1 && taskContext && budgetTier !== 'full') {
      const contextLower = taskContext.toLowerCase()
      rankedSkills = [...activeSkills].sort((a, b) => {
        const scoreA = this.skillRelevanceScore(a, contextLower)
        const scoreB = this.skillRelevanceScore(b, contextLower)
        return scoreB - scoreA // highest relevance first
      })
    }

    const sections: string[] = []

    for (let i = 0; i < rankedSkills.length; i++) {
      const skill = rankedSkills[i]
      // Primary skill gets full budget; secondary skills get condensed summary
      const isPrimary = i === 0 || budgetTier === 'full'
      const budget = isPrimary ? baseBudget : Math.min(300, baseBudget)

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

    return sections.join('\n\n')
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
   * - Generalist: full content (needs everything for rich conversation)
   * - Specialist: essential sections only (Tech stack, Conventions, Project structure, Key commands)
   *   Skips: Skills table, Agent listing, Deprecation notes, Electron docs reference, Architecture notes
   */
  private readProjectContext(workspacePath: string, role: PromptRole = 'generalist'): string {
    try {
      const claudeMdPath = join(workspacePath, 'CLAUDE.md')
      const content = readFileSync(claudeMdPath, 'utf-8')

      // Generalist gets full context
      if (role !== 'specialist') return content

      // Specialist: extract only essential sections
      return this.extractEssentialClaudeMdSections(content)
    } catch {
      return ''
    }
  }

  /**
   * Extracts essential sections from CLAUDE.md for specialist context.
   * Keeps: Overview, Tech stack, Conventions, Project structure, Key commands, What NOT to do, Error handling
   * Skips: Skills table, Agent listing, Deprecation notes, Electron docs reference, Architecture notes
   *
   * Strategy 1: Reduces specialist CLAUDE.md from ~15K to ~5K chars.
   */
  private extractEssentialClaudeMdSections(content: string): string {
    // Sections to KEEP for specialists (essential for writing correct code)
    const essentialHeadings = [
      'overview',
      'tech stack',
      'conventions',
      'project structure',
      'key commands',
      'what not to do',
      'error handling'
    ]

    // Sections to explicitly SKIP (not useful for task execution)
    const skipHeadings = [
      'skills',
      'available skills',
      'electron skill trigger',
      'deprecation notes',
      'electron documentation reference',
      'architecture notes',
      'agents'
    ]

    // Split by top-level headings (## )
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

        // Explicit keep > explicit skip > default keep
        isKeeping = isEssential || !isSkipped
      }

      if (isKeeping) {
        result.push(line)
      }
    }

    const extracted = result.join('\n').trim()
    log.info(
      `CLAUDE.md progressive injection: ${content.length} → ${extracted.length} chars for specialist`
    )
    return extracted
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
