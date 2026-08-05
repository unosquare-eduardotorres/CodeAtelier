/**
 * Unit tests for the Blueprint Clarify ask_user bridge (B1–B4 fixes).
 *
 * Validates:
 *  - CLARIFY_CORRECTION_MESSAGE contains the exact fence names the parsers accept
 *  - grillQuestionsToClarifyBlock() correctly maps GrillQuestion[] → ClarifyQuestionsBlock
 *  - Deduplicate integration with grillQuestionsToClarifyBlock
 *  - PhaseActivityWatchdog pause()/resume() behavior
 */

import assert from 'node:assert/strict'
import { describe, test } from './test-harness'
import {
  parseClarifyFindings,
  parseClarifyQuestions,
  parseClarifyCompletion,
  grillQuestionsToClarifyBlock,
  deduplicateClarifyQuestions
} from '../../../shared/blueprint-clarify-parsers'
import type { GrillQuestion } from '../../../shared/types'
import { ManualClock } from './manual-clock'
import { CLARIFY_CORRECTION_MESSAGE } from '../blueprint-spec.service'
import { PhaseActivityWatchdog } from '../blueprint-phase-watchdog'

// ── B1: CLARIFY_CORRECTION_MESSAGE fence name alignment ──

describe('CLARIFY_CORRECTION_MESSAGE fence names', () => {
  test('contains the findings fence name that parsers expect', () => {
    assert.ok(
      CLARIFY_CORRECTION_MESSAGE.includes('blueprint-clarify-findings'),
      'Missing blueprint-clarify-findings in correction message'
    )
  })

  test('contains the questions fence name that parsers expect', () => {
    assert.ok(
      CLARIFY_CORRECTION_MESSAGE.includes('blueprint-clarify-questions'),
      'Missing blueprint-clarify-questions in correction message'
    )
  })

  test('contains the completion fence name that parsers expect', () => {
    assert.ok(
      CLARIFY_CORRECTION_MESSAGE.includes('blueprint-phase-complete'),
      'Missing blueprint-phase-complete in correction message'
    )
  })

  test('a model-compliant response to the nudge parses successfully', () => {
    // Simulate a model that follows the nudge instructions exactly
    const response = `
Here are my findings and questions:

\`\`\`blueprint-clarify-findings
{
  "findings": [
    {
      "id": "f1",
      "category": "missing_requirements",
      "severity": "high",
      "status": "outstanding",
      "title": "No auth spec",
      "description": "Authentication requirements not specified",
      "specRefs": [],
      "recommendation": "Define auth flow"
    }
  ],
  "summary": "One critical gap found"
}
\`\`\`

\`\`\`blueprint-clarify-questions
{
  "questions": [
    {
      "id": "q1",
      "header": "Authentication",
      "question": "What auth provider should we use?",
      "multiSelect": false,
      "options": [
        { "label": "OAuth2", "recommended": true, "recommendedReason": "Industry standard" },
        { "label": "API Keys", "recommended": false }
      ]
    }
  ]
}
\`\`\`
`
    const findings = parseClarifyFindings(response)
    const questions = parseClarifyQuestions(response)

    assert.ok(findings !== null, 'Findings should parse from compliant response')
    assert.equal(findings!.findings.length, 1)
    assert.equal(findings!.findings[0].id, 'f1')

    assert.ok(questions !== null, 'Questions should parse from compliant response')
    assert.equal(questions!.questions.length, 1)
    assert.equal(questions!.questions[0].id, 'q1')
    assert.equal(questions!.questions[0].options[0].recommended, true)
  })

  test('completion block also parses', () => {
    const response = `
\`\`\`blueprint-phase-complete
{
  "phase": "clarify",
  "status": "complete",
  "questionsAsked": 3,
  "questionsAnswered": 3,
  "coverageSummary": "All gaps resolved"
}
\`\`\`
`
    const completion = parseClarifyCompletion(response)
    assert.ok(completion !== null, 'Completion should parse')
    assert.equal(completion!.questionsAsked, 3)
    assert.equal(completion!.questionsAnswered, 3)
  })
})

// ── B2: grillQuestionsToClarifyBlock ──

