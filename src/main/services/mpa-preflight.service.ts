import type { MpaClassifyResult, MpaGoalType, MpaPhaseType } from '../../shared/mpa-types'

// ── Goal Classification Keywords ──

const BUGFIX_KEYWORDS = [
  'fix',
  'bug',
  'broken',
  'crash',
  'error',
  'issue',
  'failing',
  'not working',
  'regression',
  'incorrect',
  'wrong'
]

const REFACTOR_KEYWORDS = [
  'refactor',
  'restructure',
  'reorganize',
  'extract',
  'split',
  'consolidate',
  'migrate',
  'modernize',
  'simplify',
  'clean up',
  'rename',
  'move to',
  'convert to',
  'replace with'
]

const TEST_KEYWORDS = [
  'test',
  'tests',
  'unit test',
  'integration test',
  'e2e test',
  'test coverage',
  'spec',
  'testing'
]

const MIN_GOAL_LENGTH = 15
const MAX_GOAL_LENGTH = 2000

// ── Vague Goal Patterns ──

const VAGUE_PATTERNS = [
  /^(test|fix|make|do|build|create|add)\s+(it|this|that|stuff|things?)$/i,
  /^make\s+it\s+(better|work|good|nice)$/i,
  /^(improve|update|change)\s+(everything|all|the\s+code)$/i,
  /^.{0,10}$/
]

// ── Phase Templates ──

const PHASE_TEMPLATES: Record<MpaGoalType, MpaPhaseType[]> = {
  feature: ['plan', 'execute', 'verify'],
  refactor: ['plan', 'execute', 'verify'],
  bugfix: ['plan', 'execute', 'verify'],
  tests: ['plan', 'execute']
}

// ── Classifier ──

/**
 * Fast local goal classifier — no LLM call needed.
 * Classifies goal type and validates specificity.
 */
export function classifyGoal(goal: string): MpaClassifyResult {
  const trimmed = goal.trim()

  // Validate length
  if (trimmed.length < MIN_GOAL_LENGTH) {
    return {
      goalType: 'feature',
      phases: [],
      isValid: false,
      rejectionReason: 'Goal is too vague. Describe what you want to achieve with enough detail.',
      suggestedGoal: suggestImprovement(trimmed)
    }
  }

  if (trimmed.length > MAX_GOAL_LENGTH) {
    return {
      goalType: 'feature',
      phases: [],
      isValid: false,
      rejectionReason: `Goal is too long (${trimmed.length} chars). Keep it under ${MAX_GOAL_LENGTH} characters.`
    }
  }

  // Check for vague patterns
  for (const pattern of VAGUE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        goalType: 'feature',
        phases: [],
        isValid: false,
        rejectionReason:
          'Goal is too vague. Be specific about what functionality to add, what to fix, or what to refactor.',
        suggestedGoal: suggestImprovement(trimmed)
      }
    }
  }

  // Classify goal type
  const lower = trimmed.toLowerCase()
  const goalType = detectGoalType(lower)
  const phases = PHASE_TEMPLATES[goalType]

  return {
    goalType,
    phases,
    isValid: true
  }
}

function detectGoalType(lowerGoal: string): MpaGoalType {
  // Test-focused goals
  const testScore = TEST_KEYWORDS.reduce(
    (score, kw) => score + (lowerGoal.includes(kw) ? 1 : 0),
    0
  )
  // Only classify as tests if test keywords dominate
  if (testScore >= 2 || (testScore === 1 && lowerGoal.startsWith('add test'))) {
    return 'tests'
  }

  // Bug fix goals
  const bugScore = BUGFIX_KEYWORDS.reduce(
    (score, kw) => score + (lowerGoal.includes(kw) ? 1 : 0),
    0
  )
  if (bugScore >= 2 || (bugScore === 1 && lowerGoal.length < 100)) {
    return 'bugfix'
  }

  // Refactor goals
  const refactorScore = REFACTOR_KEYWORDS.reduce(
    (score, kw) => score + (lowerGoal.includes(kw) ? 1 : 0),
    0
  )
  if (refactorScore >= 1) {
    return 'refactor'
  }

  // Default to feature
  return 'feature'
}

function suggestImprovement(vague: string): string {
  const lower = vague.toLowerCase().trim()

  if (lower.includes('test')) {
    return 'Add unit tests for all services in src/services with >80% coverage'
  }
  if (lower.includes('fix')) {
    return 'Fix [specific issue] — describe what is broken, expected vs actual behavior'
  }
  if (lower.includes('refactor')) {
    return 'Refactor [module name] to use [pattern] for better [maintainability/performance]'
  }

  return 'Add [specific feature] with [specific requirements] for [specific use case]'
}
