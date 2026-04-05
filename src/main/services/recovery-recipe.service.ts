import log from 'electron-log/main'
import type { AgentError } from '../../shared/types'

const recoveryLog = log.scope('RecoveryRecipe')

/**
 * Recovery action to take for a matched failure scenario.
 */
export interface RecoveryAction {
  /** Type of recovery to attempt */
  type: 'retry' | 'retry_with_backoff' | 'compact_and_retry' | 'escalate' | 'abort'
  /** Delay in ms before retrying (for backoff strategies) */
  delayMs?: number
  /** Maximum number of retry attempts */
  maxRetries?: number
  /** Whether to modify the input before retrying */
  modifyInput?: (originalInput: string) => string
  /** Human-readable explanation for logging / UI */
  reason: string
}

/**
 * A failure scenario matcher + recovery recipe.
 * When a failure matches the scenario, the recipe's action is used.
 */
export interface RecoveryRecipe {
  /** Unique name for this recipe (for logging) */
  name: string
  /** Priority — lower numbers are matched first */
  priority: number
  /** Match function — returns true if this recipe handles the error */
  matches: (error: AgentError) => boolean
  /** The recovery action to take */
  action: RecoveryAction
}

/**
 * Built-in recovery recipes for common failure scenarios.
 * Ordered by priority (lower = matched first).
 */
const BUILT_IN_RECIPES: RecoveryRecipe[] = [
  {
    name: 'rate-limit-backoff',
    priority: 1,
    matches: (error) =>
      error.kind === 'api_error' && error.statusCode === 429 && error.retryable,
    action: {
      type: 'retry_with_backoff',
      delayMs: 2000,
      maxRetries: 3,
      reason: 'Rate limited by API — retrying with exponential backoff'
    }
  },
  {
    name: 'overloaded-compact-retry',
    priority: 2,
    matches: (error) =>
      error.kind === 'api_error' && error.statusCode === 529 && error.retryable,
    action: {
      type: 'compact_and_retry',
      delayMs: 5000,
      maxRetries: 2,
      reason: 'API overloaded — compacting context and retrying with smaller payload'
    }
  },
  {
    name: 'context-too-large',
    priority: 3,
    matches: (error) =>
      error.kind === 'api_error' &&
      error.statusCode === 400 &&
      error.message.toLowerCase().includes('context'),
    action: {
      type: 'compact_and_retry',
      delayMs: 1000,
      maxRetries: 1,
      reason: 'Context window exceeded — auto-compacting and retrying'
    }
  },
  {
    name: 'transient-server-error',
    priority: 4,
    matches: (error) =>
      error.kind === 'api_error' && error.statusCode >= 500 && error.retryable,
    action: {
      type: 'retry_with_backoff',
      delayMs: 3000,
      maxRetries: 2,
      reason: 'Server error — retrying with backoff'
    }
  },
  {
    name: 'stream-incomplete-retry',
    priority: 5,
    matches: (error) => error.kind === 'stream_incomplete',
    action: {
      type: 'retry',
      maxRetries: 1,
      reason: 'Stream ended without proper completion — retrying once'
    }
  },
  {
    name: 'timeout-abort',
    priority: 10,
    matches: (error) => error.kind === 'timeout',
    action: {
      type: 'abort',
      reason: 'Request timed out — aborting to prevent further resource consumption'
    }
  },
  {
    name: 'budget-exceeded-abort',
    priority: 10,
    matches: (error) => error.kind === 'budget_exceeded',
    action: {
      type: 'abort',
      reason: 'Budget exceeded — aborting to prevent overspend'
    }
  },
  {
    name: 'circuit-breaker-abort',
    priority: 10,
    matches: (error) => error.kind === 'circuit_breaker',
    action: {
      type: 'abort',
      reason: 'Circuit breaker tripped — agent appears stuck in a loop'
    }
  },
  {
    name: 'user-abort',
    priority: 0,
    matches: (error) => error.kind === 'abort' && error.reason === 'user',
    action: {
      type: 'abort',
      reason: 'User cancelled the request'
    }
  }
]

/**
 * Recovery recipe service — matches errors to recovery actions.
 *
 * Inspired by Claw Code's RecoveryRecipe system. Provides pattern-matching
 * error recovery instead of generic catch-all error handling.
 */
class RecoveryRecipeService {
  private recipes: RecoveryRecipe[] = [...BUILT_IN_RECIPES]

  /**
   * Find the best recovery action for a given error.
   * Returns the highest-priority matching recipe's action, or null if no match.
   */
  findRecovery(error: AgentError): RecoveryAction | null {
    const sorted = [...this.recipes].sort((a, b) => a.priority - b.priority)
    for (const recipe of sorted) {
      if (recipe.matches(error)) {
        recoveryLog.info(`[RECOVERY:matched] ${recipe.name}: ${recipe.action.reason}`)
        return recipe.action
      }
    }
    recoveryLog.warn(`[RECOVERY:no-match] No recovery recipe for error kind=${error.kind}`)
    return null
  }

  /**
   * Execute recovery with exponential backoff.
   * Returns true if the retry should proceed, false if exhausted.
   */
  async shouldRetry(
    error: AgentError,
    attemptNumber: number
  ): Promise<{ proceed: boolean; action: RecoveryAction | null; delayMs: number }> {
    const action = this.findRecovery(error)
    if (!action) {
      return { proceed: false, action: null, delayMs: 0 }
    }

    if (action.type === 'abort') {
      return { proceed: false, action, delayMs: 0 }
    }

    const maxRetries = action.maxRetries ?? 1
    if (attemptNumber >= maxRetries) {
      recoveryLog.warn(
        `[RECOVERY:exhausted] Max retries (${maxRetries}) reached for ${error.kind}`
      )
      return { proceed: false, action, delayMs: 0 }
    }

    // Exponential backoff: baseDelay * 2^attempt
    const baseDelay = action.delayMs ?? 1000
    const delayMs = baseDelay * Math.pow(2, attemptNumber)
    recoveryLog.info(
      `[RECOVERY:retry] attempt=${attemptNumber + 1}/${maxRetries} delayMs=${delayMs}`
    )

    // Wait before retrying
    await new Promise((resolve) => setTimeout(resolve, delayMs))

    return { proceed: true, action, delayMs }
  }

  /**
   * Register a custom recovery recipe (e.g. workspace-specific).
   * Custom recipes can override built-in ones by using lower priority numbers.
   */
  addRecipe(recipe: RecoveryRecipe): void {
    this.recipes.push(recipe)
    recoveryLog.info(`[RECOVERY:registered] Custom recipe: ${recipe.name}`)
  }

  /**
   * Remove a recipe by name.
   */
  removeRecipe(name: string): boolean {
    const index = this.recipes.findIndex((r) => r.name === name)
    if (index >= 0) {
      this.recipes.splice(index, 1)
      return true
    }
    return false
  }

  /**
   * Get all registered recipes (for debugging/display).
   */
  getRecipes(): RecoveryRecipe[] {
    return [...this.recipes].sort((a, b) => a.priority - b.priority)
  }
}

export const recoveryRecipeService = new RecoveryRecipeService()
