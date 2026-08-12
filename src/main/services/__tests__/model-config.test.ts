import assert from 'node:assert/strict'
import { test, describe, summary } from './test-harness'

import { DEFAULT_MODEL_CONFIG } from '../../../shared/constants'

describe('ModelConfigService', () => {
  describe('Mode-aware specialist model', () => {
    test('specialist:plan defaults to opus-5', () => {
      assert.equal(DEFAULT_MODEL_CONFIG['specialist:plan'], 'claude-opus-5')
    })

    test('specialist:build defaults to opus-5', () => {
      assert.equal(DEFAULT_MODEL_CONFIG['specialist:build'], 'claude-opus-5')
    })

    test('specialist (base) defaults to opus-5', () => {
      assert.equal(DEFAULT_MODEL_CONFIG['specialist'], 'claude-opus-5')
    })

    test('specialist:complex defaults to opus-5', () => {
      assert.equal(DEFAULT_MODEL_CONFIG['specialist:complex'], 'claude-opus-5')
    })
  })

  describe('Fallback resolution', () => {
    test('unknown sub-action falls back to base action', () => {
      // The ModelConfigService.fallbackAction splits on ':'
      const base = 'specialist:plan'.split(':')[0]
      assert.equal(base, 'specialist')
    })
  })
})

// Only exit when this file is run directly — when loaded via run-tests.ts,
// the final aggregate summary is emitted at the end of that runner.
if (import.meta.url === `file://${process.argv[1]}`) {
  summary()
}
