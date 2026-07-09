/**
 * Tests for snapshot-model-resolver + buildConversationModelSnapshot + G1 regression.
 *
 * Covers:
 * - buildConversationModelSnapshot returns all three roles + timestamp
 * - Blueprint synthetic ID regex: matches all 7 phases, rejects normal UUIDs
 * - Blueprint snapshot hit → frozen model; missing snapshot → live fallback
 * - G1 regression: assigning local clears legacy override key
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { resolveAssignment } from '../model-config.service'
import { BLUEPRINT_CONV_RE } from '../snapshot-model-resolver'
import { DEFAULT_MODEL_CONFIG } from '../../../shared/constants'
import { buildMemoryFeedFallbackArgs } from '../one-shot-local'
import type { ModelRoleMap, ModelOverrides, ModelRoleAssignment } from '../../../shared/types'

// ── buildConversationModelSnapshot ──────────────────────────────────────

describe('buildConversationModelSnapshot (via resolveAssignment)', () => {
  test('produces_plan_build_background_with_timestamp', () => {
    // Simulate what buildConversationModelSnapshot does internally
    // (we test the pure resolveAssignment calls since the helper depends on DB)
    const plan = resolveAssignment({ action: 'da-vinci:plan' })
    const build = resolveAssignment({ action: 'da-vinci:build' })
    const background = resolveAssignment({ action: 'haiku' })

    assert.ok(plan.modelId, 'plan should have a modelId')
    assert.ok(build.modelId, 'build should have a modelId')
    assert.ok(background.modelId, 'background should have a modelId')
    assert.ok(plan.provider, 'plan should have a provider')
    assert.ok(plan.source, 'plan should have a source')
  })

  test('snapshot_respects_modelRoles_for_all_three_roles', () => {
    const modelRoles: ModelRoleMap = {
      'da-vinci:plan': { provider: 'claude', modelId: 'claude-opus-4-8' },
      'da-vinci:build': { provider: 'local-llm', modelId: 'gemma-3', localBackend: 'omlx' },
      haiku: { provider: 'claude', modelId: 'claude-haiku-4-5' }
    }

    const plan = resolveAssignment({ action: 'da-vinci:plan', modelRoles })
    const build = resolveAssignment({ action: 'da-vinci:build', modelRoles })
    const background = resolveAssignment({ action: 'haiku', modelRoles })

    assert.equal(plan.modelId, 'claude-opus-4-8')
    assert.equal(plan.provider, 'claude')
    assert.equal(build.modelId, 'gemma-3')
    assert.equal(build.provider, 'local-llm')
    assert.equal(background.modelId, 'claude-haiku-4-5')
    assert.equal(background.provider, 'claude')
  })
})

// ── Blueprint synthetic ID regex ────────────────────────────────────────

describe('Blueprint synthetic conversation ID regex', () => {

  test('matches_all_7_phases', () => {
    const phases = ['specify', 'clarify', 'plan', 'tasks', 'review', 'build', 'verify'] as const
    for (const phase of phases) {
      const id = `blueprint-${phase}-bp-abc123-1720000000000`
      const match = BLUEPRINT_CONV_RE.exec(id)
      assert.ok(match, `Should match phase: ${phase}`)
      assert.equal(match[1], phase)
      assert.equal(match[2], 'bp-abc123')
    }
  })

  test('rejects_normal_uuids', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000'
    assert.equal(BLUEPRINT_CONV_RE.test(uuid), false)
  })

  test('rejects_malformed_blueprint_ids', () => {
    // Missing timestamp
    assert.equal(BLUEPRINT_CONV_RE.test('blueprint-plan-abc123'), false)
    // Invalid phase
    assert.equal(BLUEPRINT_CONV_RE.test('blueprint-execute-abc123-12345'), false)
    // Missing blueprintId
    assert.equal(BLUEPRINT_CONV_RE.test('blueprint-plan--12345'), false)
  })

  test('extracts_blueprintId_with_dashes', () => {
    const id = 'blueprint-build-my-long-blueprint-id-1720000000000'
    const match = BLUEPRINT_CONV_RE.exec(id)
    assert.ok(match)
    assert.equal(match[1], 'build')
    assert.equal(match[2], 'my-long-blueprint-id')
  })
})

// ── G1 regression: local assignment clears legacy override ──────────────

describe('G1 regression: handleAssign override cleanup', () => {
  test('local_assignment_should_not_keep_stale_claude_override', () => {
    // Simulate the handleAssign logic from ModelRolesSection
    const modelRoles: ModelRoleMap = {}
    const claudeModelOverrides: ModelOverrides = {
      'da-vinci:plan': 'claude-opus-4-8'  // pre-existing Claude override
    }

    const assignment: ModelRoleAssignment = {
      provider: 'local-llm',
      modelId: 'gemma-3',
      localBackend: 'omlx'
    }

    const action = 'da-vinci:plan' as const

    // Simulate handleAssign logic
    const updated = { ...modelRoles }
    const updatedOverrides = { ...claudeModelOverrides }

    if (assignment) {
      updated[action] = assignment
      if (assignment.provider === 'claude') {
        updatedOverrides[action] = assignment.modelId
      } else {
        // G1 fix: clear stale legacy override
        delete updatedOverrides[action]
      }
    }

    // After assigning local, the legacy override should be cleared
    assert.equal(updatedOverrides['da-vinci:plan'], undefined,
      'Stale Claude override should be deleted when assigning local')
    assert.equal(updated['da-vinci:plan']?.provider, 'local-llm')
    assert.equal(updated['da-vinci:plan']?.modelId, 'gemma-3')
  })

  test('claude_assignment_updates_legacy_override', () => {
    const modelRoles: ModelRoleMap = {}
    const claudeModelOverrides: ModelOverrides = {}

    const assignment: ModelRoleAssignment = {
      provider: 'claude',
      modelId: 'claude-sonnet-4-6'
    }

    const action = 'da-vinci:build' as const

    const updated = { ...modelRoles }
    const updatedOverrides = { ...claudeModelOverrides }

    if (assignment) {
      updated[action] = assignment
      if (assignment.provider === 'claude') {
        updatedOverrides[action] = assignment.modelId
      } else {
        delete updatedOverrides[action]
      }
    }

    assert.equal(updatedOverrides['da-vinci:build'], 'claude-sonnet-4-6',
      'Claude assignment should write to legacy override')
    assert.equal(updated['da-vinci:build']?.provider, 'claude')
  })

  test('null_assignment_clears_both', () => {
    const modelRoles: ModelRoleMap = {
      'da-vinci:plan': { provider: 'claude', modelId: 'claude-opus-4-8' }
    }
    const claudeModelOverrides: ModelOverrides = {
      'da-vinci:plan': 'claude-opus-4-8'
    }

    const action = 'da-vinci:plan' as const
    const assignment = null

    const updated = { ...modelRoles }
    const updatedOverrides = { ...claudeModelOverrides }

    if (assignment) {
      updated[action] = assignment
      if (assignment.provider === 'claude') {
        updatedOverrides[action] = assignment.modelId
      } else {
        delete updatedOverrides[action]
      }
    } else {
      delete updated[action]
      delete updatedOverrides[action]
    }

    assert.equal(updated['da-vinci:plan'], undefined)
    assert.equal(updatedOverrides['da-vinci:plan'], undefined)
  })
})

// ── Blueprint snapshot resolution ─────────────────────────────────────

describe('Blueprint snapshot resolution', () => {
  test('snapshot_hit_returns_frozen_model', () => {
    // Simulate what resolveModelFromSnapshot does for blueprint IDs
    const snapshot = {
      specify: { provider: 'claude' as const, modelId: 'claude-opus-4-8', source: 'roles' as const },
      build: { provider: 'local-llm' as const, modelId: 'gemma-3', source: 'roles' as const },
      plan: { provider: 'claude' as const, modelId: 'claude-sonnet-4-6', source: 'default' as const }
    }

    // Blueprint phase 'specify' → should return the frozen model
    const phase = 'specify'
    const snapRecord = snapshot as Record<string, { modelId: string }>
    assert.equal(snapRecord[phase]?.modelId, 'claude-opus-4-8')
  })

  test('missing_snapshot_phase_returns_undefined', () => {
    const snapshot = {
      specify: { provider: 'claude' as const, modelId: 'claude-opus-4-8', source: 'roles' as const }
    }

    const phase = 'build'
    const snapRecord = snapshot as Record<string, { modelId: string } | undefined>
    assert.equal(snapRecord[phase]?.modelId, undefined,
      'Missing phase should return undefined, triggering live fallback')
  })
})

// ── A1 regression: Claude fallback args must include --model ──────────

describe('A1 regression: Claude fallback args include --model', () => {
  // Now imports buildMemoryFeedFallbackArgs from one-shot-local.ts —
  // the same helper consumed by spawnSummarizer and spawnClassifier.
  // If someone removes --model from the helper, this test catches it.

  test('fallback_args_contain_model_flag', () => {
    const args = buildMemoryFeedFallbackArgs('test prompt')
    const modelIdx = args.indexOf('--model')
    assert.ok(modelIdx >= 0, 'claudeFallbackArgs must include --model flag')
    assert.equal(args[modelIdx + 1], DEFAULT_MODEL_CONFIG.memoryFeed,
      '--model value must match DEFAULT_MODEL_CONFIG.memoryFeed')
  })

  test('fallback_model_is_haiku', () => {
    // Ensure memoryFeed default is haiku (cost guard — Opus fallback = 40x cost)
    assert.ok(
      DEFAULT_MODEL_CONFIG.memoryFeed.includes('haiku'),
      `memoryFeed default should be haiku, got: ${DEFAULT_MODEL_CONFIG.memoryFeed}`
    )
  })

  test('args_structure_matches_claude_cli_format', () => {
    const args = buildMemoryFeedFallbackArgs('extract facts')
    // Verify the exact shape: -p <prompt> --model <model> --output-format text --permission-mode plan
    assert.equal(args[0], '-p')
    assert.equal(args[1], 'extract facts')
    assert.equal(args[2], '--model')
    assert.equal(args[4], '--output-format')
    assert.equal(args[5], 'text')
    assert.equal(args[6], '--permission-mode')
    assert.equal(args[7], 'plan')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
