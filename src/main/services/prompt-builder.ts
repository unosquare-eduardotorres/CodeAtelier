import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type {
  BudgetTier,
  CommunicationTone,
  ConversationMode,
  PromptVerbosity,
  Skill
} from '../../shared/types'
import type { ContextWindowTier } from './context-management'
import { promptBuilderLogger } from '../logger'
import { coreAgentPromptRepository } from '../db/repositories/core-agent-prompt.repository'
import {
  DEFAULT_PROMPTS,
  TONE_STYLE_DIRECTIVES,
  buildSpecialistIdentityPrompt,
  buildSpecialistIdentityPromptLean,
  UNIFIED_MODE_SECTION
} from './default-prompts'
import { resolvePromptVerbosity } from '../../shared/constants'
import { SkillPromptComposer } from './skill-prompt-composer'
import { sanitizePromptInput } from './sanitize-prompt-input'

// ── Prompt Builder Types ──

type PromptRole = 'specialist'

interface PromptBuildOptions {
  /** Which agent role is this prompt for (always 'specialist') */
  role: PromptRole
  /** Conversation mode (plan or build) */
  mode: ConversationMode
  /** Workspace path for CLAUDE.md project context injection */
  workspacePath?: string
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
  /** Communication tone for AI responses (affects ## Style section) */
  communicationTone?: CommunicationTone
  /** Resolved model ID — used for prompt verbosity gating (Opus 4.8+ gets lean prompts) */
  model?: string
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
 * Centralized prompt assembly for the default specialist.
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

