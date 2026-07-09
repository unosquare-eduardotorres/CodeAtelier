/**
 * Unit tests for PromptOptimizerService — verifies all skip guards,
 * fence parsing, NO_CHANGES sentinel, oversize rejection, and error fallback.
 *
 * Uses the _runner test seam on the service, which passes through to
 * runOneShotClaude's _runner option. The real optimize() body executes
 * end-to-end: guards → model resolution → CLI args → parseResponse → error fallback.
 * Only the actual CLI subprocess is replaced.
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { promptOptimizerService } from '../prompt-optimizer.service'
import { workspaceRepository } from '../../db/repositories'

// ── Helpers ────────────────────────────────────────────────────────────

type AnyService = Record<string, unknown>

/** Default workspace settings — prompt optimization enabled, Claude provider */
const DEFAULT_SETTINGS = {
  promptOptimizationEnabled: true,
  llmProvider: 'claude'
}

/** Monkey-patch workspace settings for the duration of a test. */
function withSettings(
  settings: Record<string, unknown>,
  fn: () => Promise<void>
): Promise<void> {
  const orig = workspaceRepository.getSettings
  ;(workspaceRepository as unknown as AnyService).getSettings = (): Record<string, unknown> => settings
  return fn().finally(() => {
    ;(workspaceRepository as unknown as AnyService).getSettings = orig
  })
}

/**
 * Build a fake CLI JSON response that runOneShotClaude will parse.
 * The `result` field contains the LLM response text that parseResponse will handle.
 */
function fakeCliResponse(resultText: string): string {
  return JSON.stringify({
    result: resultText,
    usage: { input_tokens: 100, output_tokens: 50 },
    model: 'claude-haiku-4-5-20251001'
  })
}

/**
 * Set the _runner seam on the service. Returns a restore function.
 * When `response` is a string, the runner returns a valid CLI JSON response.
 * When `response` is an Error, the runner throws.
 */
function withRunner(
  response: string | Error
): { restore: () => void } {
  const svc = promptOptimizerService as unknown as AnyService
  const origRunner = svc._runner

  if (response instanceof Error) {
    svc._runner = async () => { throw response }
  } else {
    svc._runner = async () => fakeCliResponse(response)
  }

  return {
    restore: () => {
      svc._runner = origRunner
    }
  }
}

const LONG_PROMPT =
  'Please review the authentication middleware in our Express application and identify any security vulnerabilities related to JWT token validation.'

