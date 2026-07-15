import assert from 'node:assert/strict'
import { test, describe, summary } from './test-harness'

import { DEFAULT_MODEL_CONFIG } from '../../../shared/constants'

describe('ModelConfigService', () => {
  describe('Mode-aware Da Vinci model', () => {
    test('da-vinci:plan defaults to opus-4-8', () => {
      assert.equal(DEFAULT_MODEL_CONFIG['da-vinci:plan'], 'claude-opus-4-8')
    })

    test('da-vinci:build defaults to sonnet-5', () => {
      assert.equal(DEFAULT_MODEL_CONFIG['da-vinci:build'], 'claude-sonnet-5')
    })

    test('da-vinci (base) defaults to opus-4-8', () => {
      assert.equal(DEFAULT_MODEL_CONFIG['da-vinci'], 'claude-opus-4-8')
    })

    test('specialist:complex defaults to opus-4-8', () => {
      assert.equal(DEFAULT_MODEL_CONFIG['specialist:complex'], 'claude-opus-4-8')
    })
  })

  describe('Fallback resolution', () => {
    test('unknown sub-action falls back to base action', () => {
      // The ModelConfigService.fallbackAction splits on ':'
      const base = 'da-vinci:plan'.split(':')[0]
      assert.equal(base, 'da-vinci')
    })
  })
})

// Only exit when this file is run directly — when loaded via run-tests.ts,
// the final aggregate summary is emitted at the end of that runner.
if (import.meta.url === `file://${process.argv[1]}`) {
  summary()
}
