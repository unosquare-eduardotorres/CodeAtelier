/**
 * Model routing — which backend an assignment records.
 *
 * The defect this pins down: `buildAssignment` hardcoded `localBackend: 'omlx'`.
 * An Ollama user routing Plan to `qwen3:8b` had the assignment written down as
 * oMLX, silently, on every one of the fourteen roles. Nothing in the UI said so;
 * the routing then resolved against a server they weren't running.
 *
 * Run: tsx src/renderer/src/components/workspace/model-config/__tests__/model-roles-assignment.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summary } from '../../../../../../main/services/__tests__/test-harness'
import { MODEL_ROLE_ROWS } from '../../../../../../shared/constants'
import {
  buildAssignment,
  buildModelOptions,
  localBackendLabel,
  type ModelOption
} from '../model-roles-assignment'

const localOption = (id: string): ModelOption => ({
  id,
  label: id,
  provider: 'local-llm',
  group: 'local'
})

describe('buildAssignment — records the active backend', () => {
  test('an Ollama user gets localBackend: ollama, not omlx', () => {
    const assignment = buildAssignment(localOption('qwen3:8b'), 'ollama')
    assert.equal(assignment.localBackend, 'ollama')
  })

  test('an oMLX user gets localBackend: omlx', () => {
    const assignment = buildAssignment(localOption('mlx-community/Qwen3'), 'omlx')
    assert.equal(assignment.localBackend, 'omlx')
  })

  test('provider and modelId are carried through unchanged', () => {
    assert.deepEqual(buildAssignment(localOption('qwen3:8b'), 'ollama'), {
      provider: 'local-llm',
      modelId: 'qwen3:8b',
      localBackend: 'ollama'
    })
  })

  /**
   * A Claude assignment has no local server, so recording one would be noise
   * that later reads could mistake for a real routing decision.
   */
  test('a Claude assignment carries no localBackend at all', () => {
    const assignment = buildAssignment(
      { id: 'claude-opus-5', label: 'Opus 5', provider: 'claude', group: 'claude' },
      'ollama'
    )
    assert.equal('localBackend' in assignment, false)
    assert.deepEqual(assignment, { provider: 'claude', modelId: 'claude-opus-5' })
  })

  /** Every role is built by the same function — so all fourteen are affected. */
  test('the same backend is recorded for every routable role', () => {
    const assignments = MODEL_ROLE_ROWS.flatMap((row) =>
      row.actions.map(() => buildAssignment(localOption('qwen3:8b'), 'ollama'))
    )
    assert.ok(assignments.length >= 14, 'expected the full role catalogue')
    assert.ok(
      assignments.every((a) => a.localBackend === 'ollama'),
      'no role may silently record a different backend'
    )
  })
})

describe('buildModelOptions', () => {
  test('local models are appended to the Claude catalogue, not merged into it', () => {
    const options = buildModelOptions(['qwen3:8b'])
    const local = options.filter((o) => o.group === 'local')
    assert.deepEqual(
      local.map((o) => o.id),
      ['qwen3:8b']
    )
    assert.ok(options.some((o) => o.group === 'claude'))
  })

  test('local options are tagged as the local-llm provider', () => {
    const [local] = buildModelOptions(['qwen3:8b']).filter((o) => o.group === 'local')
    assert.equal(local.provider, 'local-llm')
  })

  test('an unreachable server yields Claude options only', () => {
    assert.equal(
      buildModelOptions([]).some((o) => o.group === 'local'),
      false
    )
  })
})

describe('localBackendLabel', () => {
  test('names the backend the user is actually on', () => {
    assert.equal(localBackendLabel('ollama'), 'Ollama')
    assert.equal(localBackendLabel('omlx'), 'oMLX')
  })
})

describe('MODEL_ROLE_ROWS — shared catalogue', () => {
  test('covers all five groups', () => {
    const groups = new Set(MODEL_ROLE_ROWS.map((r) => r.group))
    assert.deepEqual([...groups].sort(), ['background', 'blueprint', 'chat', 'council', 'quality'])
  })

  /**
   * A row assigning the same action twice writes it twice on every change —
   * harmless today, but it makes the assignment payload a poor witness of what
   * the user actually chose.
   */
  test('no row lists the same action twice', () => {
    for (const row of MODEL_ROLE_ROWS) {
      assert.equal(
        new Set(row.actions).size,
        row.actions.length,
        `${row.group}/${row.label} repeats an action`
      )
    }
  })

  test('every row includes its own primaryAction', () => {
    for (const row of MODEL_ROLE_ROWS) {
      assert.ok(
        row.actions.includes(row.primaryAction),
        `${row.group}/${row.label} displays an action it does not assign`
      )
    }
  })

  /** Two rows owning one action means the second silently overwrites the first. */
  test('no action is owned by two different rows', () => {
    const seen = new Map<string, string>()
    for (const row of MODEL_ROLE_ROWS) {
      for (const action of row.actions) {
        const owner = `${row.group}/${row.label}`
        assert.equal(
          seen.get(action),
          undefined,
          `${action} is claimed by ${seen.get(action)} and ${owner}`
        )
        seen.set(action, owner)
      }
    }
  })
})

if (process.argv[1]?.includes('model-roles-assignment')) {
  summary()
}