  /** Delegated skill composition (extracted for testability + reduced complexity) */
  private skillComposer = new SkillPromptComposer()

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
    hasImages: boolean,
    verbosity: PromptVerbosity = 'full'
  ): GeneralistConditionalSections {
    const normalized = message.toLowerCase()

    // Lean: tighter regex — require explicit option-signal phrasing.
    // Full: broader triggers for models that need more guidance.
    const includeAskQuestionPrompt =
      verbosity === 'lean'
        ? /\b(choose between|give me options|what are my options|which (one|option) should)\b/i.test(
            normalized
          )
        : /\b(which|choose|choice|option|pick|select|either|vs|versus|should i|what do you prefer)\b/i.test(
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
   * Build a complete system prompt for the default specialist role.
   * Composes prompt from layers (persona overlay, role, project context, memory).
   */
  build(options: PromptBuildOptions): string {
    const layers: string[] = []
    const budgetTier = options.budgetTier ?? 'standard'

    this.appendPersonaLayer(layers, options, budgetTier)
    this.appendRoleAndIdentityLayers(layers, options)
    // Always-on behavioral guidelines (coding discipline)
    const baselineSkills = this.skillComposer.buildBaselineSkillsLayer(budgetTier)
    if (baselineSkills) layers.push(baselineSkills)
    this.appendProjectContextLayer(layers, options, budgetTier)

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
    const projectContext = this.readProjectContext(workspacePath, mode, budgetTier)
    if (!projectContext) return ''
    return `## Workspace Project Context (from CLAUDE.md)\n\n${sanitizePromptInput(projectContext)}`
  }

  /**
   * Layer 0: Persona specialist identity + skills.
   * Injected BEFORE the specialist role prompt so the LLM sees itself as the specialist first.
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
        sanitizePromptInput(options.personaPrompt)
    )
    if (options.personaSkills && options.personaSkills.length > 0) {
      const filtered = this.skillComposer.filterAssignedSkills(
        options.personaSkills,
        options.personaSkillOverrides
      )
      if (filtered.length > 0) {
        const content = this.skillComposer.buildSkillContent(filtered, budgetTier)
        if (content) layers.push(`## Domain Skills\n\n${content}`)
      }
    }
  }

  /**
   * Layer 1: Base role prompt (from DB, user-editable).
   */
  private appendRoleAndIdentityLayers(layers: string[], options: PromptBuildOptions): void {
    layers.push(
      this.getRolePrompt(options.role, options.mode, options.communicationTone, options.model)
    )
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
      options.mode,
      budgetTier
    )
    if (projectContext) {
      layers.push(`## Workspace Project Context (from CLAUDE.md)\n\n${sanitizePromptInput(projectContext)}`)
    }
  }

  // ── Private layer builders ──

  private getRolePrompt(
    role: PromptRole,
    mode: ConversationMode,
    tone?: CommunicationTone,
    model?: string
  ): string {
    // Read from DB (user-editable). Falls back to defaults if DB is empty.
    const dbPrompt = coreAgentPromptRepository.findByRoleAndMode(role, mode)
    if (dbPrompt) {
      // Apply tone overlay when user has a non-default tone selected.
      // If the DB prompt has a ## Style section, replace it inline to avoid
      // duplicate/conflicting style guidance. Otherwise append as a new section.
      if (tone && tone !== 'default') {
        const directive = TONE_STYLE_DIRECTIVES[tone]
        const styleSectionRe = /## Style\n[\s\S]*?(?=\n##|\n$)/
        if (styleSectionRe.test(dbPrompt.promptText)) {
          return dbPrompt.promptText.replace(styleSectionRe, `## Style\n${directive}`)
        }
        return dbPrompt.promptText + `\n\n## Communication Tone Override\n${directive}`
      }
      return dbPrompt.promptText
    }
    // Fallback to defaults — build identity prompt with tone baked in
    if (role === 'specialist') {
      const verbosity = resolvePromptVerbosity(model ?? '')
      const identity =
        verbosity === 'lean'
          ? buildSpecialistIdentityPromptLean(tone)
          : buildSpecialistIdentityPrompt(tone)
      // Lean mode: skip UNIFIED_MODE_SECTION since per-message <mode-context>
      // block already provides detailed mode instructions every turn.
      // Saves ~80 tokens from the system prompt.
      //
      // CONTRACT: Lean mode REQUIRES the caller (ProjectSpecialistRoleAdapter.buildEffectiveMessage)
      // to inject a <mode-context> block in every user message. Without it, the model
      // has NO mode instructions. If adding a new lean-mode caller, ensure it also
      // injects MODE_CONTEXT_SECTIONS_LEAN per message.
      if (verbosity === 'lean') return identity
      return UNIFIED_MODE_SECTION + '\n' + identity
    }
    return DEFAULT_PROMPTS[role]?.[mode] ?? ''
  }

  /**
   * Public accessor for skill composition — used by external adapters
   * (e.g., ProjectSpecialistRoleAdapter) that need direct skill assembly.
   */
  get skills(): SkillPromptComposer {
    return this.skillComposer
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
    mode: ConversationMode = 'build',
    budgetTier: BudgetTier = 'standard'
  ): string {
    // Strategy 5: Minimal-budget generalist (turn 5+) already has CLAUDE.md in history —
    // send a micro-summary instead of re-extracting sections (~600 tokens saved per turn)
    if (budgetTier === 'minimal') {
      return 'Tech: Electron 42, React 19, TS 5.9, Tailwind 4, SQLite, Zustand 5. See CLAUDE.md in prior context for conventions/structure.'
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

  // ── Local LLM Prompt Assembly ──

  /**
   * Build a condensed system prompt for local LLM providers.
   * Strips skills, reduces memory, keeps essential instructions.
   * Target: ~4K tokens for 32K models, ~8K for 128K+ models.
   *
   * When `contextTier` is provided and mode is 'plan', a focused plan-mode
   * directive is prepended (S5) that constrains the model to a strict
   * tool-budget and ordered workflow to prevent aimless exploration.
   */
  buildLocalPrompt(options: PromptBuildOptions & { contextTier?: ContextWindowTier }): string {
    const layers: string[] = []

    // Layer 0 (S5): Plan-focused directive for local LLMs — must come FIRST
    // so it anchors the model before any other content.
    if (options.mode === 'plan' && options.contextTier) {
      layers.push(this.buildLocalPlanDirective(options.contextTier))
    }

    // Layer 1: Condensed role identity (no skills, no persona)
    // Note: model is intentionally NOT threaded here — local LLMs are never Claude
    // models (they're Ollama IDs like qwen2.5-coder:32b), so resolvePromptVerbosity()
    // would always return 'full'. Local prompt compression uses contextTier instead.
    const rolePrompt = this.getRolePrompt(options.role, options.mode, options.communicationTone)
    const condensed = this.extractEssentialSections(rolePrompt)
    if (condensed) layers.push(condensed)

    // Layer 1.5: Baseline behavioral guidelines (always-on, condensed for local LLMs)
    const baselineSkills = this.skillComposer.buildBaselineSkillsLayer('minimal')
    if (baselineSkills) layers.push(baselineSkills)

    // Layer 2: Minimal project context (tech stack + key commands only)
    if (options.workspacePath) {
      const claudeMd = this.readProjectContext(
        options.workspacePath,
        options.mode,
        'minimal'
      )
      if (claudeMd) {
        layers.push(`## Project Context\n\n${claudeMd}`)
      }
    }

    return layers.join('\n\n---\n\n')
  }

  /**
   * S5: Plan-focused directive prompt for local LLMs.
   *
   * Constrains the model to a strict workflow with a hard tool budget to
   * prevent the aimless exploration that burns all turns on small contexts.
   * The directive is placed at the TOP of the system prompt so it anchors
   * the model's behavior before any role/project context.
   */
  buildLocalPlanDirective(tier: ContextWindowTier): string {
    const toolBudgets: Record<ContextWindowTier, number> = {
      small: 5,
      medium: 8,
      large: 15
    }
    const budget = toolBudgets[tier]

    return `## Plan Mode — Strict Workflow

You are in PLAN mode. Your job: produce a WRITTEN PLAN, not execute changes.

### Steps (follow IN ORDER):
1. PARSE the request — identify what the user wants (0 tools)
2. LOCATE files — use Glob/Grep/FindSymbol (2-3 calls max)
3. READ key sections — use Read with offset+limit (2-3 calls max)
4. EMIT THE PLAN — call **emit_plan** with your findings and proposed file changes.
   If emit_plan is unavailable, output a numbered list of specific file changes.

### Rules:
- Maximum ${budget} tool calls total. Then EMIT.
- After reading 2-3 files, you have enough context. STOP exploring.
- A partial plan is ALWAYS better than no plan.
- NEVER explore "just in case."

### Output Format:
Call **emit_plan** with type, title, and phases listing specific file changes.
Fallback (if emit_plan unavailable):
1. **\`path/to/file.tsx\`** — Description of change
2. **\`path/to/other.ts\`** — Description of change
`
  }

  /**
   * Extract identity + mode rules + conventions from a role prompt.
   * Strips: skills, design system, architecture deep-dives, etc.
   */
  private extractEssentialSections(prompt: string): string {
    const essentialHeaders = [
      'identity',
      'mode',
      'conventions',
      'key commands',
      'what not to do',
      'error handling'
    ]

    const sections = prompt.split(/^## /m)
    const kept = sections.filter((s) => {
      const header = s.split('\n')[0].trim().toLowerCase()
      return essentialHeaders.some((h) => header.startsWith(h))
    })

    return kept.map((s) => `## ${s}`).join('\n\n')
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
