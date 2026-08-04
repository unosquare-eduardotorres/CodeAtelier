/**
 * Phase 27 — one-shot-local.ts pure function test.
 *
 * Tests buildMemoryFeedFallbackArgs — pure string → string[] function.
 */
import assert from 'node:assert/strict'
import { test, describe, summary } from './test-harness'
import { setupFullMock, mockService, createSpy } from './setup-full-mock'

setupFullMock()
mockService('model-config.service', {
  modelConfigService: { getLocalLLMConfig: createSpy(() => ({})) }
})
mockService('ollama-manager', { ollamaManagerService: {} })
mockService('omlx-manager', { omlxManagerService: {} })

const { buildMemoryFeedFallbackArgs } = require('../one-shot-local')

describe('buildMemoryFeedFallbackArgs — fallback arg construction', () => {
  test('returns non-empty array', () => {
    const result = buildMemoryFeedFallbackArgs('Extract facts from this commit')
    assert.ok(Array.isArray(result))
    assert.ok(result.length > 0)
  })

  test('includes the prompt text', () => {
    const prompt = 'Extract key architectural decisions'
    const result = buildMemoryFeedFallbackArgs(prompt)
    const joined = result.join(' ')
    assert.ok(joined.includes(prompt) || result.some((a) => a === prompt))
  })

  test('includes required CLI flags', () => {
    const result = buildMemoryFeedFallbackArgs('test prompt')
    // Should include -p flag for prompt
    assert.ok(result.includes('-p') || result.some((a) => a.startsWith('--')))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  summary()
}
