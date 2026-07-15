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

    test('returns null (proceeds) when provider is local-llm (R6-B1: guard removed)', () => {
      return withSettings({ ...DEFAULT_SETTINGS, llmProvider: 'local-llm' }, async () => {
        const result = promptOptimizerService.checkGuards({
          text: LONG_PROMPT,
          workspaceId: 'ws-test'
        })
        assert.equal(result, null, 'local-llm should no longer be guarded')
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

    test('proceeds for local-llm provider (R6-B1: guard removed, optimize routes to local path)', async () => {
      // When local-llm is the provider, optimize() should attempt the local path.
      // With the _localRunner seam set, it exercises the local code path.
      return withSettings({ ...DEFAULT_SETTINGS, llmProvider: 'local-llm' }, async () => {
        const svc = promptOptimizerService as unknown as AnyService
        const origLocal = svc._localRunner
        svc._localRunner = async () => ({
          text: '```optimized-prompt\nClearer version of the prompt\n```'
        })
        try {
          const result = await promptOptimizerService.optimize(DEFAULT_PARAMS)
          assert.equal(result.changed, true)
          assert.equal(result.optimizedText, 'Clearer version of the prompt')
        } finally {
          svc._localRunner = origLocal
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

  // ── Fence-variant parsing (local-model resilience) ──

  describe('optimize — fence variants', () => {
    test('parses plain ``` fence (no info string) as fallback', async () => {
      const optimized = 'Review the auth middleware for JWT token validation vulnerabilities.'
      return withSettings(DEFAULT_SETTINGS, async () => {
        const runner = withRunner(`\`\`\`\n${optimized}\n\`\`\``)
        try {
          const result = await promptOptimizerService.optimize(DEFAULT_PARAMS)
          assert.equal(result.changed, true)
          assert.equal(result.optimizedText, optimized)
          assert.equal(result.skippedReason, undefined)
        } finally {
          runner.restore()
        }
      })
    })

    test('parses <think> block + generic fence from local model', async () => {
      const optimized = 'Improved prompt after thinking'
      return withSettings({ ...DEFAULT_SETTINGS, llmProvider: 'local-llm' }, async () => {
        const svc = promptOptimizerService as unknown as AnyService
        const origLocal = svc._localRunner
        svc._localRunner = async () => ({
          text: `<think>Let me analyze this...</think>\n\`\`\`\n${optimized}\n\`\`\``
        })
        try {
          const result = await promptOptimizerService.optimize(DEFAULT_PARAMS)
          assert.equal(result.changed, true)
          assert.equal(result.optimizedText, optimized)
        } finally {
          svc._localRunner = origLocal
        }
      })
    })

    test('raw text with no fence still returns parse-error', async () => {
      return withSettings(DEFAULT_SETTINGS, async () => {
        const runner = withRunner('Here is a better version of your prompt without any fences at all')
        try {
          const result = await promptOptimizerService.optimize(DEFAULT_PARAMS)
          assert.equal(result.changed, false)
          assert.equal(result.skippedReason, 'parse-error')
        } finally {
          runner.restore()
        }
      })
    })

    test('multiple generic fences reject (ambiguous) — falls to parse-error', async () => {
      return withSettings(DEFAULT_SETTINGS, async () => {
        const runner = withRunner('\`\`\`\nBlock one\n\`\`\`\n\nSome text\n\`\`\`\nBlock two\n\`\`\`')
        try {
          const result = await promptOptimizerService.optimize(DEFAULT_PARAMS)
          assert.equal(result.changed, false)
          assert.equal(result.skippedReason, 'parse-error')
        } finally {
          runner.restore()
        }
      })
    })

    test('NO_CHANGES with trailing prose returns changed=false, no skippedReason', async () => {
      return withSettings(DEFAULT_SETTINGS, async () => {
        const runner = withRunner('NO_CHANGES — the prompt is already clear and actionable.')
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
  })

  // ── resolveLocalModel ──

  describe('resolveLocalModel', () => {
    test('default assignment (no modelRoles) returns localCfg.localModel, not a Claude model', () => {
      return withSettings(
        { ...DEFAULT_SETTINGS, llmProvider: 'local-llm' },
        async () => {
          const result = promptOptimizerService.resolveLocalModel('ws-test', {
            localModel: 'Qwen3.6-35B-A3B-MLX-8bit'
          })
          assert.equal(result, 'Qwen3.6-35B-A3B-MLX-8bit')
          assert.ok(
            !result.startsWith('claude-'),
            `Expected local model, got Claude model: ${result}`
          )
        }
      )
    })

    test('explicit local role in modelRoles returns the role modelId', () => {
      return withSettings(
        {
          ...DEFAULT_SETTINGS,
          llmProvider: 'local-llm',
          modelRoles: {
            'prompt:optimize': { provider: 'local-llm', modelId: 'my-local' }
          }
        },
        async () => {
          const result = promptOptimizerService.resolveLocalModel('ws-test', {
            localModel: 'fallback-model'
          })
          assert.equal(result, 'my-local')
        }
      )
    })

    test('no localModel configured falls back to qwen3-coder', () => {
      return withSettings(
        { ...DEFAULT_SETTINGS, llmProvider: 'local-llm' },
        async () => {
          const result = promptOptimizerService.resolveLocalModel('ws-test', {})
          assert.equal(result, 'qwen3-coder')
        }
      )
    })
  })

  // ── R6-B4: Local LLM path tests via _localRunner seam ──

  describe('optimize — local LLM path', () => {
    /** Set _localRunner on the service. Returns restore function. */
    function withLocalRunner(
      response: string | Error
    ): { restore: () => void } {
      const svc = promptOptimizerService as unknown as AnyService
      const orig = svc._localRunner
      if (response instanceof Error) {
        svc._localRunner = async () => { throw response }
      } else {
        svc._localRunner = async () => ({ text: response })
      }
      return { restore: () => { svc._localRunner = orig } }
    }

    test('parses fence block from local model', async () => {
      const optimized = 'Review the auth middleware for JWT vulnerabilities including expiry handling.'
      return withSettings({ ...DEFAULT_SETTINGS, llmProvider: 'local-llm' }, async () => {
        const lr = withLocalRunner(`\`\`\`optimized-prompt\n${optimized}\n\`\`\``)
        try {
          const result = await promptOptimizerService.optimize(DEFAULT_PARAMS)
          assert.equal(result.changed, true)
          assert.equal(result.optimizedText, optimized)
        } finally {
          lr.restore()
        }
      })
    })

    test('strips <think> blocks from local model reasoning leakage', async () => {
      const optimized = 'Improved prompt text'
      return withSettings({ ...DEFAULT_SETTINGS, llmProvider: 'local-llm' }, async () => {
        const lr = withLocalRunner(
          '<think>Let me think about this...</think>\n```optimized-prompt\n' + optimized + '\n```'
        )
        try {
          const result = await promptOptimizerService.optimize(DEFAULT_PARAMS)
          assert.equal(result.changed, true)
          assert.equal(result.optimizedText, optimized)
        } finally {
          lr.restore()
        }
      })
    })

    test('empty local response falls back to original prompt', async () => {
      return withSettings({ ...DEFAULT_SETTINGS, llmProvider: 'local-llm' }, async () => {
        const lr = withLocalRunner('')
        try {
          const result = await promptOptimizerService.optimize(DEFAULT_PARAMS)
          assert.equal(result.changed, false)
          assert.equal(result.skippedReason, 'error')
          assert.equal(result.optimizedText, LONG_PROMPT)
        } finally {
          lr.restore()
        }
      })
    })

    test('local runner error falls back to original prompt', async () => {
      return withSettings({ ...DEFAULT_SETTINGS, llmProvider: 'local-llm' }, async () => {
        const lr = withLocalRunner(new Error('Connection refused'))
        try {
          const result = await promptOptimizerService.optimize(DEFAULT_PARAMS)
          assert.equal(result.changed, false)
          assert.equal(result.skippedReason, 'error')
          assert.equal(result.optimizedText, LONG_PROMPT)
        } finally {
          lr.restore()
        }
      })
    })

    test('NO_CHANGES sentinel from local model returns original', async () => {
      return withSettings({ ...DEFAULT_SETTINGS, llmProvider: 'local-llm' }, async () => {
        const lr = withLocalRunner('NO_CHANGES')
        try {
          const result = await promptOptimizerService.optimize(DEFAULT_PARAMS)
          assert.equal(result.changed, false)
          assert.equal(result.optimizedText, LONG_PROMPT)
        } finally {
          lr.restore()
        }
      })
    })
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
