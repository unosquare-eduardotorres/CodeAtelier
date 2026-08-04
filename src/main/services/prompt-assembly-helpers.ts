/**
 * Stateless prompt-assembly helpers shared by ProjectSpecialistRoleAdapter.
 * These provide MCP-guidance blocks and conditional user-turn prefixes.
 *
 * These helpers do not touch DB or filesystem directly (memory/CLAUDE.md
 * layering lives in PromptBuilder). They only operate on the values passed in.
 */
import type { ConversationMode } from '../../shared/types'
import {
  // Unified guidance blocks (full === lean after W2 unification)
  ASK_QUESTION_PROMPT,
  CHECKPOINT_CONTEXT_GUIDANCE_PROMPT,
  CODE_ANALYSIS_GUIDANCE_PROMPT,
  GIT_CONTEXT_GUIDANCE_PROMPT,
  GITHUB_CONTEXT_GUIDANCE_PROMPT,
  IMAGE_ATTACHMENTS_PROMPT,
  LIBRARY_DOCS_GUIDANCE_PROMPT,
  MAESTRO_GUIDANCE_PROMPT,
  MEMORY_PROTOCOL_PROMPT,
  PROCESS_MANAGER_GUIDANCE_PROMPT,
  REPOMAP_GUIDANCE_PROMPT,
  SEMANTIC_SEARCH_GUIDANCE_PROMPT,
  // Guidance blocks that still differ between full/lean
  ESLINT_GUIDANCE_PROMPT,
  ESLINT_GUIDANCE_PROMPT_LEAN,
  DIRECT_ANSWER_BOOST_PROMPT,
  DIRECT_ANSWER_BOOST_PROMPT_LEAN,
  DIRECT_ANSWER_PLAN_MODE_EARLY,
  // Mode & plan constants
  MODE_CONTEXT_SECTIONS,
  MODE_CONTEXT_SECTIONS_LEAN,
  PLAN_REMINDER_FULL,
  PLAN_REMINDER_LEAN,
  TOOL_PRIORITY_DIRECTIVE
} from './default-prompts'
import { resolvePromptVerbosity } from '../../shared/constants'
import { promptBuilder } from './prompt-builder'
import { chatAgentLogger } from '../logger'

const log = chatAgentLogger

/** Feature flags that affect prompt assembly (same shape used by both roles). */
export interface PromptFeatureFlags {
  repomapEnabled: boolean
  semanticSearchEnabled: boolean
  githubConfigured: boolean
  /** Whether git-context tools are mounted (default true). Set false for local-LLM adapters that skip git tools. */
  includeGitContext?: boolean
  /** Whether checkpoint-context tools are mounted (default true). Set false for evaluation adapters that skip checkpoints. */
  includeCheckpoint?: boolean
  /** External MCPs active for this chat (e.g. { maestro: true }) — drives prompt guidance injection */
  externalMcpActive?: Record<string, boolean>
  /** Whether code-analysis tools are mounted (default true). Set false for small-tier local LLMs. */
  codeAnalysisEnabled?: boolean
  /** Whether process-manager tools are available (false in plan mode). */
  processManagerEnabled?: boolean
}

// ── Data-driven guidance configuration ──

/**
 * W3-F1: Simplified GuidanceSection — single `prompt` field with optional
 * `leanVariant` override. Only ESLint uses `leanVariant` (8/9 entries
 * were identical between lean/full after W2 unification).
 */
interface GuidanceSection {
  marker: string
  flag: (f: PromptFeatureFlags) => boolean
  prompt: string
  /** Overrides `prompt` when lean verbosity is active. Only set when lean differs. */
  leanVariant?: string
  /** When set, skip the lean variant if basePrompt already contains this marker. */
  skipLeanWhen?: string
}

const GUIDANCE_SECTIONS: GuidanceSection[] = [
  { marker: '## Code Graph', flag: (f) => f.repomapEnabled, prompt: REPOMAP_GUIDANCE_PROMPT, skipLeanWhen: '## Code Exploration' },
  { marker: '## Semantic Search', flag: (f) => f.semanticSearchEnabled, prompt: SEMANTIC_SEARCH_GUIDANCE_PROMPT },
  { marker: '## Git Context', flag: (f) => f.includeGitContext !== false, prompt: GIT_CONTEXT_GUIDANCE_PROMPT },
  { marker: '## Checkpoint Tools', flag: (f) => f.includeCheckpoint !== false, prompt: CHECKPOINT_CONTEXT_GUIDANCE_PROMPT },
  { marker: '## GitHub Tools', flag: (f) => f.githubConfigured, prompt: GITHUB_CONTEXT_GUIDANCE_PROMPT },
  { marker: '## Code Analysis', flag: (f) => f.codeAnalysisEnabled !== false, prompt: CODE_ANALYSIS_GUIDANCE_PROMPT },
  { marker: '## Library Doc', flag: (f) => f.codeAnalysisEnabled !== false, prompt: LIBRARY_DOCS_GUIDANCE_PROMPT },
  { marker: '## Maestro', flag: (f) => !!f.externalMcpActive?.['maestro'], prompt: MAESTRO_GUIDANCE_PROMPT },
  // ESLint: only entry where lean differs (full includes "Warnings OK; errors are NOT")
  { marker: '## ESLint', flag: () => true, prompt: ESLINT_GUIDANCE_PROMPT, leanVariant: ESLINT_GUIDANCE_PROMPT_LEAN },
  { marker: '## Background Processes', flag: (f) => f.processManagerEnabled !== false, prompt: PROCESS_MANAGER_GUIDANCE_PROMPT }
]

/**
 * Strategy δ: Append MCP tool guidance sections to a system prompt — turn 1 only.
 * These blocks are workspace-stable (don't toggle between turns) so they live
 * in the system prompt. They are idempotent: if a block is already present
 * (e.g. the base prompt already embeds it) we skip it.
 */
