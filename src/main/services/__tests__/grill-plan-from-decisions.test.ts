/**
 * Unit tests for GrillPlanGeneratorService.generateFromDecisions — the
 * session-less plan synthesis used by the greenfield Create Project wizard.
 *
 * The CLI call (callClaude) and model resolution (modelConfigService) are
 * monkeypatched so the test exercises real prompt-building + parse logic with
 * no DB / network / `claude` binary dependency.
 *
 * Coverage:
 *  - Returns a valid GrillStructuredPlan parsed from the model response.
 *  - The synthesized prompt includes project name, description, decisions, scores.
 *  - originalDescription falls back to the description when omitted by the model.
 *  - Throws when the response contains no grill-plan block.
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { grillPlanGeneratorService } from '../grill-plan-generator.service'
import { modelConfigService } from '../model-config.service'
import type { GrillDecision, GrillTrackScore } from '../../../shared/types'

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build a fenced grill-plan response, optionally omitting originalDescription. */
function makeResponse(opts: { originalDescription?: string } = {}): string {
  const plan = {
    version: 1,
    title: 'Accessible Quiz Site',
    summary: 'A bundled-JSON quiz web app meeting WCAG 2.2 AA.',
    goalType: 'feature',
    decisions: [],
    items: [
      {
        id: 'item-1',
        title: 'Scaffold quiz page',
        description: 'Build the static quiz UI',
        scope: 'frontend',
        files: ['index.html'],
        dependsOn: [],
        includesTests: false
      }
    ],
    risks: ['Keyboard nav gaps'],
    constraints: ['WCAG 2.2 AA'],
    ...(opts.originalDescription !== undefined
      ? { originalDescription: opts.originalDescription }
      : {}),
    requirementDocument: '# Accessible Quiz Site\n\nFull spec here.'
  }
  return `Sure, here is the plan:\n\n\`\`\`grill-plan\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n\nDone.`
}

const DECISIONS: GrillDecision[] = [
  {
    trackId: 'architecture',
    questionId: 'q1',
    questionText: 'Question Data Source',
    selectedOption: 'Bundled static JSON'
  },
  {
    trackId: 'ux-ui',
    questionId: 'q2',
    questionText: 'Accessibility Baseline',
    selectedOption: 'Other',
    otherText: 'WCAG 2.2 AA'
  }
]

const SCORES: GrillTrackScore[] = [
  {
    trackId: 'architecture',
    score: 8,
    scoreLabel: 'Strong',
    iterationCount: 1,
    lastFeedback: ''
  }
]

/** Run generateFromDecisions with callClaude + model resolution stubbed.
 *  Returns the captured prompt alongside the result/error. */
async function runWithStub(
  response: string | (() => never),
  params?: Partial<Parameters<typeof grillPlanGeneratorService.generateFromDecisions>[0]>
): Promise<{ prompt: string; result?: unknown; error?: Error }> {
  const svc = grillPlanGeneratorService as any
  const origCall = svc.callClaude
  const origModel = modelConfigService.getModelById
  let capturedPrompt = ''

  svc.callClaude = async (prompt: string): Promise<string> => {
    capturedPrompt = prompt
    if (typeof response === 'function') return response()
    return response
  }
  ;(modelConfigService as any).getModelById = (): string => 'claude-sonnet-4-6'

  try {
    const result = await grillPlanGeneratorService.generateFromDecisions({
      projectName: 'Quiz App',
      description: 'A small accessible quiz website',
      grillDecisions: DECISIONS,
      trackScores: SCORES,
      workspaceId: 'ws-test',
      ...params
    })
    return { prompt: capturedPrompt, result }
  } catch (err) {
    return { prompt: capturedPrompt, error: err as Error }
  } finally {
    svc.callClaude = origCall
    ;(modelConfigService as any).getModelById = origModel
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('GrillPlanGeneratorService.generateFromDecisions', () => {
  test('returns a valid GrillStructuredPlan parsed from the response', async () => {
    const { result } = await runWithStub(makeResponse())
    const plan = result as import('../../../shared/types').GrillStructuredPlan
    assert.ok(plan)
    assert.equal(plan.version, 1)
    assert.equal(plan.title, 'Accessible Quiz Site')
    assert.equal(plan.items.length, 1)
    assert.equal(plan.items[0].scope, 'frontend')
    assert.ok(plan.requirementDocument.includes('Accessible Quiz Site'))
  })

  test('synthesized prompt includes project name, description, decisions, and scores', async () => {
    const { prompt } = await runWithStub(makeResponse())
    assert.ok(prompt.includes('Quiz App'), 'prompt should include project name')
    assert.ok(
      prompt.includes('A small accessible quiz website'),
      'prompt should include description'
    )
    assert.ok(prompt.includes('Question Data Source'), 'prompt should include decision question')
    assert.ok(prompt.includes('Bundled static JSON'), 'prompt should include decision answer')
    // otherText is appended in parentheses
    assert.ok(prompt.includes('WCAG 2.2 AA'), 'prompt should include otherText')
    assert.ok(prompt.includes('8/10'), 'prompt should include track score')
  })

  test('originalDescription falls back to the description when omitted', async () => {
    const { result } = await runWithStub(makeResponse({ originalDescription: '' }))
    const plan = result as import('../../../shared/types').GrillStructuredPlan
    assert.equal(plan.originalDescription, 'A small accessible quiz website')
  })

  test('throws when the response contains no grill-plan block', async () => {
    const { error } = await runWithStub('No plan block here, sorry.')
    assert.ok(error, 'should throw')
    assert.match(error!.message, /Failed to parse structured plan/)
  })

  test('omits the Track Scores section when no scores are provided', async () => {
    const { prompt } = await runWithStub(makeResponse(), { trackScores: undefined })
    assert.ok(!prompt.includes('## Track Scores'), 'should not emit Track Scores section')
  })
})

// Only exit the process when run standalone (not via the aggregate runner).
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
