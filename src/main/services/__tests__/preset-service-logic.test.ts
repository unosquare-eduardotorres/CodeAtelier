/**
 * Unit tests for PresetService pure methods — validatePreset + summarize.
 *
 * These methods are pure functions on the PresetService class instance.
 * No DB mocking needed — they operate purely on in-memory data.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { presetService } from '../preset.service'
import type { LLMPreset, ActionModelConfig, ModelAction } from '../../../shared/types'

// ── Helpers ──

function makeConfig(
  provider: string,
  modelId = 'test-model'
): ActionModelConfig {
  return { provider: provider as ActionModelConfig['provider'], modelId }
}

function makePreset(
  name: string,
  actionConfig: Partial<Record<ModelAction, ActionModelConfig>> = {}
): LLMPreset {
  return {
    id: 'preset-test-1',
    workspaceId: 'ws-1',
    name,
    isBuiltIn: false,
    actionConfig,
    createdAt: '2025-01-01',
    updatedAt: '2025-01-01'
  }
}

describe('PresetService.validatePreset', () => {
  test('empty_actionConfig_is_valid', () => {
    const result = presetService.validatePreset({})
    assert.equal(result.valid, true)
    assert.equal(result.errors.length, 0)
  })

  test('single_provider_in_constrained_group_is_valid', () => {
    const config: Partial<Record<ModelAction, ActionModelConfig>> = {
      'da-vinci': makeConfig('claude'),
      'da-vinci:plan': makeConfig('claude'),
      'da-vinci:build': makeConfig('claude')
    }
    const result = presetService.validatePreset(config)
    assert.equal(result.valid, true)
    assert.equal(result.errors.length, 0)
  })

  test('mixed_providers_in_constrained_group_is_invalid', () => {
    const config: Partial<Record<ModelAction, ActionModelConfig>> = {
      'da-vinci': makeConfig('claude'),
      'da-vinci:plan': makeConfig('local-llm'),
      'da-vinci:build': makeConfig('claude')
    }
    const result = presetService.validatePreset(config)
    assert.equal(result.valid, false)
    assert.equal(result.errors.length, 1)
    assert.ok(result.errors[0].field === 'chat')
    assert.ok(result.errors[0].message.includes('same provider'))
  })

  test('unconstrained_group_with_mixed_providers_is_valid', () => {
    // Blueprint group is not providerConstrained
    const config: Partial<Record<ModelAction, ActionModelConfig>> = {
      'blueprint:specify': makeConfig('claude'),
      'blueprint:build': makeConfig('local-llm')
    }
    const result = presetService.validatePreset(config)
    assert.equal(result.valid, true)
    assert.equal(result.errors.length, 0)
  })

  test('single_action_configured_in_constrained_group_is_valid', () => {
    // Only one action set — only one provider, so size=1, not >1
    const config: Partial<Record<ModelAction, ActionModelConfig>> = {
      'da-vinci': makeConfig('claude')
    }
    const result = presetService.validatePreset(config)
    assert.equal(result.valid, true)
    assert.equal(result.errors.length, 0)
  })

  test('all_actions_same_provider_is_valid', () => {
    const config: Partial<Record<ModelAction, ActionModelConfig>> = {
      'da-vinci': makeConfig('claude'),
      'da-vinci:plan': makeConfig('claude'),
      'da-vinci:build': makeConfig('claude'),
      'project-specialist': makeConfig('claude'),
      'project-specialist:plan': makeConfig('claude'),
      'project-specialist:build': makeConfig('claude')
    }
    const result = presetService.validatePreset(config)
    assert.equal(result.valid, true)
  })
})

describe('PresetService.summarize', () => {
  test('zero_configured_actions_with_name_Full_Claude', () => {
    const preset = makePreset('Full Claude', {})
    const summary = presetService.summarize(preset)
    assert.equal(summary, 'All actions use Claude defaults')
  })

  test('zero_configured_actions_with_other_name', () => {
    const preset = makePreset('Custom Preset', {})
    const summary = presetService.summarize(preset)
    assert.equal(summary, 'All actions use default configuration')
  })

  test('one_action_configured_single_provider', () => {
    const preset = makePreset('Partial', {
      'da-vinci': makeConfig('claude')
    })
    const summary = presetService.summarize(preset)
    assert.ok(summary.includes('1/'))
    assert.ok(summary.includes('actions configured'))
    assert.ok(summary.includes('claude'))
  })

  test('multiple_actions_mixed_providers', () => {
    const preset = makePreset('Mixed', {
      'da-vinci': makeConfig('claude'),
      'blueprint:build': makeConfig('local-llm')
    })
    const summary = presetService.summarize(preset)
    assert.ok(summary.includes('2/'))
    assert.ok(summary.includes('actions configured'))
    assert.ok(summary.includes('claude'))
    assert.ok(summary.includes('local-llm'))
  })

  test('all_actions_configured', () => {
    // Configure a few representative actions
    const preset = makePreset('Full', {
      'da-vinci': makeConfig('claude'),
      'da-vinci:plan': makeConfig('claude'),
      'da-vinci:build': makeConfig('claude')
    })
    const summary = presetService.summarize(preset)
    assert.ok(summary.includes('3/'))
    assert.ok(summary.includes('actions configured'))
  })

  test('summary_contains_all_unique_provider_names', () => {
    const preset = makePreset('Multi-Provider', {
      'da-vinci': makeConfig('claude'),
      'blueprint:build': makeConfig('openai'),
      'blueprint:verify': makeConfig('google')
    })
    const summary = presetService.summarize(preset)
    assert.ok(summary.includes('claude'))
    assert.ok(summary.includes('openai'))
    assert.ok(summary.includes('google'))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
