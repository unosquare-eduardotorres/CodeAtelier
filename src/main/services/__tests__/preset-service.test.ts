/**
 * Unit tests for preset.service.ts — resolution, validation, and label logic.
 *
 * Pure-logic tests use null presetId (no DB). DB-dependent tests use trySetupTestDb().
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { presetService } from '../preset.service'
import { DEFAULT_MODEL_CONFIG, AVAILABLE_MODELS, ACTION_GROUPS } from '../../../shared/constants'
import type { ActionModelConfig, ModelAction } from '../../../shared/types'
import { trySetupTestDb } from '../../db/repositories/__tests__/db-test-helper'

// ── Pure-logic: resolveAction with null presetId ──

describe('PresetService.resolveAction — null presetId', () => {
  test('null presetId, known action "da-vinci" → returns DEFAULT_MODEL_CONFIG fallback', () => {
    const result = presetService.resolveAction(null, 'da-vinci')
    assert.equal(result.modelId, DEFAULT_MODEL_CONFIG['da-vinci'])
    assert.equal(result.provider, 'claude')
  })

  test('null presetId, compound action "da-vinci:plan" → falls through to default', () => {
    const result = presetService.resolveAction(null, 'da-vinci:plan')
    assert.equal(result.modelId, DEFAULT_MODEL_CONFIG['da-vinci:plan'])
    assert.equal(result.provider, 'claude')
  })

  test('null presetId, unknown action → falls back to "da-vinci" catch-all', () => {
    const result = presetService.resolveAction(null, 'unknown-action' as ModelAction)
    // When action is unknown AND base is unknown, falls to DEFAULT_MODEL_CONFIG['da-vinci']
    assert.equal(result.modelId, DEFAULT_MODEL_CONFIG['da-vinci'])
  })

  test('result always has provider "claude"', () => {
    for (const action of ['da-vinci', 'audit', 'grill', 'haiku'] as ModelAction[]) {
      const result = presetService.resolveAction(null, action)
      assert.equal(result.provider, 'claude', `action=${action} should be claude`)
    }
  })
})

// ── Pure-logic: resolveProvider ──

describe('PresetService.resolveProvider — null presetId', () => {
  test('resolveProvider(null, "da-vinci") returns "claude"', () => {
    assert.equal(presetService.resolveProvider(null, 'da-vinci'), 'claude')
  })

  test('resolveProvider(null, "da-vinci:build") returns "claude"', () => {
    assert.equal(presetService.resolveProvider(null, 'da-vinci:build'), 'claude')
  })
})

// ── Pure-logic: resolveExecutorBackend ──

describe('PresetService.resolveExecutorBackend — null presetId', () => {
  test('null presetId → always returns "cli" (Claude default)', () => {
    assert.equal(presetService.resolveExecutorBackend(null, 'da-vinci'), 'cli')
  })

  test('with known Claude action → "cli"', () => {
    assert.equal(presetService.resolveExecutorBackend(null, 'audit'), 'cli')
  })
})

// ── Pure-logic: resolveLocalBackend ──

describe('PresetService.resolveLocalBackend — null presetId', () => {
  test('null presetId → returns undefined (not local)', () => {
    assert.equal(presetService.resolveLocalBackend(null, 'da-vinci'), undefined)
  })

  test('Claude provider → undefined', () => {
    assert.equal(presetService.resolveLocalBackend(null, 'grill'), undefined)
  })
})

// ── Pure-logic: validatePreset ──

describe('PresetService.validatePreset', () => {
  test('empty config → { valid: true, errors: [] }', () => {
    const result = presetService.validatePreset({})
    assert.equal(result.valid, true)
    assert.equal(result.errors.length, 0)
  })

  test('only plan actions set → valid', () => {
    const config: Partial<Record<ModelAction, ActionModelConfig>> = {
      'da-vinci:plan': { provider: 'claude', modelId: 'claude-opus-4-8' }
    }
    const result = presetService.validatePreset(config)
    assert.equal(result.valid, true)
  })

  test('only build actions set → valid', () => {
    const config: Partial<Record<ModelAction, ActionModelConfig>> = {
      'da-vinci:build': { provider: 'local-llm', modelId: 'qwen3:30b' }
    }
    const result = presetService.validatePreset(config)
    assert.equal(result.valid, true)
  })

  test('matching plan + build providers → valid', () => {
    const config: Partial<Record<ModelAction, ActionModelConfig>> = {
      'da-vinci:plan': { provider: 'claude', modelId: 'claude-opus-4-8' },
      'da-vinci:build': { provider: 'claude', modelId: 'claude-sonnet-4-6' }
    }
    const result = presetService.validatePreset(config)
    assert.equal(result.valid, true)
  })

  test('mismatched plan (claude) + build (local-llm) → invalid with chat field error', () => {
    const config: Partial<Record<ModelAction, ActionModelConfig>> = {
      'da-vinci:plan': { provider: 'claude', modelId: 'claude-opus-4-8' },
      'da-vinci:build': { provider: 'local-llm', modelId: 'qwen3:30b' }
    }
    const result = presetService.validatePreset(config)
    assert.equal(result.valid, false)
    assert.ok(result.errors.length > 0)
    assert.equal(result.errors[0].field, 'chat')
    assert.ok(result.errors[0].message.includes('same provider'))
  })
})

// ── Pure-logic: getModelShortLabel ──

describe('PresetService.getModelShortLabel (private)', () => {
  const svc = presetService as unknown as {
    getModelShortLabel: (config: ActionModelConfig) => string
  }

  test('local-llm model "qwen3-coder:30b" → "Qwen3-coder"', () => {
    const label = svc.getModelShortLabel({
      provider: 'local-llm',
      modelId: 'qwen3-coder:30b'
    })
    assert.equal(label, 'Qwen3-coder')
  })

  test('Claude model ID in AVAILABLE_MODELS → returns model label', () => {
    const model = AVAILABLE_MODELS[0] // haiku
    const label = svc.getModelShortLabel({
      provider: 'claude',
      modelId: model.id
    })
    assert.equal(label, model.label)
  })

  test('unknown Claude model ID → returns raw modelId', () => {
    const label = svc.getModelShortLabel({
      provider: 'claude',
      modelId: 'claude-unknown-99'
    })
    assert.equal(label, 'claude-unknown-99')
  })
})

// ── DB-dependent tests ──

const env = trySetupTestDb()

if (env) {
  const { db, wsId } = env

  describe('PresetService.resolveAction — with preset (DB)', () => {
    test('preset with direct action config → returns preset config', () => {
      const preset = presetService.createPreset(wsId, 'Custom Config', {
        'da-vinci': { provider: 'local-llm', modelId: 'qwen3:30b', localBackend: 'ollama' }
      })
      const result = presetService.resolveAction(preset.id, 'da-vinci')
      assert.equal(result.provider, 'local-llm')
      assert.equal(result.modelId, 'qwen3:30b')
    })

    test('preset with base action only → base fallback for compound action', () => {
      const preset = presetService.createPreset(wsId, 'Base Only', {
        'da-vinci': { provider: 'local-llm', modelId: 'llama3:8b' }
      })
      // da-vinci:plan not set, should fall back to da-vinci base
      const result = presetService.resolveAction(preset.id, 'da-vinci:plan')
      assert.equal(result.provider, 'local-llm')
      assert.equal(result.modelId, 'llama3:8b')
    })

    test('preset with no matching action → falls back to DEFAULT', () => {
      const preset = presetService.createPreset(wsId, 'Sparse Config', {
        audit: { provider: 'claude', modelId: 'claude-opus-4-8' }
      })
      // Request da-vinci which is not in preset
      const result = presetService.resolveAction(preset.id, 'da-vinci')
      assert.equal(result.provider, 'claude')
      assert.equal(result.modelId, DEFAULT_MODEL_CONFIG['da-vinci'])
    })
  })

  describe('PresetService.resolveExecutorBackend — with preset (DB)', () => {
    test('local-llm provider → "opencode"', () => {
      const preset = presetService.createPreset(wsId, 'Local Preset', {
        'da-vinci': { provider: 'local-llm', modelId: 'qwen3:30b', localBackend: 'ollama' }
      })
      assert.equal(presetService.resolveExecutorBackend(preset.id, 'da-vinci'), 'opencode')
    })
  })

  describe('PresetService.resolveLocalBackend — with preset (DB)', () => {
    test('local-llm with ollama → "ollama"', () => {
      const preset = presetService.createPreset(wsId, 'Ollama Preset', {
        'da-vinci': { provider: 'local-llm', modelId: 'qwen3:30b', localBackend: 'ollama' }
      })
      assert.equal(presetService.resolveLocalBackend(preset.id, 'da-vinci'), 'ollama')
    })

    test('local-llm without localBackend → defaults to "ollama"', () => {
      const preset = presetService.createPreset(wsId, 'NoBackend Preset', {
        'da-vinci': { provider: 'local-llm', modelId: 'qwen3:30b' }
      })
      assert.equal(presetService.resolveLocalBackend(preset.id, 'da-vinci'), 'ollama')
    })
  })

  describe('PresetService.getPresetSummary (DB)', () => {
    test('Full Claude built-in → "All actions use Claude defaults"', () => {
      presetService.ensureBuiltIns(wsId)
      const allPresets = presetService.getAllPresets(wsId)
      const fullClaude = allPresets.find((p) => p.name === 'Full Claude')
      assert.ok(fullClaude)
      assert.equal(presetService.getPresetSummary(fullClaude!.id), 'All actions use Claude defaults')
    })

    test('unknown preset ID → empty string', () => {
      assert.equal(presetService.getPresetSummary('nonexistent-id'), '')
    })
  })
} else {
  describe('PresetService DB tests (skipped)', () => {
    test('skipped — native module unavailable', () => {}, {
      skipReason: 'better-sqlite3 not compatible'
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
