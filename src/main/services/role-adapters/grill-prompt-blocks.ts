/**
 * Shared prompt blocks for grill and greenfield-grill adapters.
 *
 * Both adapters use the same evaluation schema, question quality rules,
 * and scoring bands. Centralizing them here:
 * - Eliminates ~600 tokens of duplication
 * - Enables single-place lean variants
 * - Ensures consistent schema evolution
 */

import type { GrillTrackId } from '../../../shared/types'
import { resolvePromptVerbosity } from '../../../shared/constants'

// ── Re-evaluation Context ──

export function buildReEvalBlock(previousScore: number | undefined): string {
  if (previousScore == null) return ''
  return `\n## Re-evaluation Context
- Previous score: ${previousScore}/100
- ANCHOR your new score to the previous one. Only change when decisions materially fill or reveal gaps.
- Do NOT re-ask questions the user already answered — focus on REMAINING gaps.
- In your analysis, explicitly credit which previous decisions address which criteria.\n`
}

// ── Grill Evaluation JSON Schema ──

export function buildGrillEvaluationSchema(trackId: GrillTrackId): string {
  return `\`\`\`grill-evaluation
{
  "trackId": "${trackId}",
  "score": <number 1-100>,
  "scoreLabel": "<label: Raw | Warming Up | Medium Rare | Well Done | Perfectly Grilled>",
  "feedback": "<2-3 sentence summary of gaps>",
  "questions": [
    {
      "id": "q1",
      "question": "<2-3 sentence question explaining the gap and WHY it matters for implementation>",
      "header": "<short 3-5 word label>",
      "options": [
        { "label": "<concise choice>", "description": "<1-2 sentences: trade-offs, constraints, implications>", "recommended": true, "recommendedReason": "<1 sentence: why this is safest/best given trade-offs>" },
        { "label": "<alternative>", "description": "<trade-offs>" },
        { "label": "<another alternative>", "description": "<trade-offs>" }
      ]
    }
  ],
  "suggestedNextTrack": { "trackId": "<next-track-id>", "reason": "<why>" }
}
\`\`\``
}

/**
 * Lean grill-evaluation schema — Opus can follow the format from a concise description
 * instead of a full JSON example (~250 tokens saved).
 */
export function buildGrillEvaluationSchemaLean(trackId: GrillTrackId): string {
  return `Emit one \`grill-evaluation\` JSON block: { trackId: "${trackId}", score: 1-100, scoreLabel: "Raw|Warming Up|Medium Rare|Well Done|Perfectly Grilled", feedback: "2-3 sentence gap summary", questions: [{ id, question (2-3 sentences: gap + impact), header (3-5 words), options: [{ label, description (trade-offs), recommended?: true, recommendedReason }] }], suggestedNextTrack?: { trackId, reason } }`
}

// ── Question Quality Rules ──

export const GRILL_QUESTION_QUALITY_RULES = `## Question Quality Rules
- Each question MUST target a specific implementation decision, not just "what approach?"
- The "question" field must explain the GAP and its IMPACT (2-3 sentences, not just a label)
- Each option's "description" field is REQUIRED — explain trade-offs, constraints, or implications
- At least 2 of the 5 questions must probe EDGE CASES or FAILURE MODES
- Do NOT ask vague questions like "How should this work?" — ask "What happens when X fails/overflows/conflicts?"
- The recommended option's "recommendedReason" must reference concrete trade-offs (risk, complexity, reversibility) — not just "this is better"`

/** Extra rule appended for greenfield evaluations (no codebase exists) */
export const GRILL_QUESTION_QUALITY_RULES_GREENFIELD_EXTRA =
  `- Since there is NO existing codebase, focus questions on DESIGN CHOICES the user needs to make before building`

/**
 * Lean question quality rules — compressed to essentials.
 * Opus 4.8+ follows question structure from schema example + these reminders.
 */
export const GRILL_QUESTION_QUALITY_RULES_LEAN = `## Question Quality
Questions: specific implementation decisions with gap + impact (2-3 sentences). Options: required descriptions with trade-offs. ≥2 of 5 must probe edge cases/failure modes. recommendedReason: cite trade-offs (risk, complexity, reversibility).`

// ── Scoring Rules ──

export const GRILL_SCORING_RULES = `## Rules
- Score 1-20: Raw — fundamental gaps. Score 21-40: Warming Up. Score 41-60: Medium Rare. Score 61-80: Well Done. Score 81-100: Perfectly Grilled.
- Include exactly 5 questions targeting the weakest areas.
- Each question must have 3-4 options with at most 1 recommended. The recommended option MUST include a "recommendedReason" field — a single sentence explaining WHY (e.g. "Lower risk with the same outcome — refactoring can happen in phase 2").
- suggestedNextTrack is optional — only include if another track would benefit.
- Do NOT emit any other code blocks with the grill-evaluation language tag.`

/**
 * Lean scoring rules — compressed score bands + output constraints.
 */
export const GRILL_SCORING_RULES_LEAN = `## Rules
Score bands: 1-20 Raw, 21-40 Warming Up, 41-60 Medium Rare, 61-80 Well Done, 81-100 Perfectly Grilled.
5 questions, 3-4 options each, ≤1 recommended with recommendedReason. suggestedNextTrack optional. One grill-evaluation block only.`

// ── Composed Prompt Builders ──

/**
 * Determines whether the grill prompt should use lean variants.
 * Accepts optional model string — returns true for Opus 4.8+ models.
 */
export function isGrillLean(model?: string): boolean {
  return resolvePromptVerbosity(model ?? '') === 'lean'
}
