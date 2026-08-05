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
      'specialist:plan': { provider: 'claude', modelId: 'claude-sonnet-4-6' }
    }
    const result = resolveAssignment({ action: 'specialist:plan', modelRoles })
    assert.equal(result.modelId, 'claude-sonnet-4-6')
    assert.equal(result.provider, 'claude')
    assert.equal(result.source, 'roles')
  })

  test('modelRoles_with_local_provider_includes_localBackend', () => {
    const modelRoles: ModelRoleMap = {
      'specialist:build': { provider: 'local-llm', modelId: 'gemma-3', localBackend: 'omlx' }
    }
    const result = resolveAssignment({ action: 'specialist:build', modelRoles })
    assert.equal(result.provider, 'local-llm')
    assert.equal(result.modelId, 'gemma-3')
    assert.equal(result.localBackend, 'omlx')
    assert.equal(result.source, 'roles')
  })

  // ── Level 2: modelOverrides (legacy) ──

  test('falls_to_modelOverrides_when_no_roles', () => {
    const modelOverrides: ModelOverrides = { 'specialist:plan': 'claude-haiku-4-5-20251001' }
    const result = resolveAssignment({
      action: 'specialist:plan',
      modelOverrides,
      workspaceProvider: 'claude'
    })
    assert.equal(result.modelId, 'claude-haiku-4-5-20251001')
    assert.equal(result.source, 'override')
    assert.equal(result.provider, 'claude')
  })

  test('modelOverrides_with_local_workspace_sets_local_provider', () => {
    const modelOverrides: ModelOverrides = { haiku: 'local-model-x' }
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

  test('specialist_plan_default', () => {
    const result = resolveAssignment({
      action: 'specialist:plan'
    })
    assert.equal(result.modelId, 'claude-opus-5') // specialist:plan default
    assert.equal(result.source, 'default')
  })

  test('specialist_plan_default_without_specialist', () => {
    const result = resolveAssignment({
      action: 'specialist:plan'
    })
    assert.equal(result.modelId, 'claude-opus-5') // specialist:plan default
    assert.equal(result.source, 'default')
  })

  // ── Level 4: DEFAULT_MODEL_CONFIG direct ──

  test('default_config_for_known_action', () => {
    const result = resolveAssignment({ action: 'specialist:build' })
    assert.equal(result.modelId, 'claude-opus-5')
    assert.equal(result.source, 'default')
    assert.equal(result.provider, 'claude')
  })

  test('default_config_for_blueprint_action', () => {
    const result = resolveAssignment({ action: 'blueprint:specify' })
    assert.equal(result.modelId, 'claude-opus-5')
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

  test('unknown_action_falls_to_specialist', () => {
    // Force an unknown action through the chain
    const result = resolveAssignment({ action: 'nonexistent:xyz' as any })
    assert.equal(result.source, 'fallback')
    assert.equal(result.provider, 'claude')
  })

  // ── Priority ordering ──

  test('modelRoles_takes_priority_over_modelOverrides', () => {
    const modelRoles: ModelRoleMap = {
      'specialist:plan': { provider: 'claude', modelId: 'claude-opus-5' }
    }
    const modelOverrides: ModelOverrides = { 'specialist:plan': 'claude-haiku-4-5-20251001' }
    const result = resolveAssignment({
      action: 'specialist:plan',
      modelRoles,
      modelOverrides
    })
    assert.equal(result.modelId, 'claude-opus-5')
    assert.equal(result.source, 'roles')
  })

  test('modelOverrides_takes_priority_over_defaults', () => {
    const modelOverrides: ModelOverrides = { haiku: 'claude-sonnet-4-6' }
    const result = resolveAssignment({ action: 'haiku', modelOverrides })
    assert.equal(result.modelId, 'claude-sonnet-4-6')
    assert.equal(result.source, 'override')
  })

  // ── Cross-provider ──

  test('cross_provider_assignment_plan_local_build_claude', () => {
    const modelRoles: ModelRoleMap = {
      'specialist:plan': { provider: 'local-llm', modelId: 'fable-7b', localBackend: 'omlx' },
      'specialist:build': { provider: 'claude', modelId: 'claude-sonnet-4-6' }
    }
    const plan = resolveAssignment({ action: 'specialist:plan', modelRoles })
    const build = resolveAssignment({ action: 'specialist:build', modelRoles })

    assert.equal(plan.provider, 'local-llm')
    assert.equal(plan.modelId, 'fable-7b')
    assert.equal(build.provider, 'claude')
    assert.equal(build.modelId, 'claude-sonnet-4-6')
  })
})

// ── resolveModelAction ────────────────────────────────────────────────

describe('resolveModelAction', () => {
  test('specialist_plan_mode', () => {
    assert.equal(resolveModelAction('specialist', false), 'specialist:plan')
  })

  test('specialist_build_mode', () => {
    assert.equal(resolveModelAction('specialist', true), 'specialist:build')
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
    assert.equal(resolveModelAction('mpa-planner', false), 'specialist:plan')
    assert.equal(resolveModelAction('mpa-planner', true), 'specialist:plan')
  })

  test('mpa-builder_always_build_tier', () => {
    assert.equal(resolveModelAction('mpa-builder', false), 'specialist:build')
    assert.equal(resolveModelAction('mpa-builder', true), 'specialist:build')
  })

  test('mpa-verifier_always_plan_tier', () => {
    assert.equal(resolveModelAction('mpa-verifier', false), 'specialist:plan')
  })

  test('council-member_mode_independent', () => {
    assert.equal(resolveModelAction('council-member', false), 'council-member')
    assert.equal(resolveModelAction('council-member', true), 'council-member')
  })

  test('council-chairman_mode_independent', () => {
    assert.equal(resolveModelAction('council-chairman', false), 'council-chairman')
    assert.equal(resolveModelAction('council-chairman', true), 'council-chairman')
  })

  test('grill_mode_independent', () => {
    assert.equal(resolveModelAction('grill', false), 'grill')
    assert.equal(resolveModelAction('grill', true), 'grill')
  })

  test('audit_mode_independent', () => {
    assert.equal(resolveModelAction('audit', false), 'audit')
    assert.equal(resolveModelAction('audit', true), 'audit')
  })

  test('all_7_blueprint_phases_mapped', () => {
    const phases = ['specify', 'clarify', 'plan', 'tasks', 'review', 'build', 'verify'] as const
    for (const phase of phases) {
      const result = resolveModelAction(`blueprint-${phase}` as any, false)
      assert.equal(
        result,
        `blueprint:${phase}`,
        `blueprint-${phase} should map to blueprint:${phase}`
      )
    }
  })
})

// ── Default config for new ModelActions ───────────────────────────────

describe('resolveAssignment — new ModelAction defaults', () => {
  test('default_config_for_commit_message', () => {
    const result = resolveAssignment({ action: 'commit-message' })
    assert.equal(result.modelId, 'claude-haiku-4-5-20251001')
    assert.equal(result.source, 'default')
  })

  test('default_config_for_condense', () => {
    const result = resolveAssignment({ action: 'condense' })
    assert.equal(result.modelId, 'claude-haiku-4-5-20251001')
    assert.equal(result.source, 'default')
  })

  test('default_config_for_audit', () => {
    const result = resolveAssignment({ action: 'audit' })
    assert.equal(result.modelId, 'claude-opus-5')
    assert.equal(result.source, 'default')
  })

  test('default_config_for_grill', () => {
    const result = resolveAssignment({ action: 'grill' })
    assert.equal(result.modelId, 'claude-opus-5')
    assert.equal(result.source, 'default')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
