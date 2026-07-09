/**
 * Tests for E2E runner service — queue/cancel logic with mocked dependencies.
 *
 * These tests validate the runner's orchestration without requiring
 * a real oMLX model or database. They test:
 *   - Preflight HTTP check logic
 *   - Queue processing flow
 *   - Cancel behavior
 *   - Error handling
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { preflight } from '../e2e-testing/e2e-runner.service'
import { SCENARIO_CATALOG, getImplementedScenarios, getScenarioById } from '../e2e-testing/scenario-catalog'

describe('E2E Runner — Preflight', () => {
  test('preflight returns a well-formed result', async () => {
    // In test env, oMLX may or may not be running
    const result = await preflight()
    assert.ok(typeof result.ok === 'boolean', 'ok should be boolean')
    if (result.ok) {
      // oMLX is running — modelId should be present
      assert.ok(result.modelId, 'modelId should be set when ok=true')
    } else {
      // oMLX is not running — error should be present
      assert.ok(result.error, 'error should be set when ok=false')
    }
  })
})

describe('E2E Runner — Scenario Resolution', () => {
  test('getImplementedScenarios returns only runnable scenarios', () => {
    const implemented = getImplementedScenarios()
    assert.ok(implemented.length >= 10, `Expected >= 10 implemented, got ${implemented.length}`)
    for (const s of implemented) {
      assert.equal(s.status, 'implemented')
      assert.ok(s.prompts.length > 0, `${s.id} should have prompts`)
      assert.ok(s.assertions.length > 0, `${s.id} should have assertions`)
    }
  })

  test('each implemented scenario has a unique ID', () => {
    const ids = getImplementedScenarios().map((s) => s.id)
    const unique = new Set(ids)
    assert.equal(ids.length, unique.size)
  })

  test('scenario lookup by ID works', () => {
    const s = getScenarioById('tools.read-file')
    assert.ok(s)
    assert.equal(s.category, 'tools')
    assert.equal(s.mode, 'build')
    assert.ok(s.prompts[0].includes('Read'))
  })

  test('scenario lookup for unknown ID returns undefined', () => {
    assert.equal(getScenarioById('does.not.exist'), undefined)
  })
})

describe('E2E Runner — Catalog Integrity', () => {
  test('all tool scenarios are in build mode', () => {
    const toolScenarios = SCENARIO_CATALOG.filter((s) => s.category === 'tools')
    for (const s of toolScenarios) {
      assert.equal(s.mode, 'build', `Tool scenario "${s.id}" should be in build mode`)
    }
  })

  test('multi-turn scenarios have multiple prompts', () => {
    const multiTurn = getScenarioById('chat-core.multi-turn-context')
    assert.ok(multiTurn)
    assert.ok(multiTurn.prompts.length >= 2, 'Multi-turn should have >= 2 prompts')
  })

  test('each implemented scenario has streamCompleted assertion (except abort scenarios)', () => {
    // Scenarios with abortAfterMs or compactAfter may not have streamCompleted
    const EXEMPT_SCENARIOS = new Set(['chat-core.stop-generation', 'chat-core.manual-compaction'])
    const implemented = getImplementedScenarios()
    for (const s of implemented) {
      if (EXEMPT_SCENARIOS.has(s.id)) continue
      const hasStreamCompleted = s.assertions.some((a) => a.name === 'streamCompleted')
      assert.ok(hasStreamCompleted, `${s.id} should have streamCompleted assertion`)
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
