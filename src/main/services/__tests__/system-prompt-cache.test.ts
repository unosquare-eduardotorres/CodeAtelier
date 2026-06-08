/**
 * Unit tests for system-prompt-cache.ts — cache for assembled system prompts
 * keyed by mode/conversationId/tone/model, always rebuilding on turn 1.
 * Pure logic.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { SystemPromptCache, type SystemPromptCacheKeys } from '../system-prompt-cache'

const keys = (over: Partial<SystemPromptCacheKeys> = {}): SystemPromptCacheKeys => ({
  mode: 'build',
  conversationId: 'c1',
  tone: 'default',
  model: 'claude-sonnet-4-6',
  ...over
})

describe('SystemPromptCache', () => {
  test('starts empty', () => {
    const cache = new SystemPromptCache()
    assert.equal(cache.get(), null)
  })

  test('isValid is false on turn 1 even after set', () => {
    const cache = new SystemPromptCache()
    cache.set('prompt', keys())
    assert.equal(cache.isValid(keys(), 1), false)
  })

  test('set→get round-trips and isValid true on later turn with same keys', () => {
    const cache = new SystemPromptCache()
    cache.set('the prompt', keys())
    assert.equal(cache.get(), 'the prompt')
    assert.equal(cache.isValid(keys(), 2), true)
  })

  test('isValid false when any key changes', () => {
    const cache = new SystemPromptCache()
    cache.set('p', keys())
    assert.equal(cache.isValid(keys({ mode: 'plan' }), 2), false)
    assert.equal(cache.isValid(keys({ conversationId: 'c2' }), 2), false)
    assert.equal(cache.isValid(keys({ tone: 'concise' as never }), 2), false)
    assert.equal(cache.isValid(keys({ model: 'other' }), 2), false)
  })

  test('isValid false when nothing has been cached', () => {
    const cache = new SystemPromptCache()
    assert.equal(cache.isValid(keys(), 5), false)
  })

  test('invalidate clears the snapshot', () => {
    const cache = new SystemPromptCache()
    cache.set('p', keys())
    cache.invalidate()
    assert.equal(cache.get(), null)
    assert.equal(cache.isValid(keys(), 2), false)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
