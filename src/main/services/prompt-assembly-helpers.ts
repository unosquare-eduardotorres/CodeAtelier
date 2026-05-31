/**
 * Stateless prompt-assembly helpers shared by DaVinciRoleAdapter and
 * ProjectSpecialistRoleAdapter. Both roles want the same MCP-guidance blocks
 * and the same conditional user-turn prefix — only their identity-prompt
 * source differs.
 *
 * These helpers do not touch DB or filesystem directly (memory/CLAUDE.md
 * layering lives in PromptBuilder). They only operate on the values passed in.
 */
import type { ConversationMode } from '../../shared/types'
import {
  ASK_QUESTION_PROMPT,
  ASK_QUESTION_PROMPT_LEAN,
  CHECKPOINT_CONTEXT_GUIDANCE_PROMPT,
  CHECKPOINT_CONTEXT_GUIDANCE_PROMPT_LEAN,
  CODE_ANALYSIS_GUIDANCE_PROMPT,
  CODE_ANALYSIS_GUIDANCE_PROMPT_LEAN,
  DIRECT_ANSWER_BOOST_PROMPT,
  DIRECT_ANSWER_BOOST_PROMPT_LEAN,
  GIT_CONTEXT_GUIDANCE_PROMPT,
  GIT_CONTEXT_GUIDANCE_PROMPT_LEAN,
  GITHUB_CONTEXT_GUIDANCE_PROMPT,
  GITHUB_CONTEXT_GUIDANCE_PROMPT_LEAN,
  IMAGE_ATTACHMENTS_PROMPT,
  IMAGE_ATTACHMENTS_PROMPT_LEAN,
  MAESTRO_GUIDANCE_PROMPT,
  MAESTRO_GUIDANCE_PROMPT_LEAN,
  MEMORY_PROTOCOL_PROMPT,
  MEMORY_PROTOCOL_PROMPT_LEAN,
  REPOMAP_GUIDANCE_PROMPT,
  SEMANTIC_SEARCH_GUIDANCE_PROMPT,
  SEMANTIC_SEARCH_GUIDANCE_PROMPT_LEAN
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
  /** External MCPs active for this chat (e.g. { maestro: true }) — drives prompt guidance injection */
  externalMcpActive?: Record<string, boolean>
}

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
  if (turnCount > 1) return basePrompt

  const verbosity = resolvePromptVerbosity(model ?? '')
  const appendSections: string[] = []

  // Lean: Code Graph rules already merged into identity prompt's ## Code Exploration — skip REPOMAP_GUIDANCE
  if (verbosity !== 'lean') {
    if (featureFlags.repomapEnabled && !basePrompt.includes('## Code Graph')) {
      appendSections.push(REPOMAP_GUIDANCE_PROMPT)
    }
  }

  if (featureFlags.semanticSearchEnabled && !basePrompt.includes('## Semantic Search')) {
    appendSections.push(verbosity === 'lean' ? SEMANTIC_SEARCH_GUIDANCE_PROMPT_LEAN : SEMANTIC_SEARCH_GUIDANCE_PROMPT)
  }

  if (!basePrompt.includes('## Git Context')) {
    appendSections.push(verbosity === 'lean' ? GIT_CONTEXT_GUIDANCE_PROMPT_LEAN : GIT_CONTEXT_GUIDANCE_PROMPT)
  }

  if (!basePrompt.includes('## Checkpoint Tools')) {
    appendSections.push(verbosity === 'lean' ? CHECKPOINT_CONTEXT_GUIDANCE_PROMPT_LEAN : CHECKPOINT_CONTEXT_GUIDANCE_PROMPT)
  }

  if (featureFlags.githubConfigured && !basePrompt.includes('## GitHub Tools')) {
    appendSections.push(verbosity === 'lean' ? GITHUB_CONTEXT_GUIDANCE_PROMPT_LEAN : GITHUB_CONTEXT_GUIDANCE_PROMPT)
  }

  if (!basePrompt.includes('## Code Analysis')) {
    appendSections.push(verbosity === 'lean' ? CODE_ANALYSIS_GUIDANCE_PROMPT_LEAN : CODE_ANALYSIS_GUIDANCE_PROMPT)
  }

  // External MCP guidance — only when toggled ON for this chat
  if (featureFlags.externalMcpActive?.['maestro'] && !basePrompt.includes('## Maestro')) {
    appendSections.push(verbosity === 'lean' ? MAESTRO_GUIDANCE_PROMPT_LEAN : MAESTRO_GUIDANCE_PROMPT)
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
  const conditionalSections = promptBuilder.getGeneralistConditionalSections(message, hasImages, verbosity)
  const sections: string[] = []

  // Skip ask_user prompt on turns 2+ — already in history from turn 1.
  // Lean: Opus 4.8+ sees tool schemas natively — use compressed reminder.
  if (conditionalSections.includeAskQuestionPrompt && turnCount <= 1) {
    sections.push(verbosity === 'lean' ? ASK_QUESTION_PROMPT_LEAN : ASK_QUESTION_PROMPT)
  }

  // Skip memory-protocol prompt on turns 2+ — already in history from turn 1.
  // Lean mode: Opus 4.8 uses emit_memory naturally but needs the type taxonomy.
  if (conditionalSections.includeMemoryProtocolPrompt && turnCount <= 1) {
    sections.push(verbosity === 'lean' ? MEMORY_PROTOCOL_PROMPT_LEAN : MEMORY_PROTOCOL_PROMPT)
  }

  // Lean: Opus 4.8+ doesn't search the filesystem for images — use compressed reminder.
  if (conditionalSections.includeImageAttachmentsPrompt) {
    sections.push(verbosity === 'lean' ? IMAGE_ATTACHMENTS_PROMPT_LEAN : IMAGE_ATTACHMENTS_PROMPT)
  }

  // Strategy N: Direct Answer Boost — only inject on turn 3+ when there's
  // conversation history to reference (irrelevant on early turns).
  if (conditionalSections.includeDirectAnswerBoost) {
    if (turnCount >= 3) {
      // Lean: use compressed direct-answer boost
      sections.push(verbosity === 'lean' ? DIRECT_ANSWER_BOOST_PROMPT_LEAN : DIRECT_ANSWER_BOOST_PROMPT)
    } else if (mode === 'plan') {
      // Lightweight signal for plan-mode questions on early turns.
      // DIRECT_ANSWER_BOOST_PROMPT references "conversation history" which doesn't
      // exist on turn 1-2, so we use a targeted one-liner instead.
      sections.push(
        `[This is a question — answer it directly in plain text. Do NOT call emit_plan for explanations or Q&A.]`
      )
    }
  }

  // Strategy ζ: Plan Output Reinforcement.
  // Plan mode: remind about emit_plan UNLESS the message is clearly a question.
  // Build mode: only when the user is explicitly asking for a plan.
  const isPlanGenerationRequest =
    /\b(create a plan|draft a plan|propose a plan|make a plan|write a plan|design a plan|plan for|plan to (implement|build|add|create|fix|refactor)|how (would|should|can) (I|we|you)|what('s| is) the (best|right) (way|approach)|investigate|diagnose|audit|analyze|what.*(wrong|broken|failing|issue)|assess|evaluate)\b/i.test(
      message
    )
  // Simple questions in plan mode should get direct answers, not plan reminders.
  // isPlanGenerationRequest acts as an override: explicit plan intent always wins.
  const isSimpleQuestion = conditionalSections.includeDirectAnswerBoost
  const planReminderInjected = isPlanGenerationRequest || (mode === 'plan' && !isSimpleQuestion)

  if (planReminderInjected) {
    // Lean + turn 1: Opus knows emit_plan from tool schema — short reminder suffices.
    const planReminder =
      turnCount <= 1 && verbosity !== 'lean'
        ? `[Reminder: Use the emit_plan tool to produce a structured plan. Plain-text plans are not actionable — only tool-emitted plans render as interactive cards.]`
        : `[Use emit_plan for plans.]`
    sections.push(planReminder)
  }

  log.info(
    `[PIPELINE:conditional-prefix] ask=${conditionalSections.includeAskQuestionPrompt} memory=${conditionalSections.includeMemoryProtocolPrompt} image=${conditionalSections.includeImageAttachmentsPrompt} directBoost=${conditionalSections.includeDirectAnswerBoost} planReminder=${planReminderInjected}`
  )

  return sections.length > 0
    ? `[Contextual guidelines for this message]\n\n${sections.join('\n\n')}`
    : ''
}
