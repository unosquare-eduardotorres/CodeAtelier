/**
 * Unit tests for the review-decorrelation family heuristic.
 *
 * Run: tsx src/shared/__tests__/model-family.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../main/services/__tests__/test-harness'
import { modelFamily, sameModelFamily } from '../model-family'

describe('modelFamily', () => {
  test('every Claude tier collapses to one family — Opus reviewing Sonnet is self-review', () => {
    assert.equal(modelFamily({ provider: 'claude', modelId: 'claude-opus-5' }), 'anthropic')
    assert.equal(modelFamily({ provider: 'claude', modelId: 'claude-sonnet-5' }), 'anthropic')
    assert.equal(
      modelFamily({ provider: 'claude', modelId: 'claude-haiku-4-5-20251001' }),
      'anthropic'
    )
  })

  test('longest prefix wins — codellama is Meta, not a bare llama match on something else', () => {
    assert.equal(modelFamily({ provider: 'local-llm', modelId: 'codellama:13b' }), 'meta')
    assert.equal(modelFamily({ provider: 'local-llm', modelId: 'llama3.3:70b' }), 'meta')
    assert.equal(modelFamily({ provider: 'local-llm', modelId: 'gpt-oss:20b' }), 'openai')
  })

  test('registry path prefixes are stripped before matching', () => {
    assert.equal(modelFamily({ provider: 'local-llm', modelId: 'hf.co/Qwen/Qwen3-32B' }), 'qwen')
    assert.equal(modelFamily({ provider: 'local-llm', modelId: 'library/gemma3:27b' }), 'google')
  })

  test('an unrecognised local model falls back to a provider marker, not a real family', () => {
    assert.equal(modelFamily({ provider: 'local-llm', modelId: 'acme-secret-7b' }), 'unknown-local')
  })

  test('an empty model id falls back to the provider', () => {
    assert.equal(modelFamily({ provider: 'claude', modelId: '' }), 'anthropic')
    assert.equal(modelFamily({ provider: 'glm', modelId: '' }), 'zhipu')
  })
})

describe('sameModelFamily', () => {
  test('warns when the reviewer shares the builder family across tiers', () => {
    assert.equal(
      sameModelFamily(
        { provider: 'claude', modelId: 'claude-opus-5' },
        { provider: 'claude', modelId: 'claude-sonnet-5' }
      ),
      true
    )
  })

  test('a genuinely decorrelated pair does not warn', () => {
    assert.equal(
      sameModelFamily(
        { provider: 'claude', modelId: 'claude-opus-5' },
        { provider: 'local-llm', modelId: 'qwen3:32b' }
      ),
      false
    )
  })

  test('the GLM provider is its own family, not lumped in with local models', () => {
    assert.equal(
      sameModelFamily(
        { provider: 'glm', modelId: 'glm-5.3' },
        { provider: 'local-llm', modelId: 'glm-4-9b' }
      ),
      true,
      'the same weights reached through two providers are still one family'
    )
    assert.equal(
      sameModelFamily(
        { provider: 'glm', modelId: 'glm-5.3' },
        { provider: 'claude', modelId: 'claude-opus-5' }
      ),
      false
    )
  })

  test('two unknown models are treated as different — a warning on every exotic model teaches users to ignore it', () => {
    assert.equal(
      sameModelFamily(
        { provider: 'local-llm', modelId: 'acme-a' },
        { provider: 'local-llm', modelId: 'acme-b' }
      ),
      false
    )
  })

  test('a missing binding never warns', () => {
    assert.equal(sameModelFamily(null, { provider: 'claude', modelId: 'claude-opus-5' }), false)
    assert.equal(
      sameModelFamily({ provider: 'claude', modelId: 'claude-opus-5' }, undefined),
      false
    )
  })
})

if (import.meta.url === `file://${process.argv[1]}`) void summaryAsync()