const DEFAULT_PARAMS = {
  text: LONG_PROMPT,
  workspaceId: 'ws-test',
  conversationId: 'conv-test',
  mode: 'build' as const
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('PromptOptimizerService', () => {
  // ── Guard tests ──

  describe('checkGuards', () => {
    test('returns null when all guards pass', () => {
      return withSettings(DEFAULT_SETTINGS, async () => {
        const result = promptOptimizerService.checkGuards({
          text: LONG_PROMPT,
          workspaceId: 'ws-test'
        })
        assert.equal(result, null)
      })
    })

    test('returns "disabled" when promptOptimizationEnabled is false', () => {
      return withSettings({ ...DEFAULT_SETTINGS, promptOptimizationEnabled: false }, async () => {
        const result = promptOptimizerService.checkGuards({
          text: LONG_PROMPT,
          workspaceId: 'ws-test'
        })
        assert.equal(result, 'disabled')
      })
    })

    test('returns "local-llm" when provider is local-llm', () => {
      return withSettings({ ...DEFAULT_SETTINGS, llmProvider: 'local-llm' }, async () => {
        const result = promptOptimizerService.checkGuards({
          text: LONG_PROMPT,
          workspaceId: 'ws-test'
        })
        assert.equal(result, 'local-llm')
      })
    })

    test('returns "short" when prompt is under 80 chars', () => {
      return withSettings(DEFAULT_SETTINGS, async () => {
        const result = promptOptimizerService.checkGuards({
          text: 'Fix the bug',
          workspaceId: 'ws-test'
        })
        assert.equal(result, 'short')
      })
    })

    test('returns "slash-command" when prompt starts with /', () => {
      return withSettings(DEFAULT_SETTINGS, async () => {
        const result = promptOptimizerService.checkGuards({
          text: '/help me with this really long prompt that should be over eighty characters total',
          workspaceId: 'ws-test'
        })
        assert.equal(result, 'slash-command')
      })
    })

  })

  // ── Optimize with guards ──

  describe('optimize — guards', () => {
    test('skips short prompts', async () => {
      return withSettings(DEFAULT_SETTINGS, async () => {
        const runner = withRunner('should not reach here')
        try {
          const result = await promptOptimizerService.optimize({
            ...DEFAULT_PARAMS,
            text: 'continue'
          })
          assert.equal(result.changed, false)
          assert.equal(result.skippedReason, 'short')
          assert.equal(result.optimizedText, 'continue')
        } finally {
          runner.restore()
        }
      })
    })

    test('skips slash commands', async () => {
      return withSettings(DEFAULT_SETTINGS, async () => {
        const runner = withRunner('should not reach here')
        try {
          const result = await promptOptimizerService.optimize({
            ...DEFAULT_PARAMS,
            text: '/plan create a new React component for the dashboard with charts and a data table'
          })
          assert.equal(result.changed, false)
          assert.equal(result.skippedReason, 'slash-command')
        } finally {
          runner.restore()
        }
      })
    })

    test('skips when disabled in settings', async () => {
      return withSettings(
        { ...DEFAULT_SETTINGS, promptOptimizationEnabled: false },
        async () => {
          const runner = withRunner('should not reach here')
          try {
            const result = await promptOptimizerService.optimize(DEFAULT_PARAMS)
            assert.equal(result.changed, false)
            assert.equal(result.skippedReason, 'disabled')
          } finally {
            runner.restore()
          }
        }
      )
    })

    test('skips for local-llm provider', async () => {
      return withSettings({ ...DEFAULT_SETTINGS, llmProvider: 'local-llm' }, async () => {
        const runner = withRunner('should not reach here')
        try {
          const result = await promptOptimizerService.optimize(DEFAULT_PARAMS)
          assert.equal(result.changed, false)
          assert.equal(result.skippedReason, 'local-llm')
        } finally {
          runner.restore()
        }
      })
    })

  })

  // ── Parse behavior (exercises real optimize → parseResponse path) ──

  describe('optimize — parsing', () => {
    test('parses a valid optimized-prompt fence block', async () => {
      const optimized =
        'Review the authentication middleware in the Express app. Specifically identify JWT token validation vulnerabilities including: expired token handling, signature verification, and algorithm confusion attacks.'
      return withSettings(DEFAULT_SETTINGS, async () => {
        const runner = withRunner(
          `Here is the improved version:\n\n\`\`\`optimized-prompt\n${optimized}\n\`\`\`\n`
        )
        try {
          const result = await promptOptimizerService.optimize(DEFAULT_PARAMS)
          assert.equal(result.changed, true)
          assert.equal(result.optimizedText, optimized)
        } finally {
          runner.restore()
        }
      })
    })

    test('handles NO_CHANGES sentinel', async () => {
      return withSettings(DEFAULT_SETTINGS, async () => {
        const runner = withRunner('NO_CHANGES')
        try {
          const result = await promptOptimizerService.optimize(DEFAULT_PARAMS)
          assert.equal(result.changed, false)
          assert.equal(result.optimizedText, LONG_PROMPT)
          assert.equal(result.skippedReason, undefined)
        } finally {
          runner.restore()
        }
      })
    })

    test('rejects oversize output', async () => {
      const oversized = 'x'.repeat(5000)
      return withSettings(DEFAULT_SETTINGS, async () => {
        const runner = withRunner(
          `\`\`\`optimized-prompt\n${oversized}\n\`\`\``
        )
        try {
          const result = await promptOptimizerService.optimize(DEFAULT_PARAMS)
          assert.equal(result.changed, false)
          assert.equal(result.skippedReason, 'oversize')
          assert.equal(result.optimizedText, LONG_PROMPT)
        } finally {
          runner.restore()
        }
      })
    })

    test('falls back on parse error (no fence block)', async () => {
      return withSettings(DEFAULT_SETTINGS, async () => {
        const runner = withRunner('Here is a better prompt without any fenced block.')
        try {
          const result = await promptOptimizerService.optimize(DEFAULT_PARAMS)
          assert.equal(result.changed, false)
          assert.equal(result.skippedReason, 'parse-error')
          assert.equal(result.optimizedText, LONG_PROMPT)
        } finally {
          runner.restore()
        }
      })
    })

    test('falls back on error from Claude CLI', async () => {
      return withSettings(DEFAULT_SETTINGS, async () => {
        const runner = withRunner(new Error('CLI timeout'))
        try {
          const result = await promptOptimizerService.optimize(DEFAULT_PARAMS)
          assert.equal(result.changed, false)
          assert.equal(result.skippedReason, 'error')
          assert.equal(result.optimizedText, LONG_PROMPT)
        } finally {
          runner.restore()
        }
      })
    })

    test('returns changed=false when optimized text equals original', async () => {
      return withSettings(DEFAULT_SETTINGS, async () => {
        const runner = withRunner(
          `\`\`\`optimized-prompt\n${LONG_PROMPT}\n\`\`\``
        )
        try {
          const result = await promptOptimizerService.optimize(DEFAULT_PARAMS)
          assert.equal(result.changed, false)
          assert.equal(result.optimizedText, LONG_PROMPT)
        } finally {
          runner.restore()
        }
      })
    })

    test('returns changed=false when output is empty inside fence', async () => {
      return withSettings(DEFAULT_SETTINGS, async () => {
        const runner = withRunner('```optimized-prompt\n\n```')
        try {
          const result = await promptOptimizerService.optimize(DEFAULT_PARAMS)
          assert.equal(result.changed, false)
          assert.equal(result.skippedReason, 'empty-output')
        } finally {
          runner.restore()
        }
      })
    })
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
