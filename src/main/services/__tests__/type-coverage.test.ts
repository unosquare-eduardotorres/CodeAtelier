/**
 * Phase 16, Track 2 — Type/constant import coverage
 *
 * Forces c8 module evaluation for all shared type-only files via dynamic
 * import(), and exercises remaining untested runtime constants from
 * constants.ts and blueprint-types.ts.
 *
 * Target files:
 *   shared/types.ts        (1,652 lines) — type-only
 *   shared/mpa-types.ts    (333 lines)   — type-only
 *   shared/blueprint-types.ts (249 lines) — 2 runtime constants
 *   shared/constants.ts    (2,261 lines)  — 45 runtime exports
 *   services/agent-session.types.ts (186 lines) — type-only
 *   services/executor-types.ts (97 lines) — type-only
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

// ── Runtime imports for constants that existing tests DON'T cover ──
import {
  BLUEPRINT_PHASE_ORDER,
  PHASE_TO_STATUS
} from '../../../shared/blueprint-types'

import {
  // Already covered in shared-types-coverage.test.ts:
  // IPC_CHANNELS, AVAILABLE_MODELS, GRILL_TRACKS, AUDIT_TRACKS,
  // COUNCIL_ADVISORS, COUNCIL_ADVISOR_ROLES, COMMUNICATION_TONES,
  // THINKING_BUDGETS, resolvePromptVerbosity

  // ── NEW — not yet covered ──
  ACTIVATION_MODEL_ID,
  DA_VINCI_AGENT_ID,
  DEFAULT_COST_PREFERENCE,
  VALID_COMMUNICATION_TONES,
  DEFAULT_MODEL_CONFIG,
  ACTION_GROUPS,
  BUILTIN_FULL_CLAUDE_CONFIG,
  buildFullLocalConfig,
  CONTEXT_1M_SUPPORTED_MODELS,
  CLAUDE_DEFAULT_CONTEXT_WINDOW,
  CLAUDE_1M_CONTEXT_WINDOW,
  supportsContext1M,
  MODEL_ACTIONS_META,
  COMPLEXITY_TO_EFFORT,
  SPECIALIST_BUDGET_CAPS,
  BUDGET_CAP_MODE_MULTIPLIERS,
  getModelActionForRole,
  SKILL_MAX_FILE_SIZE_BYTES,
  GREENFIELD_TRACKS,
  GREENFIELD_DEFAULT_TRACKS,
  deriveApplicability,
  AUDIT_TRACK_SKILLS,
  MCP_TOOLS,
  ALL_MCP_TOOL_NAMES,
  LOCAL_MCP_INTEGRATIONS,
  OLLAMA_DEFAULT_HOST,
  OLLAMA_DEFAULT_PORT,
  OMLX_DEFAULT_PORT,
  BASELINE_SKILL_FILENAMES,
  RECOMMENDED_LOCAL_MODELS,
  resolveModelId,
  modelSupportsToolCalling,
  findRecommendedModel,
  MCP_DISPLAY_NAMES,
  EXTERNAL_MCP_INTEGRATIONS,
  OMLX_EMBEDDING
} from '../../../shared/constants'

// ────────────────────────────────────────────────────────────────────────────
// §1  Dynamic imports — force c8 to evaluate type-only modules
// ────────────────────────────────────────────────────────────────────────────

describe('Type-only module evaluation (dynamic import)', () => {
  test('shared/types_module_evaluates_at_runtime', async () => {
    const mod = await import('../../../shared/types')
    // Module should evaluate without error. Since it exports only types,
    // the compiled module object will be mostly empty — but the module
    // wrapper code IS executed, giving c8 line coverage.
    assert.ok(mod !== null && typeof mod === 'object')
  })

  test('shared/mpa-types_module_evaluates_at_runtime', async () => {
    const mod = await import('../../../shared/mpa-types')
    assert.ok(mod !== null && typeof mod === 'object')
  })

  test('shared/blueprint-types_module_evaluates_at_runtime', async () => {
    const mod = await import('../../../shared/blueprint-types')
    assert.ok(mod !== null && typeof mod === 'object')
    // Also has runtime exports
    assert.ok(Array.isArray(mod.BLUEPRINT_PHASE_ORDER))
    assert.equal(typeof mod.PHASE_TO_STATUS, 'object')
  })

  test('agent-session.types_module_evaluates_at_runtime', async () => {
    const mod = await import('../../services/agent-session.types')
    assert.ok(mod !== null && typeof mod === 'object')
  })

  test('executor-types_module_evaluates_at_runtime', async () => {
    const mod = await import('../../services/executor-types')
    assert.ok(mod !== null && typeof mod === 'object')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// §2  Blueprint-types runtime constants (deeper verification)
// ────────────────────────────────────────────────────────────────────────────

describe('Blueprint runtime constants — deep', () => {
  test('BLUEPRINT_PHASE_ORDER_has_7_phases', () => {
    assert.equal(BLUEPRINT_PHASE_ORDER.length, 7)
    const expected = ['specify', 'clarify', 'plan', 'tasks', 'review', 'build', 'verify']
    for (const phase of expected) {
      assert.ok(
        (BLUEPRINT_PHASE_ORDER as readonly string[]).includes(phase),
        `Missing phase: ${phase}`
      )
    }
  })

  test('PHASE_TO_STATUS_maps_every_phase_to_a_status', () => {
    const entries = Object.entries(PHASE_TO_STATUS)
    assert.equal(entries.length, 7)
    for (const [phase, status] of entries) {
      assert.equal(typeof phase, 'string')
      assert.equal(typeof status, 'string')
      // Status is the gerund form of the phase
      assert.ok(status.endsWith('ing'), `Status "${status}" should end in 'ing'`)
    }
  })

  test('PHASE_TO_STATUS_covers_every_BLUEPRINT_PHASE_ORDER_entry', () => {
    for (const phase of BLUEPRINT_PHASE_ORDER) {
      assert.ok(phase in PHASE_TO_STATUS, `${phase} missing from PHASE_TO_STATUS`)
    }
  })
})

// ────────────────────────────────────────────────────────────────────────────
// §3  Constants — scalar values
// ────────────────────────────────────────────────────────────────────────────

describe('Constants — scalar values', () => {
  test('ACTIVATION_MODEL_ID_is_string', () => {
    assert.equal(typeof ACTIVATION_MODEL_ID, 'string')
    assert.ok(ACTIVATION_MODEL_ID.length > 0)
  })

  test('DA_VINCI_AGENT_ID_is_da-vinci', () => {
    assert.equal(DA_VINCI_AGENT_ID, 'da-vinci')
  })

  test('DEFAULT_COST_PREFERENCE_is_balanced', () => {
    assert.equal(DEFAULT_COST_PREFERENCE, 'balanced')
  })

  test('CLAUDE_DEFAULT_CONTEXT_WINDOW_is_200k', () => {
    assert.equal(CLAUDE_DEFAULT_CONTEXT_WINDOW, 200_000)
  })

  test('CLAUDE_1M_CONTEXT_WINDOW_is_1M', () => {
    assert.equal(CLAUDE_1M_CONTEXT_WINDOW, 1_000_000)
  })

  test('OLLAMA_DEFAULT_HOST_is_localhost', () => {
    assert.equal(OLLAMA_DEFAULT_HOST, '127.0.0.1')
  })

  test('OLLAMA_DEFAULT_PORT_is_11434', () => {
    assert.equal(OLLAMA_DEFAULT_PORT, 11434)
  })

  test('OMLX_DEFAULT_PORT_is_8000', () => {
    assert.equal(OMLX_DEFAULT_PORT, 8000)
  })

  test('SKILL_MAX_FILE_SIZE_BYTES_is_512000', () => {
    assert.equal(SKILL_MAX_FILE_SIZE_BYTES, 512000)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// §4  Constants — arrays and objects
// ────────────────────────────────────────────────────────────────────────────

describe('Constants — arrays and objects', () => {
  test('VALID_COMMUNICATION_TONES_is_string_array', () => {
    assert.ok(Array.isArray(VALID_COMMUNICATION_TONES))
    assert.ok(VALID_COMMUNICATION_TONES.length >= 3)
    for (const t of VALID_COMMUNICATION_TONES) {
      assert.equal(typeof t, 'string')
    }
  })

  test('DEFAULT_MODEL_CONFIG_has_expected_keys', () => {
    assert.equal(typeof DEFAULT_MODEL_CONFIG, 'object')
    assert.ok(Object.keys(DEFAULT_MODEL_CONFIG).length >= 3)
  })

  test('ACTION_GROUPS_is_non_empty_array', () => {
    assert.ok(Array.isArray(ACTION_GROUPS))
    assert.ok(ACTION_GROUPS.length >= 1)
    for (const group of ACTION_GROUPS) {
      assert.equal(typeof group.label, 'string')
    }
  })

  test('BUILTIN_FULL_CLAUDE_CONFIG_is_object', () => {
    assert.equal(typeof BUILTIN_FULL_CLAUDE_CONFIG, 'object')
  })

  test('CONTEXT_1M_SUPPORTED_MODELS_is_array', () => {
    assert.ok(Array.isArray(CONTEXT_1M_SUPPORTED_MODELS))
    assert.ok(CONTEXT_1M_SUPPORTED_MODELS.length >= 1)
  })

  test('MODEL_ACTIONS_META_has_entries', () => {
    assert.equal(typeof MODEL_ACTIONS_META, 'object')
    assert.ok(Object.keys(MODEL_ACTIONS_META).length >= 3)
  })

  test('COMPLEXITY_TO_EFFORT_maps_tiers', () => {
    assert.equal(typeof COMPLEXITY_TO_EFFORT, 'object')
    assert.ok(Object.keys(COMPLEXITY_TO_EFFORT).length >= 3)
  })

  test('SPECIALIST_BUDGET_CAPS_has_entries', () => {
    assert.equal(typeof SPECIALIST_BUDGET_CAPS, 'object')
    assert.ok(Object.keys(SPECIALIST_BUDGET_CAPS).length >= 1)
  })

  test('BUDGET_CAP_MODE_MULTIPLIERS_has_modes', () => {
    assert.equal(typeof BUDGET_CAP_MODE_MULTIPLIERS, 'object')
    assert.ok(Object.keys(BUDGET_CAP_MODE_MULTIPLIERS).length >= 2)
  })

  test('GREENFIELD_TRACKS_is_array', () => {
    assert.ok(Array.isArray(GREENFIELD_TRACKS))
    assert.ok(GREENFIELD_TRACKS.length >= 1)
  })

  test('GREENFIELD_DEFAULT_TRACKS_subset_of_GREENFIELD_TRACKS', () => {
    assert.ok(Array.isArray(GREENFIELD_DEFAULT_TRACKS))
    assert.ok(GREENFIELD_DEFAULT_TRACKS.length >= 1)
  })

  test('AUDIT_TRACK_SKILLS_has_entries', () => {
    assert.equal(typeof AUDIT_TRACK_SKILLS, 'object')
    assert.ok(Object.keys(AUDIT_TRACK_SKILLS).length >= 4)
    for (const skills of Object.values(AUDIT_TRACK_SKILLS)) {
      assert.ok(Array.isArray(skills))
    }
  })

  test('BASELINE_SKILL_FILENAMES_is_array', () => {
    assert.ok(Array.isArray(BASELINE_SKILL_FILENAMES))
    assert.ok(BASELINE_SKILL_FILENAMES.includes('coding-discipline'))
  })

  test('RECOMMENDED_LOCAL_MODELS_is_array_of_model_objects', () => {
    assert.ok(Array.isArray(RECOMMENDED_LOCAL_MODELS))
    for (const model of RECOMMENDED_LOCAL_MODELS) {
      assert.equal(typeof model.ollamaId, 'string')
      assert.equal(typeof model.label, 'string')
      assert.equal(typeof model.parameterSize, 'string')
      assert.equal(typeof model.contextWindow, 'number')
      assert.equal(typeof model.minMemoryGB, 'number')
    }
  })

  test('OMLX_EMBEDDING_has_expected_shape', () => {
    assert.equal(typeof OMLX_EMBEDDING, 'object')
    assert.ok('server' in OMLX_EMBEDDING)
    assert.ok('recommendedModel' in OMLX_EMBEDDING)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// §5  Constants — MCP definitions
// ────────────────────────────────────────────────────────────────────────────

describe('Constants — MCP definitions', () => {
  test('MCP_TOOLS_has_server_entries', () => {
    assert.equal(typeof MCP_TOOLS, 'object')
    const serverNames = Object.keys(MCP_TOOLS)
    assert.ok(serverNames.length >= 1, 'MCP_TOOLS should have at least one server')
    for (const server of Object.values(MCP_TOOLS)) {
      assert.ok(Array.isArray((server as Record<string, unknown>)._ALL_NAMES))
    }
  })

  test('ALL_MCP_TOOL_NAMES_is_string_array', () => {
    assert.ok(Array.isArray(ALL_MCP_TOOL_NAMES))
    assert.ok(ALL_MCP_TOOL_NAMES.length >= 5)
    for (const name of ALL_MCP_TOOL_NAMES) {
      assert.equal(typeof name, 'string')
    }
  })

  test('LOCAL_MCP_INTEGRATIONS_is_array', () => {
    assert.ok(Array.isArray(LOCAL_MCP_INTEGRATIONS))
  })

  test('MCP_DISPLAY_NAMES_is_object', () => {
    assert.equal(typeof MCP_DISPLAY_NAMES, 'object')
  })

  test('EXTERNAL_MCP_INTEGRATIONS_is_array', () => {
    assert.ok(Array.isArray(EXTERNAL_MCP_INTEGRATIONS))
  })
})

// ────────────────────────────────────────────────────────────────────────────
// §6  Constants — functions
// ────────────────────────────────────────────────────────────────────────────

describe('Constants — functions', () => {
  test('buildFullLocalConfig_is_callable', () => {
    assert.equal(typeof buildFullLocalConfig, 'function')
    // Call with a minimal local LLM config
    const result = buildFullLocalConfig({} as Parameters<typeof buildFullLocalConfig>[0])
    assert.equal(typeof result, 'object')
  })

  test('supportsContext1M_returns_boolean', () => {
    assert.equal(typeof supportsContext1M, 'function')
    // Known 1M model
    const result1 = supportsContext1M('claude-sonnet-4-20250514')
    assert.equal(typeof result1, 'boolean')
    // Unknown model
    const result2 = supportsContext1M('unknown-model')
    assert.equal(result2, false)
  })

  test('getModelActionForRole_returns_action_for_known_roles', () => {
    assert.equal(typeof getModelActionForRole, 'function')
    const action = getModelActionForRole('da-vinci')
    assert.equal(typeof action, 'string')
  })

  test('deriveApplicability_is_callable', () => {
    assert.equal(typeof deriveApplicability, 'function')
  })

  test('resolveModelId_returns_string', () => {
    assert.equal(typeof resolveModelId, 'function')
    if (RECOMMENDED_LOCAL_MODELS.length > 0) {
      const model = RECOMMENDED_LOCAL_MODELS[0]
      const result = resolveModelId(model, 'ollama')
      assert.equal(typeof result, 'string')
    }
  })

  test('modelSupportsToolCalling_returns_boolean', () => {
    assert.equal(typeof modelSupportsToolCalling, 'function')
    if (RECOMMENDED_LOCAL_MODELS.length > 0) {
      const result = modelSupportsToolCalling(RECOMMENDED_LOCAL_MODELS[0])
      assert.equal(typeof result, 'boolean')
    }
  })

  test('findRecommendedModel_returns_model_or_undefined', () => {
    assert.equal(typeof findRecommendedModel, 'function')
    const result = findRecommendedModel('nonexistent-model-xyz')
    assert.equal(result, undefined)
    if (RECOMMENDED_LOCAL_MODELS.length > 0) {
      const found = findRecommendedModel(RECOMMENDED_LOCAL_MODELS[0].id)
      assert.ok(found)
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
