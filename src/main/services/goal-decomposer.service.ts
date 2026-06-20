/**
 * GoalDecomposerService — decomposes a plan / typed description into a set of
 * measurable goals, each of which becomes its own sequential MPA run within a
 * campaign.
 *
 * Patterned on GrillPlanGeneratorService: a one-shot Claude CLI call (Opus via
 * the `mpa:decompose` model-config key) emits fenced JSON; we parse + validate,
 * derive `phases` locally from PHASE_TEMPLATES, and sanity-check each goal
 * through the local classifyGoal heuristic.
 *
 * Trivial input scales down to a single goal (no separate fast path).
 */

import { randomUUID } from 'node:crypto'
import log from 'electron-log'
import { runOneShotClaude } from './one-shot-claude'
import { modelConfigService } from './model-config.service'
import { classifyGoal, PHASE_TEMPLATES } from './mpa-preflight.service'
import type { GoalDecomposeResult, MeasurableGoal, MpaGoalType } from '../../shared/mpa-types'

const decomposeLog = log.scope('goal-decomposer')

const VALID_GOAL_TYPES: ReadonlySet<MpaGoalType> = new Set([
  'feature',
  'refactor',
  'bugfix',
  'tests'
])

// ── System Prompt ───────────────────────────────────────────────────────────

const DECOMPOSE_SYSTEM_PROMPT = `You are a senior technical lead breaking an implementation plan into a small set of MEASURABLE goals.

Each goal becomes an independent, sequentially-executed engineering task. A goal is "measurable" when its success can be objectively verified by checking concrete criteria.

RULES:
- Produce the SMALLEST number of goals that fully covers the plan. Trivial or single-concern input → exactly ONE goal.
- Order goals by dependency — foundational goals first.
- Each goal MUST have:
  - title: a short imperative phrase (≤ 60 chars)
  - outcome: one sentence describing the concrete end state achieved
  - successCriteria: 2-5 INDEPENDENTLY CHECKABLE statements (e.g. "POST /posts returns 201 with the created record", "Unit test covers the empty-input case"). Avoid vague criteria like "works well".
  - goalType: one of "feature" | "refactor" | "bugfix" | "tests"
- Do NOT include implementation phases — those are derived downstream.
- Output ONLY the goals JSON inside a single fenced \`\`\`goals block. No prose outside the block.

OUTPUT FORMAT:
\`\`\`goals
{
  "goals": [
    {
      "title": "...",
      "outcome": "...",
      "successCriteria": ["...", "..."],
      "goalType": "feature"
    }
  ]
}
\`\`\`

The JSON must be valid and complete. Do not truncate or abbreviate.`

// ── Service ─────────────────────────────────────────────────────────────────

interface ParsedGoal {
  title?: unknown
  outcome?: unknown
  successCriteria?: unknown
  goalType?: unknown
}

class GoalDecomposerService {
  /**
   * Decompose a plan / typed description into measurable goals.
   * Resolves the `mpa:decompose` model, calls Claude one-shot, parses + validates.
   */
  async decompose(params: { workspaceId: string; input: string }): Promise<GoalDecomposeResult> {
    const input = params.input.trim()
    if (!input) {
      throw new Error('Cannot decompose an empty input')
    }

    decomposeLog.info(`[decompose] Decomposing input (${input.length} chars)`)

    const model = modelConfigService.getModelById(params.workspaceId, 'mpa:decompose')
    const responseText = await this.callClaude(this.buildPrompt(input), model, params.workspaceId)

    const goals = this.parseGoals(responseText)
    if (!goals || goals.length === 0) {
      // Scale-down fallback: treat the whole input as a single goal.
      decomposeLog.warn('[decompose] No goals parsed — falling back to single goal')
      return { goals: [this.buildFallbackGoal(input)] }
    }

    decomposeLog.info(`[decompose] ✓ Decomposed into ${goals.length} goal(s)`)
    return { goals }
  }

  /** Build the user prompt from the raw input. */
  private buildPrompt(input: string): string {
    return [
      '# Plan / Description to decompose',
      '',
      input,
      '',
      '---',
      'Decompose the above into measurable goals following the system rules.'
    ].join('\n')
  }

