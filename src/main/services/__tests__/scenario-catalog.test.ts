/**
 * Tests for E2E scenario catalog — validates structure and consistency.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { SCENARIO_CATALOG, getScenarioById, getImplementedScenarios, getAllCategories, getScenariosByCategory, stepText, stepAttachments, stepModeSwitch, stepAbortAfterMs, stepCompactAfter, stepSetEffort, stepSetTone } from '../e2e-testing/scenario-catalog'

describe('ScenarioCatalog', () => {
  test('all scenario IDs are unique', () => {
    const ids = SCENARIO_CATALOG.map((s) => s.id)
    const unique = new Set(ids)
    assert.equal(ids.length, unique.size, `Duplicate IDs found: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(', ')}`)
  })

  test('all scenarios have valid categories', () => {
    const validCategories = new Set([
      'chat-core', 'commands', 'tools', 'memory', 'planning', 'grill',
      'council', 'blueprints', 'mpa', 'audit', 'code-intel'
    ])
    for (const s of SCENARIO_CATALOG) {
      assert.ok(validCategories.has(s.category), `Invalid category "${s.category}" on scenario "${s.id}"`)
    }
  })

  test('all scenarios have sane timeouts (10s-600s)', () => {
    for (const s of SCENARIO_CATALOG) {
      assert.ok(s.timeoutMs >= 10_000, `Timeout too low for "${s.id}": ${s.timeoutMs}ms`)
      assert.ok(s.timeoutMs <= 600_000, `Timeout too high for "${s.id}": ${s.timeoutMs}ms`)
    }
  })

  test('implemented scenarios have at least one prompt and one assertion', () => {
    const implemented = SCENARIO_CATALOG.filter((s) => s.status === 'implemented')
    assert.ok(implemented.length > 0, 'No implemented scenarios found')

    for (const s of implemented) {
      assert.ok(s.prompts.length > 0, `Implemented scenario "${s.id}" has no prompts`)
      assert.ok(s.assertions.length > 0, `Implemented scenario "${s.id}" has no assertions`)
      // All prompts must have non-empty text
      for (const p of s.prompts) {
        const text = stepText(p)
        assert.ok(text.length > 0, `Implemented scenario "${s.id}" has an empty prompt text`)
      }
    }
  })

  test('planned scenarios have empty prompts and assertions', () => {
    const planned = SCENARIO_CATALOG.filter((s) => s.status === 'planned')
    for (const s of planned) {
      assert.equal(s.prompts.length, 0, `Planned scenario "${s.id}" should have no prompts`)
      assert.equal(s.assertions.length, 0, `Planned scenario "${s.id}" should have no assertions`)
    }
  })

  test('all scenarios have valid mode (plan or build)', () => {
    for (const s of SCENARIO_CATALOG) {
      assert.ok(s.mode === 'plan' || s.mode === 'build', `Invalid mode "${s.mode}" on "${s.id}"`)
    }
  })

  test('getScenarioById returns correct scenario', () => {
    const s = getScenarioById('chat-core.basic-completion')
    assert.ok(s, 'Should find basic-completion scenario')
    assert.equal(s.title, 'Basic Completion')
  })

  test('getScenarioById returns undefined for unknown ID', () => {
    const s = getScenarioById('nonexistent.scenario')
    assert.equal(s, undefined)
  })

  test('getImplementedScenarios returns only implemented', () => {
    const implemented = getImplementedScenarios()
    assert.ok(implemented.length >= 42, `Expected at least 42 implemented, got ${implemented.length}`)
    for (const s of implemented) {
      assert.equal(s.status, 'implemented')
    }
  })

  test('getAllCategories returns all unique categories', () => {
    const categories = getAllCategories()
    assert.ok(categories.length >= 6, `Expected at least 6 categories, got ${categories.length}`)
    assert.ok(categories.includes('chat-core'))
    assert.ok(categories.includes('tools'))
    assert.ok(categories.includes('planning'))
  })

  test('getScenariosByCategory filters correctly', () => {
    const chatScenarios = getScenariosByCategory('chat-core')
    assert.ok(chatScenarios.length > 0)
    for (const s of chatScenarios) {
      assert.equal(s.category, 'chat-core')
    }
  })

  test('scenario IDs follow namespace.name pattern', () => {
    for (const s of SCENARIO_CATALOG) {
      assert.ok(s.id.includes('.'), `Scenario ID "${s.id}" should contain a dot separator`)
    }
  })

  test('catalog has reasonable total count', () => {
    assert.ok(SCENARIO_CATALOG.length >= 70, `Expected at least 70 scenarios, got ${SCENARIO_CATALOG.length}`)
    assert.ok(SCENARIO_CATALOG.length <= 200, `Catalog seems too large: ${SCENARIO_CATALOG.length}`)
  })

  // ── E2EStep helpers ──

  test('stepText extracts text from plain string', () => {
    assert.equal(stepText('hello'), 'hello')
  })

  test('stepText extracts text from rich step', () => {
    assert.equal(stepText({ text: 'hello', attachments: ['a.png'] }), 'hello')
  })

  test('stepAttachments returns empty for plain string', () => {
    assert.deepEqual(stepAttachments('hello'), [])
  })

  test('stepAttachments returns attachments from rich step', () => {
    assert.deepEqual(stepAttachments({ text: 'x', attachments: ['a.png', 'b.png'] }), ['a.png', 'b.png'])
  })

  test('stepModeSwitch returns undefined for plain string', () => {
    assert.equal(stepModeSwitch('hello'), undefined)
  })

  test('stepModeSwitch returns mode from rich step', () => {
    assert.equal(stepModeSwitch({ text: 'x', switchModeTo: 'build' }), 'build')
  })

  test('planning category has at least 4 implemented scenarios', () => {
    const planning = getScenariosByCategory('planning')
    const implemented = planning.filter((s) => s.status === 'implemented')
    assert.ok(implemented.length >= 4, `Expected at least 4 implemented planning scenarios, got ${implemented.length}`)
  })

  test('vision scenario has attachments', () => {
    const vision = getScenarioById('chat-core.vision-image-read')
    assert.ok(vision, 'Vision scenario should exist')
    assert.ok(vision.prompts.length > 0, 'Vision scenario should have prompts')
    const firstStep = vision.prompts[0]
    const attachments = stepAttachments(firstStep)
    assert.ok(attachments.length > 0, 'Vision scenario should have attachments')
    assert.ok(attachments[0].includes('red-square'), 'Vision scenario should attach red-square.png')
  })

  test('mode-switching scenario has switchModeTo directive', () => {
    const scenario = getScenarioById('chat-core.mode-switching')
    assert.ok(scenario, 'Mode switching scenario should exist')
    const hasModeSwitch = scenario.prompts.some((p) => stepModeSwitch(p) != null)
    assert.ok(hasModeSwitch, 'Mode switching scenario should have a step with switchModeTo')
  })

  // ── New step directive helpers ──

  test('stepAbortAfterMs returns undefined for plain string', () => {
    assert.equal(stepAbortAfterMs('hello'), undefined)
  })

  test('stepAbortAfterMs returns value from rich step', () => {
    assert.equal(stepAbortAfterMs({ text: 'x', abortAfterMs: 3000 }), 3000)
  })

  test('stepCompactAfter returns false for plain string', () => {
    assert.equal(stepCompactAfter('hello'), false)
  })

  test('stepCompactAfter returns true from rich step', () => {
    assert.equal(stepCompactAfter({ text: 'x', compactAfter: true }), true)
  })

  test('stepCompactAfter defaults to false when not set', () => {
    assert.equal(stepCompactAfter({ text: 'x' }), false)
  })

  // ── setEffort / setTone step helpers ──

  test('stepSetEffort returns undefined for plain string', () => {
    assert.equal(stepSetEffort('hello'), undefined)
  })

  test('stepSetEffort returns value from rich step', () => {
    assert.equal(stepSetEffort({ text: 'x', setEffort: 'high' }), 'high')
  })

  test('stepSetTone returns undefined for plain string', () => {
    assert.equal(stepSetTone('hello'), undefined)
  })

  test('stepSetTone returns value from rich step', () => {
    assert.equal(stepSetTone({ text: 'x', setTone: 'caveman' }), 'caveman')
  })

  // ── New scenario validations ──

  test('stop-generation scenario has abortAfterMs directive', () => {
    const scenario = getScenarioById('chat-core.stop-generation')
    assert.ok(scenario, 'Stop-generation scenario should exist')
    const hasAbort = scenario.prompts.some((p) => stepAbortAfterMs(p) != null)
    assert.ok(hasAbort, 'Stop-generation scenario should have abortAfterMs')
  })

  test('manual-compaction scenario has compactAfter directive', () => {
    const scenario = getScenarioById('chat-core.manual-compaction')
    assert.ok(scenario, 'Manual-compaction scenario should exist')
    const hasCompact = scenario.prompts.some((p) => stepCompactAfter(p))
    assert.ok(hasCompact, 'Manual-compaction scenario should have compactAfter')
  })

  test('danger-mode scenario has switchModeTo danger', () => {
    const scenario = getScenarioById('chat-core.danger-mode')
    assert.ok(scenario, 'Danger-mode scenario should exist')
    const hasDanger = scenario.prompts.some((p) => stepModeSwitch(p) === 'danger')
    assert.ok(hasDanger, 'Danger-mode scenario should switch to danger mode')
  })

  test('code-graph tool names use snake_case', () => {
    const scenario = getScenarioById('tools.code-graph-tools')
    assert.ok(scenario, 'Code-graph-tools scenario should exist')
    const anyToolAssertion = scenario.assertions.find((a) => a.name.startsWith('anyToolCalled'))
    assert.ok(anyToolAssertion, 'Should have anyToolCalled assertion')
    // The assertion name contains the tool list — verify no CamelCase entries
    assert.ok(!anyToolAssertion.name.includes('FindSymbol'), 'Should not contain CamelCase FindSymbol')
    assert.ok(!anyToolAssertion.name.includes('FileOutline'), 'Should not contain CamelCase FileOutline')
    assert.ok(anyToolAssertion.name.includes('search_identifiers'), 'Should contain snake_case search_identifiers')
    assert.ok(anyToolAssertion.name.includes('file_outline'), 'Should contain snake_case file_outline')
  })

  test('new tool scenarios exist and are implemented', () => {
    const newToolIds = ['tools.git-log', 'tools.git-diff', 'tools.todo-scanner', 'tools.code-analysis', 'tools.checkpoint-list', 'tools.semantic-search', 'tools.git-blame', 'tools.code-graph-deep']
    for (const id of newToolIds) {
      const scenario = getScenarioById(id)
      assert.ok(scenario, `Scenario ${id} should exist`)
      assert.equal(scenario.status, 'implemented', `Scenario ${id} should be implemented`)
      assert.equal(scenario.mode, 'build', `Tool scenario ${id} should be in build mode`)
    }
  })

  // ── Round 3 scenarios ──

  test('effort-high scenario has setEffort directive', () => {
    const scenario = getScenarioById('chat-core.effort-high')
    assert.ok(scenario, 'Effort-high scenario should exist')
    assert.equal(scenario.status, 'implemented')
    const hasEffort = scenario.prompts.some((p) => stepSetEffort(p) === 'high')
    assert.ok(hasEffort, 'Should have setEffort: high')
  })

  test('tone-caveman scenario has setTone directive', () => {
    const scenario = getScenarioById('chat-core.tone-caveman')
    assert.ok(scenario, 'Tone-caveman scenario should exist')
    assert.equal(scenario.status, 'implemented')
    const hasTone = scenario.prompts.some((p) => stepSetTone(p) === 'caveman')
    assert.ok(hasTone, 'Should have setTone: caveman')
  })

  test('commands.audit scenario exists and is implemented', () => {
    const scenario = getScenarioById('commands.audit')
    assert.ok(scenario, 'Audit scenario should exist')
    assert.equal(scenario.status, 'implemented')
    assert.equal(scenario.mode, 'build')
  })

  test('planned untestable entries exist', () => {
    const plannedIds = ['chat-core.mcp-override-local', 'chat-core.resume-at', 'tools.eslint-check', 'tools.dependency-health', 'tools.codebase-concepts']
    for (const id of plannedIds) {
      const scenario = getScenarioById(id)
      assert.ok(scenario, `Planned scenario ${id} should exist`)
      assert.equal(scenario.status, 'planned', `${id} should be planned`)
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
