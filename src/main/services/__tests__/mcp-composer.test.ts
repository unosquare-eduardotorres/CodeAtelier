/**
 * Unit tests for McpComposerService — precedence rules for assembling
 * Project Specialist MCP configuration.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { mcpComposerService } from '../mcp-composer.service'

describe('McpComposerService', () => {
  test('baseline_always_includes_control_actions_and_code_graph', () => {
    const result = mcpComposerService.compose({
      mode: 'plan',
      detectedTechs: []
    })
    assert.ok(result.enabled.includes('control-actions'))
    assert.ok(result.enabled.includes('code-graph'))
  })

  test('build_mode_adds_task_and_checkpoint_context', () => {
    const result = mcpComposerService.compose({
      mode: 'build',
      detectedTechs: []
    })
    assert.ok(result.enabled.includes('task-context'))
    assert.ok(result.enabled.includes('checkpoint-context'))
  })

  test('plan_mode_excludes_build_only_mcps', () => {
    const result = mcpComposerService.compose({
      mode: 'plan',
      detectedTechs: []
    })
    assert.equal(result.enabled.includes('task-context'), false)
    assert.equal(result.enabled.includes('checkpoint-context'), false)
  })

  test('detected_typescript_adds_semantic_search', () => {
    const result = mcpComposerService.compose({
      mode: 'plan',
      detectedTechs: ['typescript']
    })
    assert.ok(result.enabled.includes('semantic-search'))
  })

  test('semantic_search_unavailable_removes_it_from_enabled', () => {
    const result = mcpComposerService.compose({
      mode: 'plan',
      detectedTechs: ['typescript'],
      semanticSearchAvailable: false
    })
    assert.equal(result.enabled.includes('semantic-search'), false)
  })

  test('user_override_enabled_true_adds_custom_mcp', () => {
    const result = mcpComposerService.compose({
      mode: 'plan',
      detectedTechs: [],
      overrides: { 'github-context': { enabled: true } }
    })
    assert.ok(result.enabled.includes('github-context'))
    assert.equal(result.sources['github-context'], 'override')
  })

  test('user_override_enabled_false_moves_to_disabled_list', () => {
    const result = mcpComposerService.compose({
      mode: 'plan',
      detectedTechs: ['typescript'],
      overrides: { 'code-graph': { enabled: false } }
    })
    assert.equal(result.enabled.includes('code-graph'), false)
    assert.ok(result.disabled.includes('code-graph'))
  })

  test('skill_declared_mcps_take_skill_source', () => {
    const result = mcpComposerService.compose({
      mode: 'plan',
      detectedTechs: [],
      enabledSkillMcps: { 'skill-a': ['git-context'] }
    })
    assert.ok(result.enabled.includes('git-context'))
    assert.equal(result.sources['git-context'], 'skill')
  })

  test('parseConfig_null_returns_null', () => {
    assert.equal(mcpComposerService.parseConfig(null), null)
    assert.equal(mcpComposerService.parseConfig(''), null)
    assert.equal(mcpComposerService.parseConfig('not-json'), null)
  })

  test('parseConfig_round_trips_through_serialize', () => {
    const original = mcpComposerService.compose({
      mode: 'plan',
      detectedTechs: ['typescript']
    })
    const raw = mcpComposerService.serialize(original)
    const parsed = mcpComposerService.parseConfig(raw)
    assert.deepEqual(parsed?.enabled, original.enabled)
  })

  test('parseOverrides_malformed_returns_empty', () => {
    assert.deepEqual(mcpComposerService.parseOverrides(null), {})
    assert.deepEqual(mcpComposerService.parseOverrides(''), {})
    assert.deepEqual(mcpComposerService.parseOverrides('garbage'), {})
  })

  test('parseOverrides_round_trips', () => {
    const overrides = { 'github-context': { enabled: false } }
    const raw = mcpComposerService.serializeOverrides(overrides)
    assert.deepEqual(mcpComposerService.parseOverrides(raw), overrides)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