  /** Call Claude CLI in one-shot mode (mirrors GrillPlanGeneratorService). */
  private async callClaude(prompt: string, model: string, workspaceId?: string): Promise<string> {
    try {
      const { text } = await runOneShotClaude({
        feature: 'goal_decompose',
        model,
        workspaceId: workspaceId ?? null,
        args: [
          '-p',
          prompt,
          '--model',
          model,
          '--system-prompt',
          DECOMPOSE_SYSTEM_PROMPT,
          '--permission-mode',
          'plan',
          '--max-turns',
          '1'
        ],
        cli: {
          timeout: 120_000, // 2 minutes
          maxBuffer: 1024 * 1024 * 10 // 10MB
        }
      })
      return text
    } catch (err) {
      decomposeLog.error('[decompose] Claude CLI call failed:', err)
      throw new Error(
        `Goal decomposition failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /** Parse + validate the goals JSON block, deriving phases locally. */
  private parseGoals(text: string): MeasurableGoal[] | null {
    const regex = /```goals\n([\s\S]*?)```/g
    let lastMatch: RegExpExecArray | null = null
    let match: RegExpExecArray | null
    while ((match = regex.exec(text)) !== null) {
      lastMatch = match
    }

    if (!lastMatch) {
      decomposeLog.error('[decompose] No ```goals``` block found in response')
      return null
    }

    let parsed: { goals?: unknown }
    try {
      parsed = JSON.parse(lastMatch[1]) as { goals?: unknown }
    } catch (err) {
      decomposeLog.error('[decompose] Failed to parse goals JSON:', err)
      return null
    }

    if (!Array.isArray(parsed.goals)) {
      decomposeLog.error('[decompose] Parsed payload missing goals array')
      return null
    }

    const goals: MeasurableGoal[] = []
    for (const raw of parsed.goals as ParsedGoal[]) {
      const goal = this.normalizeGoal(raw)
      if (goal) goals.push(goal)
    }
    return goals
  }

  /** Validate one raw goal and normalize it into a MeasurableGoal. */
  private normalizeGoal(raw: ParsedGoal): MeasurableGoal | null {
    const title = typeof raw.title === 'string' ? raw.title.trim() : ''
    const outcome = typeof raw.outcome === 'string' ? raw.outcome.trim() : ''
    if (!title || !outcome) {
      decomposeLog.warn('[decompose] Skipping goal missing title/outcome')
      return null
    }

    const successCriteria = Array.isArray(raw.successCriteria)
      ? raw.successCriteria
          .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
          .map((c) => c.trim())
      : []

    const goalType = this.resolveGoalType(raw.goalType, `${title}. ${outcome}`)

    return {
      id: randomUUID(),
      title: title.slice(0, 120),
      outcome,
      successCriteria,
      goalType,
      phases: [...PHASE_TEMPLATES[goalType]]
    }
  }

  /** Trust the LLM's goalType when it's a valid enum; otherwise fall back to the
   *  local classifyGoal heuristic over the goal's title + outcome. */
  private resolveGoalType(rawType: unknown, goalText: string): MpaGoalType {
    if (typeof rawType === 'string' && VALID_GOAL_TYPES.has(rawType as MpaGoalType)) {
      return rawType as MpaGoalType
    }
    const classified = classifyGoal(goalText)
    return classified.goalType
  }

  /** Build a single fallback goal from the raw input (scale-down path). */
  private buildFallbackGoal(input: string): MeasurableGoal {
    const classified = classifyGoal(input)
    const goalType = classified.goalType
    const firstLine =
      input
        .split('\n')
        .find((l) => l.trim().length > 0)
        ?.trim() ?? input
    return {
      id: randomUUID(),
      title: firstLine.replace(/^#+\s*/, '').slice(0, 120) || 'Implement the plan',
      outcome: firstLine.slice(0, 280),
      successCriteria: [],
      goalType,
      phases: [...PHASE_TEMPLATES[goalType]]
    }
  }
}

export const goalDecomposerService = new GoalDecomposerService()
