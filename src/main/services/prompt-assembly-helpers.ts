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
  CHECKPOINT_CONTEXT_GUIDANCE_PROMPT,
  DIRECT_ANSWER_BOOST_PROMPT,
  GIT_CONTEXT_GUIDANCE_PROMPT,
  GITHUB_CONTEXT_GUIDANCE_PROMPT,
  IMAGE_ATTACHMENTS_PROMPT,
  MEMORY_PROTOCOL_PROMPT,
  REPOMAP_GUIDANCE_PROMPT,
  SEMANTIC_SEARCH_GUIDANCE_PROMPT
} from './default-prompts'
import { promptBuilder } from './prompt-builder'
import { chatAgentLogger } from '../logger'

const log = chatAgentLogger

/** Feature flags that affect prompt assembly (same shape used by both roles). */
export interface PromptFeatureFlags {
  repomapEnabled: boolean
  semanticSearchEnabled: boolean
  githubConfigured: boolean
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
  featureFlags: PromptFeatureFlags
): string {
  if (turnCount > 1) return basePrompt

  const appendSections: string[] = []

  if (featureFlags.repomapEnabled && !basePrompt.includes('## Code Graph Tools')) {
    appendSections.push(REPOMAP_GUIDANCE_PROMPT)
  }

  if (featureFlags.semanticSearchEnabled && !basePrompt.includes('## Semantic Search')) {
    appendSections.push(SEMANTIC_SEARCH_GUIDANCE_PROMPT)
  }

  if (!basePrompt.includes('## Git Context Tools')) {
    appendSections.push(GIT_CONTEXT_GUIDANCE_PROMPT)
  }

  if (!basePrompt.includes('## Checkpoint Tools')) {
    appendSections.push(CHECKPOINT_CONTEXT_GUIDANCE_PROMPT)
  }

  if (featureFlags.githubConfigured && !basePrompt.includes('## GitHub Tools')) {
    appendSections.push(GITHUB_CONTEXT_GUIDANCE_PROMPT)
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
}): string {
  const { message, hasImages, mode, turnCount } = opts
  const conditionalSections = promptBuilder.getGeneralistConditionalSections(message, hasImages)
  const sections: string[] = []

  // Skip ask_user prompt on turns 2+ — already in history from turn 1.
  if (conditionalSections.includeAskQuestionPrompt && turnCount <= 1) {
    sections.push(ASK_QUESTION_PROMPT)
  }

  // Skip memory-protocol prompt on turns 2+ — already in history from turn 1.
  if (conditionalSections.includeMemoryProtocolPrompt && turnCount <= 1) {
    sections.push(MEMORY_PROTOCOL_PROMPT)
  }

  if (conditionalSections.includeImageAttachmentsPrompt) {
    sections.push(IMAGE_ATTACHMENTS_PROMPT)
  }

  // Strategy N: Direct Answer Boost — only inject on turn 3+ when there's
  // conversation history to reference (irrelevant on early turns).
  if (conditionalSections.includeDirectAnswerBoost && turnCount >= 3) {
    sections.push(DIRECT_ANSWER_BOOST_PROMPT)
  }

  // Strategy ζ: Plan Output Reinforcement.
  // Plan mode: always remind about emit_plan.
  // Build mode: only when the user is explicitly asking for a plan.
  const isPlanGenerationRequest =
    /\b(create a plan|draft a plan|propose a plan|make a plan|write a plan|design a plan|plan for|plan to (implement|build|add|create|fix|refactor)|how (would|should|can) (I|we|you)|what('s| is) the (best|right) (way|approach)|investigate|diagnose|audit|analyze|what.*(wrong|broken|failing|issue)|assess|evaluate)\b/i.test(
      message
    )
  const planReminderInjected = mode === 'plan' || isPlanGenerationRequest

  if (planReminderInjected) {
    sections.push(
      turnCount <= 1
        ? `[Reminder: Use the emit_plan tool to produce a structured plan. Plain-text plans are not actionable — only tool-emitted plans render as interactive cards.]`
        : `[Use emit_plan for plans.]`
    )
  }

  log.info(
    `[PIPELINE:conditional-prefix] ask=${conditionalSections.includeAskQuestionPrompt} memory=${conditionalSections.includeMemoryProtocolPrompt} image=${conditionalSections.includeImageAttachmentsPrompt} directBoost=${conditionalSections.includeDirectAnswerBoost} planReminder=${planReminderInjected}`
  )

  return sections.length > 0
    ? `[Contextual guidelines for this message]\n\n${sections.join('\n\n')}`
    : ''
}
