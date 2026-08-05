/**
 * Extracted pure prompt builder functions for grill and greenfield-grill adapters.
 *
 * Both adapters assemble system prompts from the same building blocks
 * (evaluation schema, question rules, scoring rules). A shared core function
 * handles the common template; variant-specific differences (preamble,
 * instructions, context section) are passed via a config discriminant.
 */

import type { GrillTrackId } from '../../../shared/types'
import type { GRILL_TRACKS } from '../../../shared/constants'
import {
  buildReEvalBlock,
  buildGrillEvaluationSchema,
  buildGrillEvaluationSchemaLean,
  GRILL_QUESTION_QUALITY_RULES,
  GRILL_QUESTION_QUALITY_RULES_GREENFIELD_EXTRA,
  GRILL_QUESTION_QUALITY_RULES_LEAN,
  GRILL_SCORING_RULES,
  GRILL_SCORING_RULES_LEAN,
  isGrillLean
} from './grill-prompt-blocks'
import { sanitizePromptInput } from '../sanitize-prompt-input'

// ── Types ──

export interface WorkspaceGrillPromptParams {
  track: (typeof GRILL_TRACKS)[GrillTrackId]
  trackId: GrillTrackId
  ideaTitle: string
  ideaDescription: string
  previousScore?: number
  model?: string
}

export interface GreenfieldGrillPromptParams {
  track: (typeof GRILL_TRACKS)[GrillTrackId]
  trackId: GrillTrackId
  projectName: string
  projectDescription: string
  previousScore?: number
  model?: string
}

// ── Shared Core ──

interface GrillPromptCoreConfig {
  variant: 'workspace' | 'greenfield'
  track: (typeof GRILL_TRACKS)[GrillTrackId]
  trackId: GrillTrackId
  title: string
  description: string
  previousScore?: number
  model?: string
}

/**
 * Shared core that assembles the grill prompt from variant-specific config.
 * Pure string assembly — no I/O, no DB, no side effects.
 */
function buildGrillPromptCore(config: GrillPromptCoreConfig): string {
  const { variant, track, trackId, title, description, previousScore, model } = config
  const lean = isGrillLean(model)
  const reEvalBlock = buildReEvalBlock(previousScore)
  const isWorkspace = variant === 'workspace'

  const evaluationSchema = lean
    ? buildGrillEvaluationSchemaLean(trackId)
    : buildGrillEvaluationSchema(trackId)

  // Greenfield full mode gets extra question rules; lean mode uses the same rules for both
  const questionRules = lean
    ? GRILL_QUESTION_QUALITY_RULES_LEAN
    : isWorkspace
      ? GRILL_QUESTION_QUALITY_RULES
      : `${GRILL_QUESTION_QUALITY_RULES}\n${GRILL_QUESTION_QUALITY_RULES_GREENFIELD_EXTRA}`

  const scoringRules = lean ? GRILL_SCORING_RULES_LEAN : GRILL_SCORING_RULES

  // Instructions differ: workspace uses code tools, greenfield focuses on reasoning
  const instructions = isWorkspace
    ? lean
      ? `## Instructions
0. Narrate your process — explain what you're checking and why before each tool call.
1. Use Code Graph + Code Analysis tools FIRST (≥1 each) before Read/Grep.
2. No broad codebase scans or documentation reads.
3. Analyze the requirement against each criterion.
4. Provide markdown analysis of gaps.
5. ${evaluationSchema}`
      : `## Instructions
0. **Narrate your process.** Before each tool call, write a brief sentence explaining what you're about to look at and why (e.g., "Let me check the authentication module to assess error handling…"). This helps the user follow along in real time.

1. Use structured tools (Code Graph, Code Analysis) FIRST — see tool guidance sections below. Call at least one Code Graph tool AND one Code Analysis tool before falling back to Read or Grep.
2. Do NOT perform a broad codebase scan or read documentation files (README, Roadmap, etc.).
3. Analyze the requirement against each scoring criterion above.
4. Provide your analysis as markdown text — explain what is well-defined and what is missing.
5. After your analysis, emit EXACTLY ONE structured evaluation block in this format:

${evaluationSchema}`
    : lean
      ? `## Instructions
0. Narrate your reasoning — explain what's well-defined and what gaps remain.
1. Analyze the project idea against each criterion.
2. Identify decisions made vs. undefined.
3. Provide markdown analysis of gaps.
4. ${evaluationSchema}`
      : `## Instructions
0. **Narrate your reasoning.** Before each scoring decision, explain what aspects are well-defined and what gaps remain. Help the user understand what makes a well-prepared project brief.
1. Analyze the project idea against each scoring criterion above.
2. Identify what decisions have been made and what remains undefined.
3. Provide your analysis as markdown text — explain what is well-defined and what is missing.
4. After your analysis, emit EXACTLY ONE structured evaluation block in this format:

${evaluationSchema}`

  // Preamble varies by variant
  const preamble = isWorkspace
    ? `You are a Grill Analyst — a requirement completeness evaluator.${reEvalBlock}`
    : `You are a Grill Analyst — a requirement completeness evaluator for a NEW project idea.${reEvalBlock}`

  // Greenfield gets a context section; workspace does not
  const contextSection = isWorkspace
    ? ''
    : `\n\n## Context
You are evaluating a project IDEA, not an existing codebase. There is no code to analyze yet.
Focus on eliciting concrete decisions about scope, tech stack, architecture, user flows,
constraints, and trade-offs that will guide the project's creation.`

  // Task and subject section labels differ
  const taskLabel = isWorkspace ? 'a software requirement' : 'a new project idea'
  const subjectHeading = isWorkspace ? '## Requirement' : '## Project Idea'

  return `${preamble}${contextSection}

## Your Task
Evaluate the completeness of ${taskLabel} for the **${track.name}** track.

## Evaluation Criteria
${track.scoringFocus.map((f) => `- ${f}`).join('\n')}

${subjectHeading}
**${sanitizePromptInput(title)}**

${sanitizePromptInput(description || 'No description provided.')}

${instructions}

${questionRules}

${scoringRules}`
}

// ── Public Builders (unchanged signatures) ──

/**
 * Build the system prompt for a workspace grill evaluation.
 * Pure string assembly — no I/O, no DB, no side effects.
 */
export function buildWorkspaceGrillPrompt(params: WorkspaceGrillPromptParams): string {
  return buildGrillPromptCore({
    variant: 'workspace',
    track: params.track,
    trackId: params.trackId,
    title: params.ideaTitle,
    description: params.ideaDescription,
    previousScore: params.previousScore,
    model: params.model
  })
}

/**
 * Build the system prompt for a greenfield grill evaluation.
 * Pure string assembly — no I/O, no DB, no side effects.
 */
export function buildGreenfieldGrillPrompt(params: GreenfieldGrillPromptParams): string {
  return buildGrillPromptCore({
    variant: 'greenfield',
    track: params.track,
    trackId: params.trackId,
    title: params.projectName,
    description: params.projectDescription,
    previousScore: params.previousScore,
    model: params.model
  })
}
