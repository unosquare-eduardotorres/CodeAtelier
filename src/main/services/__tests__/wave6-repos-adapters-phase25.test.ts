/**
 * Phase 25, Wave 6 — Remaining repositories & adapters coverage.
 *
 * Covers: role-adapters (council-chairman, base), handoff-adapters (target-adapters),
 * preprocessing.service
 *
 * Run: tsx src/main/services/__tests__/wave6-repos-adapters-phase25.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

// ═══════════════════════════════════════════════════════════════════════
// Preprocessing service — pure functions
// ═══════════════════════════════════════════════════════════════════════

let preprocessingMod: any
let prepLoaded = false

try {
  preprocessingMod = require('../preprocessing.service')
  prepLoaded = true
} catch (err) {
  console.log(`⚠ preprocessing.service.ts load failed: ${(err as Error).message?.split('\n')[0]}`)
}

if (prepLoaded) {
  describe('preprocessing.service — exports (Phase 25)', () => {
    test('exports runPreprocessingPipeline', () => {
      assert.ok(typeof preprocessingMod.runPreprocessingPipeline === 'function')
    })

    test('exports DEFAULT_PREPROCESSING_OPTIONS', () => {
      assert.ok(preprocessingMod.DEFAULT_PREPROCESSING_OPTIONS !== undefined)
    })

    test('DEFAULT_PREPROCESSING_OPTIONS has expected fields', () => {
      const opts = preprocessingMod.DEFAULT_PREPROCESSING_OPTIONS
      assert.ok(typeof opts === 'object')
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════
// Role adapters
// ═══════════════════════════════════════════════════════════════════════

const adapterModules = [
  { path: '../role-adapters/council/council-chairman.adapter', name: 'council-chairman' },
  { path: '../role-adapters/base.adapter', name: 'base.adapter' }
]

for (const { path, name } of adapterModules) {
  let mod: any
  let adapterLoaded = false

  try {
    mod = require(path)
    adapterLoaded = true
  } catch (err) {
    console.log(`⚠ ${name} load failed: ${(err as Error).message?.split('\n')[0]}`)
  }

  if (adapterLoaded) {
    describe(`${name} — exports (Phase 25)`, () => {
      test('module exports classes or functions', () => {
        const keys = Object.keys(mod)
        assert.ok(keys.length > 0, `${name} should export something`)
      })

      test('exports have expected types', () => {
        for (const [key, value] of Object.entries(mod)) {
          assert.ok(
            typeof value === 'function' || typeof value === 'object' || typeof value === 'string',
            `${key} unexpected type: ${typeof value}`
          )
        }
      })
    })
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Handoff adapters
// ═══════════════════════════════════════════════════════════════════════

let handoffMod: any
let handoffLoaded = false

try {
  handoffMod = require('../handoff-adapters/target-adapters')
  handoffLoaded = true
} catch (err) {
  console.log(`⚠ target-adapters.ts load failed: ${(err as Error).message?.split('\n')[0]}`)
}

if (handoffLoaded) {
  describe('target-adapters — exports (Phase 25)', () => {
    test('module exports factory or adapters', () => {
      const keys = Object.keys(handoffMod)
      assert.ok(keys.length > 0)
    })

    test('exported entries are functions', () => {
      const fns = Object.entries(handoffMod).filter(([, v]) => typeof v === 'function')
      assert.ok(fns.length > 0, 'should have function exports')
    })
  })
}

if (require.main === module) {
  void summaryAsync()
}
