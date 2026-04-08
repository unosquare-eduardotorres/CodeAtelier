import assert from 'node:assert/strict'

import {
  buildSubAgentDefinitions,
  parseDecompositionResult,
  parseHandoffBlock
} from '../generalist-utils'
import {
  DECOMPOSITION_IN_FENCES,
  DECOMPOSITION_MISSING_DEPENDS_ON,
  DECOMPOSITION_NO_IDS,
  EMPTY_DECOMPOSITION,
  HANDOFF_WITH_ACTION_VERB,
  HANDOFF_WITH_BUILD_MODE,
  HANDOFF_WITH_IMPLEMENT_VERB,
  HANDOFF_WITH_REVIEW_VERB,
  INVALID_DECOMPOSITION,
  MALFORMED_HANDOFF_BLOCK,
  MOCK_BRIEF,
  VALID_DECOMPOSITION_JSON,
  VALID_HANDOFF_BLOCK
} from './fixtures/pipeline-fixtures'

let passed = 0
let failed = 0
let skipped = 0

function test(name: string, fn: () => void, options?: { skipReason?: string }) {
  if (options?.skipReason) {
    console.log(`  - ${name} (skipped: ${options.skipReason})`)
    skipped++
    return
  }

  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${(err as Error).message}`)
    failed++
  }
}

function describe(name: string, fn: () => void) {
  console.log(`\n${name}`)
  fn()
}

const simpleBuildConfig = (specialistId: string) => ({
  systemPrompt: `System prompt for ${specialistId}`,
  description: `${specialistId}: Specialist agent`
})

describe('Suite 1: parseHandoffBlock', () => {
  test('parses valid handoff JSON and returns HandoffBrief', () => {
    const result = parseHandoffBlock(VALID_HANDOFF_BLOCK)
    assert.ok(result)
    assert.equal(result.summary, 'Investigate the auth module for token refresh issues')
    assert.deepEqual(result.specialists, ['dotnet-architect'])
    assert.equal(result.mode, 'plan')
  })

  test('respects mode=build from handoff block', () => {
    const result = parseHandoffBlock(HANDOFF_WITH_BUILD_MODE)
    assert.ok(result)
    assert.equal(result.mode, 'build')
  })

  test('rewrites action verb summaries to Investigate', () => {
    const actionResult = parseHandoffBlock(HANDOFF_WITH_ACTION_VERB)
    const implementResult = parseHandoffBlock(HANDOFF_WITH_IMPLEMENT_VERB)
    assert.ok(actionResult)
    assert.ok(implementResult)
    assert.equal(actionResult.summary, 'Investigate the login bug')
    assert.equal(implementResult.summary, 'Investigate the new API')
  })

  test('does not rewrite non-action verbs', () => {
    const result = parseHandoffBlock(HANDOFF_WITH_REVIEW_VERB)
    assert.ok(result)
    assert.equal(result.summary, 'Review the code quality')
  })

  test('does not rewrite action verbs when mode is build', () => {
    // Build mode handoff with an action verb — should preserve the original verb
    const buildHandoff =
      '```handoff\n{\n  "action": "handoff",\n  "summary": "Implement the new API",\n  "specialists": ["api-specialist"],\n  "mode": "build"\n}\n```'
    const result = parseHandoffBlock(buildHandoff)
    assert.ok(result)
    assert.equal(result.mode, 'build')
    assert.equal(result.summary, 'Implement the new API')
  })

  test('handles malformed JSON gracefully — returns null', () => {
    assert.equal(parseHandoffBlock(MALFORMED_HANDOFF_BLOCK), null)
    assert.equal(parseHandoffBlock('no handoff block here'), null)
  })
})

describe('Suite 2: parseDecompositionResult', () => {
  test('parses tasks from clean JSON', () => {
    const plan = parseDecompositionResult(VALID_DECOMPOSITION_JSON, 'conv-1', MOCK_BRIEF, 'plan')
    assert.equal(plan.tasks.length, 2)
    assert.equal(plan.tasks[0].id, 't1')
    assert.equal(plan.tasks[0].specialist, 'dotnet-architect')
  })

  test('extracts JSON from markdown code fences', () => {
    const plan = parseDecompositionResult(DECOMPOSITION_IN_FENCES, 'conv-1', MOCK_BRIEF, 'plan')
    assert.equal(plan.tasks.length, 1)
  })

  test('assigns auto-generated IDs when missing', () => {
    const plan = parseDecompositionResult(DECOMPOSITION_NO_IDS, 'conv-1', MOCK_BRIEF, 'plan')
    assert.equal(plan.tasks[0].id, 't1')
    assert.equal(plan.tasks[1].id, 't2')
  })

  test('defaults dependsOn to empty array', () => {
    const plan = parseDecompositionResult(
      DECOMPOSITION_MISSING_DEPENDS_ON,
      'conv-1',
      MOCK_BRIEF,
      'plan'
    )
    assert.deepEqual(plan.tasks[0].dependsOn, [])
  })

  test('throws on invalid input', () => {
    assert.throws(() =>
      parseDecompositionResult(INVALID_DECOMPOSITION, 'conv-1', MOCK_BRIEF, 'plan')
    )
    assert.throws(() => parseDecompositionResult(EMPTY_DECOMPOSITION, 'conv-1', MOCK_BRIEF, 'plan'))
  })
})

describe('Suite 3: buildSubAgentDefinitions', () => {
  test('creates one agent definition per unique specialist', () => {
    const tasks = [
      { id: 't1', specialist: 'dotnet-architect', description: 'Task 1', dependsOn: [] },
      { id: 't2', specialist: 'qa', description: 'Task 2', dependsOn: [] },
      { id: 't3', specialist: 'dotnet-architect', description: 'Task 3', dependsOn: ['t1'] }
    ]
    const agents = buildSubAgentDefinitions(tasks, 'plan', simpleBuildConfig)
    assert.equal(Object.keys(agents).length, 2)
  })

  test('plan mode uses read-only tools', () => {
    const tasks = [{ id: 't1', specialist: 'qa', description: 'Run checks', dependsOn: [] }]
    const agents = buildSubAgentDefinitions(tasks, 'plan', simpleBuildConfig)
    assert.deepEqual(agents.qa.tools, ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'])
  })

  test('build mode uses full tools', () => {
    const tasks = [{ id: 't1', specialist: 'qa', description: 'Run checks', dependsOn: [] }]
    const agents = buildSubAgentDefinitions(tasks, 'build', simpleBuildConfig)
    assert.ok(agents.qa.tools!.includes('Write'))
    assert.ok(agents.qa.tools!.includes('Edit'))
    assert.ok(agents.qa.tools!.includes('Bash'))
  })

  test('model selection: highest tier wins', () => {
    const tasks = [
      { id: 't1', specialist: 'qa', description: 'Task 1', dependsOn: [], model: 'haiku' as const },
      { id: 't2', specialist: 'qa', description: 'Task 2', dependsOn: [], model: 'opus' as const }
    ]
    const agents = buildSubAgentDefinitions(tasks, 'plan', simpleBuildConfig)
    assert.equal(agents.qa.model, 'opus')
  })
})

describe('Suite 4: Mode enforcement', () => {
  test('plan mode excludes write tools', () => {
    const tasks = [{ id: 't1', specialist: 'qa', description: 'Investigate', dependsOn: [] }]
    const agents = buildSubAgentDefinitions(tasks, 'plan', simpleBuildConfig)
    assert.ok(!agents.qa.tools!.includes('Write'))
    assert.ok(!agents.qa.tools!.includes('Edit'))
    assert.ok(!agents.qa.tools!.includes('Bash'))
  })

  test('build mode includes all tools', () => {
    const tasks = [{ id: 't1', specialist: 'qa', description: 'Implement', dependsOn: [] }]
    const agents = buildSubAgentDefinitions(tasks, 'build', simpleBuildConfig)
    assert.deepEqual(agents.qa.tools, [
      'Read',
      'Write',
      'Edit',
      'Bash',
      'Grep',
      'Glob',
      'WebSearch',
      'WebFetch'
    ])
  })

  test('default model is sonnet when no model specified', () => {
    const tasks = [{ id: 't1', specialist: 'qa', description: 'Task', dependsOn: [] }]
    const agents = buildSubAgentDefinitions(tasks, 'plan', simpleBuildConfig)
    assert.equal(agents.qa.model, 'sonnet')
  })
})

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`)
if (failed > 0) process.exit(1)
