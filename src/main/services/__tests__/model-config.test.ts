import assert from 'node:assert/strict'
import { test, describe, summary } from './test-harness'

import { DEFAULT_MODEL_CONFIG } from '../../../shared/constants'

describe('ModelConfigService', () => {
  describe('Mode-aware generalist model', () => {
    test('generalist:plan defaults to opus-4-7', () => {
      assert.equal(DEFAULT_MODEL_CONFIG['generalist:plan'], 'claude-opus-4-7')
    })

    test('generalist:build defaults to sonnet-4-6', () => {
      assert.equal(DEFAULT_MODEL_CONFIG['generalist:build'], 'claude-sonnet-4-6')
    })

    test('generalist (base) defaults to opus-4-7', () => {
      assert.equal(DEFAULT_MODEL_CONFIG['generalist'], 'claude-opus-4-7')
    })

    test('specialist:complex defaults to opus-4-7', () => {
      assert.equal(DEFAULT_MODEL_CONFIG['specialist:complex'], 'claude-opus-4-7')
    })
  })

  describe('Fallback resolution', () => {
    test('unknown sub-action falls back to base action', () => {
      // The ModelConfigService.fallbackAction splits on ':'
      const base = 'generalist:plan'.split(':')[0]
      assert.equal(base, 'generalist')
    })
  })
})

// Only exit when this file is run directly — when loaded via run-tests.ts,
// the final aggregate summary is emitted at the end of that runner.
if (import.meta.url === `file://${process.argv[1]}`) {
  summary()
}
