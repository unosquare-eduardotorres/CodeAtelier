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
import { setupElectronStub } from './electron-stub'
import { test, describe, summaryAsync } from './test-harness'

// Install electron stubs BEFORE importing services that depend on the DB.
// This intercepts `require('electron')` and Vite `?raw` SQL imports so the
// test can run standalone (`npx tsx prompt-optimizer.test.ts`) as well as
// through run-tests.ts. The call is idempotent — safe when the runner
// has already called it.
setupElectronStub()

const { promptOptimizerService } =
  require('../prompt-optimizer.service') as typeof import('../prompt-optimizer.service')

const { workspaceRepository } =
  require('../../db/repositories') as typeof import('../../db/repositories')

// ── Helpers ────────────────────────────────────────────────────────────

type AnyService = Record<string, unknown>

/** Default workspace settings — prompt optimization enabled, Claude provider */
const DEFAULT_SETTINGS = {
  promptOptimizationEnabled: true,
  llmProvider: 'claude'
}

/** Monkey-patch workspace settings for the duration of a test. */
function withSettings(settings: Record<string, unknown>, fn: () => Promise<void>): Promise<void> {
  const orig = workspaceRepository.getSettings
  ;(workspaceRepository as unknown as AnyService).getSettings = (): Record<string, unknown> =>
    settings
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
function withRunner(response: string | Error): { restore: () => void } {
  const svc = promptOptimizerService as unknown as AnyService
  const origRunner = svc._runner

  if (response instanceof Error) {
    svc._runner = async () => {
      throw response
    }
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
      return withSettings({ ...DEFAULT_SETTINGS, promptOptimizationEnabled: false }, async () => {
        const runner = withRunner('should not reach here')
        try {
          const result = await promptOptimizerService.optimize(DEFAULT_PARAMS)
          assert.equal(result.changed, false)
          assert.equal(result.skippedReason, 'disabled')
        } finally {
          runner.restore()
        }
      })
    })

    test('proceeds for local-llm provider (R6-B1: guard removed, optimize routes to local path)', async () => {
      // When local-llm is the provider, optimize() should attempt the local path.
      // With the _localRunner seam set, it exercises the local code path.
      return withSettings({ ...DEFAULT_SETTINGS, llmProvider: 'local-llm' }, async () => {
        const svc = promptOptimizerService as unknown as AnyService
        const origLocal = svc._localRunner
        svc._localRunner = async () => ({
          text: '```optimized-prompt\nReview the authentication middleware in the Express application for security vulnerabilities in JWT token validation\n```'
        })
        try {
          const result = await promptOptimizerService.optimize(DEFAULT_PARAMS)
          assert.equal(result.changed, true)
          assert.equal(
            result.optimizedText,
            'Review the authentication middleware in the Express application for security vulnerabilities in JWT token validation'
          )
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
        const runner = withRunner(`\`\`\`optimized-prompt\n${oversized}\n\`\`\``)
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
          assert.equal(result.errorDetail, 'CLI timeout')
          assert.equal(result.optimizedText, LONG_PROMPT)
        } finally {
          runner.restore()
        }
      })
    })

    test('returns changed=false when optimized text equals original', async () => {
      return withSettings(DEFAULT_SETTINGS, async () => {
        const runner = withRunner(`\`\`\`optimized-prompt\n${LONG_PROMPT}\n\`\`\``)
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
      const optimized =
        'Review the authentication middleware in the Express application and identify security vulnerabilities in JWT token validation.'
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
      const optimized =
        'Analyze the authentication middleware in the Express application for security vulnerabilities in JWT token validation'
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
        const runner = withRunner(
          'Here is a better version of your prompt without any fences at all'
        )
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
        const runner = withRunner('```\nBlock one\n```\n\nSome text\n```\nBlock two\n```')
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
      return withSettings({ ...DEFAULT_SETTINGS, llmProvider: 'local-llm' }, async () => {
        const result = promptOptimizerService.resolveLocalModel('ws-test', {
          localModel: 'Qwen3.6-35B-A3B-MLX-8bit'
        })
        assert.equal(result, 'Qwen3.6-35B-A3B-MLX-8bit')
        assert.ok(
          !result.startsWith('claude-'),
          `Expected local model, got Claude model: ${result}`
        )
      })
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
      return withSettings({ ...DEFAULT_SETTINGS, llmProvider: 'local-llm' }, async () => {
        const result = promptOptimizerService.resolveLocalModel('ws-test', {})
        assert.equal(result, 'qwen3-coder')
      })
    })
  })

  // ── R6-B4: Local LLM path tests via _localRunner seam ──

  describe('optimize — local LLM path', () => {
    /** Set _localRunner on the service. Returns restore function. */
    function withLocalRunner(response: string | Error): { restore: () => void } {
      const svc = promptOptimizerService as unknown as AnyService
      const orig = svc._localRunner
      if (response instanceof Error) {
        svc._localRunner = async () => {
          throw response
        }
      } else {
        svc._localRunner = async () => ({ text: response })
      }
      return {
        restore: () => {
          svc._localRunner = orig
        }
      }
    }

    test('parses fence block from local model', async () => {
      const optimized =
        'Review the authentication middleware for security vulnerabilities in JWT token validation including expiry handling.'
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
      const optimized =
        'Review the authentication middleware in Express for security vulnerabilities in JWT token validation'
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

  // ── Anti-hallucination hardening tests ──

  describe('optimize — oversize guard (proportional + floor)', () => {
    test('accepts output under 2000-char floor for short originals', async () => {
      // 200-char original → 4× = 800, but floor is 2000, so 1800-char output should pass
      const shortOriginal =
        'A'.repeat(80) +
        ' review the authentication middleware and check for JWT vulnerabilities in our Express app'
      const optimized1800 = 'B'.repeat(1800)
      return withSettings(DEFAULT_SETTINGS, async () => {
        const runner = withRunner(`\`\`\`optimized-prompt\n${optimized1800}\n\`\`\``)
        try {
          const result = await promptOptimizerService.optimize({
            ...DEFAULT_PARAMS,
            text: shortOriginal
          })
          // Should not be rejected as oversize (1800 < 2000 floor)
          assert.notEqual(result.skippedReason, 'oversize')
        } finally {
          runner.restore()
        }
      })
    })

    test('rejects output exceeding 4× for large originals', async () => {
      // 3000-char original → 4× = 12000, so 13000-char output should be rejected
      const largeOriginal = 'Review the authentication middleware. '.repeat(80) // ~2960 chars
      const oversizedOutput = 'x'.repeat(13000)
      return withSettings(DEFAULT_SETTINGS, async () => {
        const runner = withRunner(`\`\`\`optimized-prompt\n${oversizedOutput}\n\`\`\``)
        try {
          const result = await promptOptimizerService.optimize({
            ...DEFAULT_PARAMS,
            text: largeOriginal
          })
          assert.equal(result.changed, false)
          assert.equal(result.skippedReason, 'oversize')
          assert.equal(result.optimizedText, largeOriginal)
        } finally {
          runner.restore()
        }
      })
    })
  })

  describe('optimize — keyword drift guard', () => {
    test('rejects when optimizer introduces completely different topic', async () => {
      // Original talks about README and charts, optimized talks about database schema
      const original =
        'Based on the context and information that you currently have regarding our app, can you regenerate the ReadMe and add charts showing the architecture'
      const drifted =
        'Design a comprehensive database schema migration strategy with PostgreSQL indexing optimization and query performance benchmarking for the distributed microservices backend'
      return withSettings(DEFAULT_SETTINGS, async () => {
        const runner = withRunner(`\`\`\`optimized-prompt\n${drifted}\n\`\`\``)
        try {
          const result = await promptOptimizerService.optimize({
            ...DEFAULT_PARAMS,
            text: original
          })
          assert.equal(result.changed, false)
          assert.equal(result.skippedReason, 'keyword-drift')
          assert.equal(result.optimizedText, original)
        } finally {
          runner.restore()
        }
      })
    })

    test('accepts rephrased version that preserves core keywords', async () => {
      const original =
        'Please review the authentication middleware in our Express application and identify any security vulnerabilities related to JWT token validation'
      const rephrased =
        'Analyze the authentication middleware in the Express application for security vulnerabilities in JWT token validation, including expired tokens and signature verification'
      return withSettings(DEFAULT_SETTINGS, async () => {
        const runner = withRunner(`\`\`\`optimized-prompt\n${rephrased}\n\`\`\``)
        try {
          const result = await promptOptimizerService.optimize({
            ...DEFAULT_PARAMS,
            text: original
          })
          assert.equal(result.changed, true)
          assert.equal(result.optimizedText, rephrased)
          assert.equal(result.skippedReason, undefined)
        } finally {
          runner.restore()
        }
      })
    })

    test('skips keyword check when original has fewer than 3 significant keywords', async () => {
      // Very short prompts with few meaningful words should not trigger keyword drift
      const original = 'Fix the bug in the code right now please help me with it quickly'
      const optimized = 'Resolve the software defect in the implementation immediately'
      return withSettings(DEFAULT_SETTINGS, async () => {
        const runner = withRunner(`\`\`\`optimized-prompt\n${optimized}\n\`\`\``)
        try {
          const result = await promptOptimizerService.optimize({
            ...DEFAULT_PARAMS,
            text: original
          })
          // Should not be rejected as keyword-drift (too few keywords to judge)
          assert.notEqual(result.skippedReason, 'keyword-drift')
        } finally {
          runner.restore()
        }
      })
    })

    test('words that stem to empty strings do not cause false keyword matches', async () => {
      // "able", "ness", "ment", "less", "ible" all stem to "" before the >=3 filter.
      // Without the filter, both sets would contain "" and count as matching.
      const original =
        'The configurable adjustable reasonable deployable scalable extensible system needs a complete refactor'
      const optimized = 'A completely unrelated prompt about database migration schemas and indexes'
      return withSettings(DEFAULT_SETTINGS, async () => {
        const runner = withRunner(`\`\`\`optimized-prompt\n${optimized}\n\`\`\``)
        try {
          const result = await promptOptimizerService.optimize({
            ...DEFAULT_PARAMS,
            text: original
          })
          assert.equal(result.changed, false)
          assert.equal(result.skippedReason, 'keyword-drift')
          assert.equal(result.optimizedText, original)
        } finally {
          runner.restore()
        }
      })
    })
  })

  // ── Warmup ──

  describe('warmup', () => {
    test('warmup sets system prompt and model then calls backgroundCliSession.warmup', async () => {
      // Verify warmup exists and is callable
      assert.equal(typeof promptOptimizerService.warmup, 'function')
      // The actual backgroundCliSession.warmup() will fail in test (no claude CLI)
      // but that's caught and swallowed — verify it doesn't throw
      await promptOptimizerService.warmup()
    })
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