export function appendMcpToolGuidance(
  basePrompt: string,
  turnCount: number,
  featureFlags: PromptFeatureFlags,
  model?: string
): string {
  // W3-F3: Turn 2+ — tool priority reminder only (~20 tokens).
  // PLAN_OUTPUT_GUIDANCE_LEAN removed: mode-context already carries the full emit_plan workflow.
  // Lean models already have tool priority in their identity prompt every turn.
  if (turnCount > 1) {
    const verbosity2 = resolvePromptVerbosity(model ?? '')
    if (verbosity2 !== 'lean' && featureFlags.repomapEnabled) {
      return basePrompt + TOOL_PRIORITY_DIRECTIVE
    }
    return basePrompt
  }

  const verbosity = resolvePromptVerbosity(model ?? '')
  const appendSections: string[] = []

  for (const section of GUIDANCE_SECTIONS) {
    if (!section.flag(featureFlags) || basePrompt.includes(section.marker)) continue
    if (verbosity === 'lean' && section.skipLeanWhen && basePrompt.includes(section.skipLeanWhen)) continue
    const text = (verbosity === 'lean' && section.leanVariant) ? section.leanVariant : section.prompt
    appendSections.push(text)
  }

  if (appendSections.length === 0) return basePrompt
  return `${basePrompt}\n\n---\n\n${appendSections.join('\n\n---\n\n')}`
}

/**
 * Strategy α: Build the conditional prefix injected into the user message.
 * The prefix toggles based on the user's message content and turn count.
 * Keeping it OUT of the system prompt lets Claude cache the system prompt.
 */
export function buildConditionalPrefix(opts: {
  message: string
  hasImages: boolean
  mode: ConversationMode
  turnCount: number
  model?: string
}): string {
  const { message, hasImages, mode, turnCount } = opts
  const verbosity = resolvePromptVerbosity(opts.model ?? '')
  const conditionalSections = promptBuilder.getGeneralistConditionalSections(
    message,
    hasImages,
    verbosity
  )
  const sections: string[] = []

  // Skip ask_user prompt on turns 2+ — already in history from turn 1.
  if (conditionalSections.includeAskQuestionPrompt && turnCount <= 1) {
    sections.push(ASK_QUESTION_PROMPT) // unified: full === lean
  }

  // Skip memory-protocol prompt on turns 2+ — already in history from turn 1.
  if (conditionalSections.includeMemoryProtocolPrompt && turnCount <= 1) {
    sections.push(MEMORY_PROTOCOL_PROMPT) // unified: full === lean
  }

  if (conditionalSections.includeImageAttachmentsPrompt) {
    sections.push(IMAGE_ATTACHMENTS_PROMPT) // unified: full === lean
  }

  // ── isPlanGenerationRequest — moved up to suppress contradictory direct-answer signal ──
  const isPlanGenerationRequest =
    /\b(create a plan|draft a plan|propose a plan|make a plan|write a plan|design a plan|plan for|plan to (implement|build|add|create|fix|refactor)|how (would|should|can) (I|we|you)|what('s| is) the (best|right) (way|approach)|investigate|diagnose|audit|analyze|review|examine|what.*(wrong|broken|failing|issue)|assess|evaluate|improve|optimize|migrate|migration|refactor|rewrite|overhaul|rearchitect|port\b(?!folio)|cut\s+over|transition\s+(to|from))\b/i.test(
      message
    )

  // Strategy N: Direct Answer Boost
  if (conditionalSections.includeDirectAnswerBoost) {
    if (turnCount >= 3) {
      sections.push(
        verbosity === 'lean' ? DIRECT_ANSWER_BOOST_PROMPT_LEAN : DIRECT_ANSWER_BOOST_PROMPT
      )
    } else if (mode === 'plan' && !isPlanGenerationRequest) {
      // Suppressed when isPlanGenerationRequest is true — plan intent overrides "don't use emit_plan"
      sections.push(DIRECT_ANSWER_PLAN_MODE_EARLY)
    }
  }

  // Strategy ζ: Plan Output Reinforcement (isPlanGenerationRequest already computed above)
  const isSimpleQuestion = conditionalSections.includeDirectAnswerBoost
  const planReminderInjected = isPlanGenerationRequest || (mode === 'plan' && !isSimpleQuestion)

  if (planReminderInjected) {
    // Turn 1 + full-verbosity model: full reminder. All other cases: lean.
    const planReminder = turnCount <= 1 && verbosity !== 'lean' ? PLAN_REMINDER_FULL : PLAN_REMINDER_LEAN
    sections.push(planReminder)
  }

  log.info(
    `[PIPELINE:conditional-prefix] ask=${conditionalSections.includeAskQuestionPrompt} memory=${conditionalSections.includeMemoryProtocolPrompt} image=${conditionalSections.includeImageAttachmentsPrompt} directBoost=${conditionalSections.includeDirectAnswerBoost} planReminder=${planReminderInjected}`
  )

  return sections.length > 0
    ? `[Contextual guidelines for this message]\n\n${sections.join('\n\n')}`
    : ''
}

/**
 * Pattern 8: Build the `<mode-context>` block injected per-message.
 * Shared by ProjectSpecialistRoleAdapter.
 */
export function buildModeContextPrefix(mode: ConversationMode, model?: string): string {
  const verbosity = resolvePromptVerbosity(model ?? '')
  const sections = verbosity === 'lean' ? MODE_CONTEXT_SECTIONS_LEAN : MODE_CONTEXT_SECTIONS
  const block = sections[mode] ?? sections.plan
  return `<mode-context>\n${block.trim()}\n</mode-context>`
}
