/**
 * Unit tests for GoalDecomposerService.decompose — turning a plan / typed
 * description into measurable goals for a campaign.
 *
 * The CLI call (callClaude) and model resolution (modelConfigService) are
 * monkeypatched so the test exercises real parse / validate / phase-derivation
 * logic with no DB / network / `claude` binary dependency.
 *
 * Coverage:
 *  - Parses the goals block, derives phases from goalType.
 *  - Falls back goalType to classifyGoal when the LLM emits an invalid type.
 *  - Drops goals missing title/outcome; filters empty success criteria.
 *  - Scales down to a single fallback goal when no block is present.
 *  - The prompt includes the input text.
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { goalDecomposerService } from '../goal-decomposer.service'
import { modelConfigService } from '../model-config.service'
import type { GoalDecomposeResult } from '../../../shared/mpa-types'

/** Build a fenced ```goals``` response from raw goal objects. */
function makeResponse(goals: unknown[]): string {
  return `Here are the goals:\n\n\`\`\`goals\n${JSON.stringify({ goals }, null, 2)}\n\`\`\`\nDone.`
}

/** Run decompose with callClaude + model resolution stubbed. Captures the prompt. */
async function runWithStub(
  response: string,
  input = 'Build a small accessible quiz website with bundled JSON questions and a results screen'
): Promise<{ prompt: string; result: GoalDecomposeResult }> {
  const svc = goalDecomposerService as any
  const origCall = svc.callClaude
  const origModel = modelConfigService.getModelById
  let capturedPrompt = ''

  svc.callClaude = async (prompt: string): Promise<string> => {
    capturedPrompt = prompt
    return response
  }
  ;(modelConfigService as any).getModelById = (): string => 'claude-opus-4-8'

  try {
    const result = await goalDecomposerService.decompose({ workspaceId: 'ws-test', input })
    return { prompt: capturedPrompt, result }
  } finally {
    svc.callClaude = origCall
    ;(modelConfigService as any).getModelById = origModel
  }
}

describe('GoalDecomposerService.decompose', () => {
  test('parses goals and derives phases from goalType', async () => {
    const { result } = await runWithStub(
      makeResponse([
        {
          title: 'Scaffold quiz UI',
          outcome: 'Static quiz page renders questions from bundled JSON',
          successCriteria: ['Questions render', 'Keyboard navigable'],
          goalType: 'feature'
        },
        {
          title: 'Add unit tests for scoring',
          outcome: 'Scoring logic is covered by unit tests',
          successCriteria: ['Covers empty input', 'Covers all-correct'],
          goalType: 'tests'
        }
      ])
    )
    assert.equal(result.goals.length, 2)
    // feature → plan/execute/verify
    assert.deepEqual(result.goals[0].phases, ['plan', 'execute', 'verify'])
    // tests → plan/execute (no verify)
    assert.deepEqual(result.goals[1].phases, ['plan', 'execute'])
    assert.ok(result.goals[0].id, 'goal should be assigned an id')
    assert.equal(result.goals[0].successCriteria.length, 2)
  })

  test('falls back goalType via classifyGoal when LLM type is invalid', async () => {
    const { result } = await runWithStub(
      makeResponse([
        {
          title: 'Refactor the payment module into a repository pattern',
          outcome: 'Payment access goes through a repository abstraction',
          successCriteria: ['No direct DB calls in handlers'],
          goalType: 'totally-bogus'
        }
      ])
    )
    assert.equal(result.goals.length, 1)
    // "refactor" keyword → classifyGoal returns 'refactor'
    assert.equal(result.goals[0].goalType, 'refactor')
  })

  test('drops goals missing title/outcome and filters empty criteria', async () => {
    const { result } = await runWithStub(
      makeResponse([
        { title: '', outcome: 'no title', successCriteria: [] },
        {
          title: 'Valid goal',
          outcome: 'Has both fields',
          successCriteria: ['ok', '', '   ', 'also ok'],
          goalType: 'feature'
        }
      ])
    )
    assert.equal(result.goals.length, 1)
    assert.equal(result.goals[0].title, 'Valid goal')
    assert.deepEqual(result.goals[0].successCriteria, ['ok', 'also ok'])
  })

  test('scales down to a single fallback goal when no block is present', async () => {
    const { result } = await runWithStub('Sorry, no JSON here.')
    assert.equal(result.goals.length, 1)
    assert.ok(result.goals[0].title.length > 0)
    assert.ok(result.goals[0].phases.length > 0)
  })

  test('prompt includes the input text', async () => {
    const { prompt } = await runWithStub(
      makeResponse([
        {
          title: 'X',
          outcome: 'Y',
          successCriteria: [],
          goalType: 'feature'
        }
      ]),
      'A very specific feature request about CSV export'
    )
    assert.ok(prompt.includes('A very specific feature request about CSV export'))
  })
})

// Only exit the process when run standalone (not via the aggregate runner).
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