describe('grillQuestionsToClarifyBlock', () => {
  test('maps GrillQuestion[] to ClarifyQuestionsBlock', () => {
    const grillQuestions: GrillQuestion[] = [
      {
        id: 'gq1',
        question: 'Which database?',
        header: 'Database Choice',
        multiSelect: false,
        options: [
          { label: 'PostgreSQL', recommended: true, recommendedReason: 'Best for ACID' },
          { label: 'MongoDB', recommended: false }
        ]
      },
      {
        id: 'gq2',
        question: 'Deployment target?',
        header: 'Infrastructure',
        multiSelect: true,
        options: [{ label: 'AWS', recommended: true }, { label: 'GCP' }]
      }
    ]

    const block = grillQuestionsToClarifyBlock(grillQuestions)

    assert.equal(block.questions.length, 2)

    // First question
    assert.equal(block.questions[0].id, 'gq1')
    assert.equal(block.questions[0].header, 'Database Choice')
    assert.equal(block.questions[0].question, 'Which database?')
    assert.equal(block.questions[0].multiSelect, false)
    assert.equal(block.questions[0].options.length, 2)
    assert.equal(block.questions[0].options[0].label, 'PostgreSQL')
    assert.equal(block.questions[0].options[0].recommended, true)
    assert.equal(block.questions[0].options[0].recommendedReason, 'Best for ACID')
    assert.equal(block.questions[0].options[1].recommended, false)

    // Second question
    assert.equal(block.questions[1].id, 'gq2')
    assert.equal(block.questions[1].multiSelect, true)
    assert.equal(block.questions[1].options[0].recommended, true)
    // Options without explicit recommended should default to false
    assert.equal(block.questions[1].options[1].recommended, false)
  })

  test('generates IDs when missing', () => {
    const grillQuestions: GrillQuestion[] = [
      { id: '', question: 'First?', options: [] },
      { id: '', question: 'Second?', options: [] }
    ]

    const block = grillQuestionsToClarifyBlock(grillQuestions)
    assert.equal(block.questions[0].id, 'aq1')
    assert.equal(block.questions[1].id, 'aq2')
  })

  test('handles empty options array', () => {
    const block = grillQuestionsToClarifyBlock([{ id: 'q1', question: 'Free text?', options: [] }])
    assert.equal(block.questions[0].options.length, 0)
  })

  test('deduplication works with bridge output', () => {
    const previouslyAsked = [
      { id: 'q1', header: 'Auth', question: 'Which auth?', multiSelect: false, options: [] }
    ]

    const grillQuestions: GrillQuestion[] = [
      { id: 'q1', question: 'Which auth?', options: [] }, // duplicate
      { id: 'q2', question: 'Which DB?', options: [] } // new
    ]

    const block = grillQuestionsToClarifyBlock(grillQuestions)
    const deduped = deduplicateClarifyQuestions(block.questions, previouslyAsked)

    assert.equal(deduped.length, 1)
    assert.equal(deduped[0].id, 'q2')
  })
})

// ── PhaseActivityWatchdog pause/resume ──

describe('PhaseActivityWatchdog pause/resume', () => {
  test('pause() stops the timer from firing', async () => {
    const clock = new ManualClock()
    const watchdog = new PhaseActivityWatchdog(100, 'TEST', clock)
    let rejected = false

    // Access promise to start timer
    const p = watchdog.promise.catch(() => {
      rejected = true
    })

    // Touch once, then pause
    watchdog.touch()
    watchdog.pause()

    assert.equal(watchdog.paused, true)
    assert.equal(clock.pendingCount, 0, 'pause() should have cleared the timer')

    // Advance well past the threshold — should NOT fire
    clock.advance(1000)
    await Promise.resolve()
    assert.equal(rejected, false, 'Paused watchdog should not reject')
    assert.equal(watchdog.stalled, false)

    // Clean up
    watchdog.dispose()
    await p.catch(() => {}) // suppress any rejection
  })

  test('resume() restarts the timer', async () => {
    const clock = new ManualClock()
    const watchdog = new PhaseActivityWatchdog(80, 'TEST', clock)
    let rejected = false

    const p = watchdog.promise.catch(() => {
      rejected = true
    })

    watchdog.pause()
    assert.equal(watchdog.paused, true)

    // Resume — timer should start counting again
    watchdog.resume()
    assert.equal(watchdog.paused, false)

    // Not yet due at 79ms — proves resume() restarted a full interval
    clock.advance(79)
    await Promise.resolve()
    assert.equal(rejected, false, 'Should not reject before the threshold')

    clock.advance(1)
    await p
    assert.equal(rejected, true, 'Resumed watchdog should reject after timeout')
    assert.equal(watchdog.stalled, true)

    watchdog.dispose()
  })

  test('touch() is no-op while paused', async () => {
    const clock = new ManualClock()
    const watchdog = new PhaseActivityWatchdog(80, 'TEST', clock)
    let rejected = false

    const p = watchdog.promise.catch(() => {
      rejected = true
    })

    watchdog.pause()
    watchdog.touch() // should be no-op
    assert.equal(clock.pendingCount, 0, 'touch() while paused must not arm a timer')

    clock.advance(1000)
    await Promise.resolve()
    assert.equal(rejected, false, 'Touch while paused should not restart timer')

    watchdog.dispose()
    await p.catch(() => {})
  })

  test('pause() is idempotent', () => {
    const clock = new ManualClock()
    const watchdog = new PhaseActivityWatchdog(1000, 'TEST', clock)
    watchdog.promise.catch(() => {})

    watchdog.pause()
    watchdog.pause()
    assert.equal(watchdog.paused, true)

    watchdog.dispose()
  })

  test('resume() without prior pause is no-op', () => {
    const clock = new ManualClock()
    const watchdog = new PhaseActivityWatchdog(1000, 'TEST', clock)
    watchdog.promise.catch(() => {})

    watchdog.resume() // should not throw
    assert.equal(watchdog.paused, false)

    watchdog.dispose()
    assert.equal(clock.pendingCount, 0, 'dispose() should leave no timer behind')
  })
})
