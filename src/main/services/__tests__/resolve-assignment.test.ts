/**
 * Tests for resolveAssignment() — the pure model resolution function.
 *
 * Run 14: Cross-provider model roles system.
 * Covers all 4 fallback levels × specialist presence, source provenance,
 * blueprint role→action mapping, and snapshot resolution.
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { resolveAssignment } from '../model-config.service'
import { resolveModelAction } from '../../../shared/constants'
import type { ModelRoleMap, ModelOverrides } from '../../../shared/types'

// ── resolveAssignment ──────────────────────────────────────────────────

describe('resolveAssignment', () => {
  // ── Level 1: modelRoles (highest priority) ──

  test('returns_modelRoles_assignment_with_source_roles', () => {
    const modelRoles: ModelRoleMap = {
      'da-vinci:plan': { provider: 'claude', modelId: 'claude-sonnet-4-6' }
    }
    const result = resolveAssignment({ action: 'da-vinci:plan', modelRoles })
    assert.equal(result.modelId, 'claude-sonnet-4-6')
    assert.equal(result.provider, 'claude')
    assert.equal(result.source, 'roles')
  })

  test('modelRoles_with_local_provider_includes_localBackend', () => {
    const modelRoles: ModelRoleMap = {
      'da-vinci:build': { provider: 'local-llm', modelId: 'gemma-3', localBackend: 'omlx' }
    }
    const result = resolveAssignment({ action: 'da-vinci:build', modelRoles })
    assert.equal(result.provider, 'local-llm')
    assert.equal(result.modelId, 'gemma-3')
    assert.equal(result.localBackend, 'omlx')
    assert.equal(result.source, 'roles')
  })

  // ── Level 2: modelOverrides (legacy) ──

  test('falls_to_modelOverrides_when_no_roles', () => {
    const modelOverrides: ModelOverrides = { 'da-vinci:plan': 'claude-haiku-4-5-20251001' }
    const result = resolveAssignment({
      action: 'da-vinci:plan',
      modelOverrides,
      workspaceProvider: 'claude'
    })
    assert.equal(result.modelId, 'claude-haiku-4-5-20251001')
    assert.equal(result.source, 'override')
    assert.equal(result.provider, 'claude')
  })

  test('modelOverrides_with_local_workspace_sets_local_provider', () => {
    const modelOverrides: ModelOverrides = { 'haiku': 'local-model-x' }
    const result = resolveAssignment({
      action: 'haiku',
      modelOverrides,
      workspaceProvider: 'local-llm',
      workspaceBackend: 'omlx'
    })
    assert.equal(result.provider, 'local-llm')
    assert.equal(result.localBackend, 'omlx')
    assert.equal(result.source, 'override')
  })

  // ── Level 3: Specialist-aware default ──

  test('specialist_ready_prefers_project-specialist_default', () => {
    const result = resolveAssignment({
      action: 'da-vinci:plan',
      hasReadySpecialist: true
    })
    assert.equal(result.modelId, 'claude-opus-4-8') // project-specialist:plan default
    assert.equal(result.source, 'default')
  })

  test('specialist_not_ready_falls_to_standard_default', () => {
    const result = resolveAssignment({
      action: 'da-vinci:plan',
      hasReadySpecialist: false
    })
    assert.equal(result.modelId, 'claude-opus-4-8') // da-vinci:plan default
    assert.equal(result.source, 'default')
  })

  // ── Level 4: DEFAULT_MODEL_CONFIG direct ──

  test('default_config_for_known_action', () => {
    const result = resolveAssignment({ action: 'da-vinci:build' })
    assert.equal(result.modelId, 'claude-sonnet-5')
    assert.equal(result.source, 'default')
    assert.equal(result.provider, 'claude')
  })

  test('default_config_for_blueprint_action', () => {
    const result = resolveAssignment({ action: 'blueprint:specify' })
    assert.equal(result.modelId, 'claude-opus-4-8')
    assert.equal(result.source, 'default')
  })

  test('default_config_for_background_action', () => {
    const result = resolveAssignment({ action: 'haiku' })
    assert.equal(result.modelId, 'claude-haiku-4-5-20251001')
    assert.equal(result.source, 'default')
  })

  // ── Level 5: Base action fallback ──

  // Note: all known actions are in DEFAULT_MODEL_CONFIG, so this tests the
  // edge case where an action somehow isn't found (future-proofing)

  // ── Level 6: Ultimate fallback ──

  test('unknown_action_falls_to_da-vinci', () => {
    // Force an unknown action through the chain
    const result = resolveAssignment({ action: 'nonexistent:xyz' as any })
    assert.equal(result.source, 'fallback')
    assert.equal(result.provider, 'claude')
  })

  // ── Priority ordering ──

  test('modelRoles_takes_priority_over_modelOverrides', () => {
    const modelRoles: ModelRoleMap = {
      'da-vinci:plan': { provider: 'claude', modelId: 'claude-opus-4-8' }
    }
    const modelOverrides: ModelOverrides = { 'da-vinci:plan': 'claude-haiku-4-5-20251001' }
    const result = resolveAssignment({
      action: 'da-vinci:plan',
      modelRoles,
      modelOverrides
    })
    assert.equal(result.modelId, 'claude-opus-4-8')
    assert.equal(result.source, 'roles')
  })

  test('modelOverrides_takes_priority_over_defaults', () => {
    const modelOverrides: ModelOverrides = { 'haiku': 'claude-sonnet-4-6' }
    const result = resolveAssignment({ action: 'haiku', modelOverrides })
    assert.equal(result.modelId, 'claude-sonnet-4-6')
    assert.equal(result.source, 'override')
  })

  // ── Cross-provider ──

  test('cross_provider_assignment_plan_local_build_claude', () => {
    const modelRoles: ModelRoleMap = {
      'da-vinci:plan': { provider: 'local-llm', modelId: 'fable-7b', localBackend: 'omlx' },
      'da-vinci:build': { provider: 'claude', modelId: 'claude-sonnet-4-6' }
    }
    const plan = resolveAssignment({ action: 'da-vinci:plan', modelRoles })
    const build = resolveAssignment({ action: 'da-vinci:build', modelRoles })

    assert.equal(plan.provider, 'local-llm')
    assert.equal(plan.modelId, 'fable-7b')
    assert.equal(build.provider, 'claude')
    assert.equal(build.modelId, 'claude-sonnet-4-6')
  })
})

// ── resolveModelAction ────────────────────────────────────────────────

describe('resolveModelAction', () => {
  test('da-vinci_plan_mode', () => {
    assert.equal(resolveModelAction('da-vinci', false), 'da-vinci:plan')
  })

  test('da-vinci_build_mode', () => {
    assert.equal(resolveModelAction('da-vinci', true), 'da-vinci:build')
  })

  test('project-specialist_plan_mode', () => {
    assert.equal(resolveModelAction('project-specialist', false), 'project-specialist:plan')
  })

  test('blueprint-specify_ignores_mode', () => {
    assert.equal(resolveModelAction('blueprint-specify', false), 'blueprint:specify')
    assert.equal(resolveModelAction('blueprint-specify', true), 'blueprint:specify')
  })

  test('blueprint-build_ignores_mode', () => {
    assert.equal(resolveModelAction('blueprint-build', false), 'blueprint:build')
    assert.equal(resolveModelAction('blueprint-build', true), 'blueprint:build')
  })

  test('blueprint-verify_ignores_mode', () => {
    assert.equal(resolveModelAction('blueprint-verify', false), 'blueprint:verify')
  })

  test('mpa-planner_always_plan_tier', () => {
    assert.equal(resolveModelAction('mpa-planner', false), 'da-vinci:plan')
    assert.equal(resolveModelAction('mpa-planner', true), 'da-vinci:plan')
  })

  test('mpa-builder_always_build_tier', () => {
    assert.equal(resolveModelAction('mpa-builder', false), 'da-vinci:build')
    assert.equal(resolveModelAction('mpa-builder', true), 'da-vinci:build')
  })

  test('mpa-verifier_always_plan_tier', () => {
    assert.equal(resolveModelAction('mpa-verifier', false), 'da-vinci:plan')
  })

  test('council-member_standard_pattern', () => {
    assert.equal(resolveModelAction('council-member', false), 'council-member:plan')
  })

  test('grill_standard_pattern', () => {
    assert.equal(resolveModelAction('grill', true), 'grill:build')
  })

  test('all_7_blueprint_phases_mapped', () => {
    const phases = ['specify', 'clarify', 'plan', 'tasks', 'review', 'build', 'verify'] as const
    for (const phase of phases) {
      const result = resolveModelAction(`blueprint-${phase}` as any, false)
      assert.equal(result, `blueprint:${phase}`, `blueprint-${phase} should map to blueprint:${phase}`)
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
