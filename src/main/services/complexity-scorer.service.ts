import type { ComplexityScore, CostPreference, DecomposedTask, ModelTier } from '../../shared/types'
import { DEFAULT_COST_PREFERENCE } from '../../shared/constants'

/**
 * Clamps a number to the given range.
 */
function clamp(value: number, min: number, max: number): number {
  if (typeof value !== 'number' || isNaN(value)) return min
  return Math.max(min, Math.min(max, Math.round(value)))
}

/**
 * Derives the tier label from a total complexity score.
 */
export function getTierFromScore(total: number): ComplexityScore['tier'] {
  if (total <= 4) return 'simple'
  if (total <= 8) return 'moderate'
  return 'complex'
}

/**
 * Derives the model tier from complexity tier.
 */
function getModelFromTier(tier: ComplexityScore['tier']): ModelTier {
  switch (tier) {
    case 'simple':
      return 'haiku'
    case 'moderate':
      return 'sonnet'
    case 'complex':
      return 'opus'
  }
}

/**
 * Validates and normalizes a complexity score from LLM output.
 * Returns a valid ComplexityScore, falling back to 'moderate'/'sonnet' on invalid data.
 */
export function validateComplexityScore(
  raw: Partial<ComplexityScore> | undefined
): ComplexityScore {
  if (!raw || typeof raw !== 'object') {
    // Fallback: moderate/sonnet
    return {
      filesAffected: 1,
      estimatedLines: 1,
      newDependencies: 0,
      taskType: 3,
      riskFlags: 0,
      total: 5,
      tier: 'moderate',
      model: 'sonnet'
    }
  }

  const filesAffected = clamp(raw.filesAffected ?? 1, 0, 3)
  const estimatedLines = clamp(raw.estimatedLines ?? 1, 0, 3)
  const newDependencies = clamp(raw.newDependencies ?? 0, 0, 2)
  const taskType = clamp(raw.taskType ?? 2, 0, 3)
  const riskFlags = clamp(raw.riskFlags ?? 0, 0, 3)

  const total = filesAffected + estimatedLines + newDependencies + taskType + riskFlags
  const tier = getTierFromScore(total)
  const model = getModelFromTier(tier)

  return {
    filesAffected,
    estimatedLines,
    newDependencies,
    taskType,
    riskFlags,
    total,
    tier,
    model
  }
}

/**
 * Resolves the final model to use, considering complexity score + cost preference override.
 * In 'economy' mode, always use haiku. In 'power' mode, always use opus.
 * In 'balanced' mode, use the scoring result.
 */
export function resolveModel(
  complexity: ComplexityScore,
  costPreference: CostPreference = DEFAULT_COST_PREFERENCE
): ModelTier {
  if (costPreference === 'economy') return 'haiku'
  if (costPreference === 'power') return 'opus'
  return complexity.model // 'balanced' — use scoring result
}

/**
 * Enriches decomposed tasks with validated complexity scores and resolved models.
 */
export function enrichTasksWithComplexity(
  tasks: DecomposedTask[],
  costPreference: CostPreference = DEFAULT_COST_PREFERENCE
): DecomposedTask[] {
  return tasks.map((task) => {
    const complexity = validateComplexityScore(task.complexity)
    const model = resolveModel(complexity, costPreference)
    return { ...task, complexity, model }
  })
}
