/**
 * Tests for src/shared/blueprint-clarify-parsers.ts
 * Verifies: valid/malformed/truncated blocks, coercion, strip function.
 */

import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import {
  parseClarifyFindings,
  parseClarifyQuestions,
  parseClarifyCompletion,
  stripBlueprintBlocks,
  clarifyQuestionToGrillQuestion,
  formatClarifyAnswerMessage,
  deduplicateClarifyQuestions,
  normalizeFenceRuns
} from '../../../shared/blueprint-clarify-parsers'
import type {
  ClarifyQuestion,
  QuestionAnswerState
} from '../../../shared/blueprint-clarify-parsers'
import { parseBlueprintPlan, parseBlueprintTasks } from '../../../shared/blueprint-artifact-parsers'

describe('blueprint-clarify-parsers', () => {
  // ── parseClarifyFindings ──

  describe('parseClarifyFindings', () => {
    test('parses valid findings block', () => {
      const text = `Some intro text.

\`\`\`blueprint-clarify-findings
{
  "findings": [
    {
      "id": "f1",
      "category": "security_gaps",
      "severity": "critical",
      "status": "outstanding",
      "title": "No auth specified",
      "description": "The spec lacks authentication details.",
      "specRefs": ["Section 3"],
      "recommendation": "Add OAuth2"
    }
  ],
  "summary": "1 critical gap found"
}
\`\`\`

More text.`

      const result = parseClarifyFindings(text)
      assert.ok(result)
      assert.equal(result.findings.length, 1)
      assert.equal(result.findings[0].id, 'f1')
      assert.equal(result.findings[0].category, 'security_gaps')
      assert.equal(result.findings[0].severity, 'critical')
      assert.equal(result.findings[0].status, 'outstanding')
      assert.equal(result.summary, '1 critical gap found')
    })

    test('returns null when no block found', () => {
      const result = parseClarifyFindings('No findings block here.')
      assert.equal(result, null)
    })

    test('coerces unknown category to missing_requirements', () => {
      const text = `\`\`\`blueprint-clarify-findings
{
  "findings": [{"id": "f1", "category": "unknown_thing", "severity": "low", "status": "outstanding", "title": "T", "description": "D", "specRefs": [], "recommendation": "R"}],
  "summary": ""
}
\`\`\``
      const result = parseClarifyFindings(text)
      assert.ok(result)
      assert.equal(result.findings[0].category, 'missing_requirements')
    })

    test('generates IDs for findings without them', () => {
      const text = `\`\`\`blueprint-clarify-findings
{
  "findings": [{"category": "security_gaps", "severity": "high", "status": "outstanding", "title": "T", "description": "D", "specRefs": [], "recommendation": "R"}],
  "summary": ""
}
\`\`\``
      const result = parseClarifyFindings(text)
      assert.ok(result)
      assert.equal(result.findings[0].id, 'f1')
    })

    test('uses last block when multiple present', () => {
      const text = `\`\`\`blueprint-clarify-findings
{"findings": [{"id": "old", "category": "security_gaps", "severity": "low", "status": "outstanding", "title": "Old", "description": "", "specRefs": [], "recommendation": ""}], "summary": "old"}
\`\`\`

\`\`\`blueprint-clarify-findings
{"findings": [{"id": "new", "category": "performance_gaps", "severity": "high", "status": "resolved", "title": "New", "description": "", "specRefs": [], "recommendation": ""}], "summary": "new"}
\`\`\``
      const result = parseClarifyFindings(text)
      assert.ok(result)
      assert.equal(result.findings[0].id, 'new')
      assert.equal(result.summary, 'new')
    })

    test('handles malformed JSON gracefully', () => {
      const text = `\`\`\`blueprint-clarify-findings
{ "findings": [{ broken json
\`\`\``
      const result = parseClarifyFindings(text)
      assert.equal(result, null)
    })

    test('preserves resolvedBy through the parse round-trip', () => {
      const text = `\`\`\`blueprint-clarify-findings
{
  "findings": [{"id": "f1", "category": "missing_requirements", "severity": "high", "status": "resolved", "title": "T", "description": "D", "specRefs": [], "recommendation": "R", "resolvedBy": "CLAUDE.md — design tokens spec"}],
  "summary": ""
}
\`\`\``
      const result = parseClarifyFindings(text)
      assert.ok(result)
      assert.equal(result.findings[0].resolvedBy, 'CLAUDE.md — design tokens spec')
    })

    test('leaves resolvedBy undefined when absent — not an empty string', () => {
      const text = `\`\`\`blueprint-clarify-findings
{
  "findings": [{"id": "f1", "category": "security_gaps", "severity": "low", "status": "outstanding", "title": "T", "description": "D", "specRefs": [], "recommendation": "R"}],
  "summary": ""
}
\`\`\``
      const result = parseClarifyFindings(text)
      assert.ok(result)
      assert.equal(result.findings[0].resolvedBy, undefined)
    })

    test('keeps resolvedBy on a resolved finding that also needs coercion', () => {
      const text = `\`\`\`blueprint-clarify-findings
{
  "findings": [{"category": "unknown_thing", "status": "resolved", "title": "T", "resolvedBy": "src/theme.ts:12"}],
  "summary": ""
}
\`\`\``
      const result = parseClarifyFindings(text)
      assert.ok(result)
      assert.equal(result.findings[0].id, 'f1')
      assert.equal(result.findings[0].category, 'missing_requirements')
      assert.equal(result.findings[0].status, 'resolved')
      assert.equal(result.findings[0].resolvedBy, 'src/theme.ts:12')
    })
  })

  // ── parseClarifyQuestions ──

  describe('parseClarifyQuestions', () => {
    test('parses valid questions block', () => {
      const text = `\`\`\`blueprint-clarify-questions
{
  "questions": [
    {
      "id": "q1",
      "header": "Auth Strategy",
      "question": "Which auth?",
      "multiSelect": false,
      "options": [
        {"label": "OAuth2", "recommended": true, "recommendedReason": "Standard"},
        {"label": "API keys", "recommended": false}
      ]
    }
  ]
}
\`\`\``
      const result = parseClarifyQuestions(text)
      assert.ok(result)
      assert.equal(result.questions.length, 1)
      assert.equal(result.questions[0].id, 'q1')
      assert.equal(result.questions[0].options[0].recommended, true)
      assert.equal(result.questions[0].options[0].recommendedReason, 'Standard')
    })

    test('returns null when no block found', () => {
      assert.equal(parseClarifyQuestions('no questions'), null)
    })

    test('generates IDs for questions without them', () => {
      const text = `\`\`\`blueprint-clarify-questions
{"questions": [{"header": "H", "question": "Q?", "multiSelect": false, "options": [{"label": "A", "recommended": true}]}]}
\`\`\``
      const result = parseClarifyQuestions(text)
      assert.ok(result)
      assert.equal(result.questions[0].id, 'q1')
    })
  })

  // ── parseClarifyCompletion ──

  describe('parseClarifyCompletion', () => {
    test('parses valid completion block', () => {
      const text = `\`\`\`blueprint-phase-complete
{"phase": "clarify", "status": "complete", "questionsAsked": 3, "questionsAnswered": 3}
\`\`\``
      const result = parseClarifyCompletion(text)
      assert.ok(result)
      assert.equal(result.phase, 'clarify')
      assert.equal(result.status, 'complete')
      assert.equal(result.questionsAsked, 3)
    })

    test('returns null for non-clarify completion', () => {
      const text = `\`\`\`blueprint-phase-complete
{"phase": "specify", "status": "complete"}
\`\`\``
      assert.equal(parseClarifyCompletion(text), null)
    })

    test('returns null when no block', () => {
      assert.equal(parseClarifyCompletion('no completion'), null)
    })
  })

  // ── stripBlueprintBlocks ──

  describe('stripBlueprintBlocks', () => {
    test('removes all three block types', () => {
      const text = `Intro.

\`\`\`blueprint-clarify-findings
{"findings": [], "summary": ""}
\`\`\`

Middle.

\`\`\`blueprint-clarify-questions
{"questions": []}
\`\`\`

End.

\`\`\`blueprint-phase-complete
{"phase": "clarify", "status": "complete"}
\`\`\``

      const result = stripBlueprintBlocks(text)
      assert.ok(!result.includes('blueprint-clarify-findings'))
      assert.ok(!result.includes('blueprint-clarify-questions'))
      assert.ok(!result.includes('blueprint-phase-complete'))
      assert.ok(result.includes('Intro.'))
      assert.ok(result.includes('Middle.'))
      assert.ok(result.includes('End.'))
    })

    test('returns trimmed text when no blocks present', () => {
      const result = stripBlueprintBlocks('  Hello world  ')
      assert.equal(result, 'Hello world')
    })

    test('strips partial/unterminated fence (mid-stream)', () => {
      const text = `Here is my analysis of the requirements.

\`\`\`blueprint-clarify-findings
{"findings": [{"id": "f1", "category": "sec`

      const result = stripBlueprintBlocks(text)
      assert.ok(!result.includes('blueprint-clarify-findings'))
      assert.ok(!result.includes('{"findings"'))
      assert.ok(result.includes('Here is my analysis'))
    })

    test('strips 4-backtick fences', () => {
      const text = `Intro text.

\`\`\`\`blueprint-clarify-findings
{"findings": [], "summary": "none"}
\`\`\`\`

After.`

      const result = stripBlueprintBlocks(text)
      assert.ok(!result.includes('blueprint-clarify-findings'))
      assert.ok(!result.includes('{"findings"'))
      assert.ok(result.includes('Intro text.'))
      assert.ok(result.includes('After.'))
    })

    test('strips any blueprint-* fence name', () => {
      const text = `Before.

\`\`\`blueprint-plan-tasks
{"tasks": []}
\`\`\`

After.`

      const result = stripBlueprintBlocks(text)
      assert.ok(!result.includes('blueprint-plan-tasks'))
      assert.ok(!result.includes('{"tasks"'))
      assert.ok(result.includes('Before.'))
      assert.ok(result.includes('After.'))
    })

    test('preserves prose when partial fence is at end', () => {
      const text = `This is important context that the user should see.

I found several issues:
1. Missing auth
2. No error handling

\`\`\`blueprint-clarify-findings
{"findings": [{"id":`

      const result = stripBlueprintBlocks(text)
      assert.ok(result.includes('This is important context'))
      assert.ok(result.includes('Missing auth'))
      assert.ok(result.includes('No error handling'))
      assert.ok(!result.includes('blueprint-clarify-findings'))
      assert.ok(!result.includes('{"findings"'))
    })

    // ── F10: partial JSON / tagged blocks in committed segments ──

    test('F10: split-before-JSON-close — continuation segment strips orphaned closer', () => {
      // A segment split landed mid-JSON: the opener lived in the previous
      // segment, this one starts with the JSON tail + the closing fence.
      const continuation = `"score": 8, "feedback": "solid"}
\`\`\`

Now the prose continues after the block.`

      const result = stripBlueprintBlocks(continuation)
      assert.ok(!result.includes('"score": 8'), 'JSON tail must not render as prose')
      assert.ok(!result.includes('```'), 'orphaned closing fence must be stripped')
      assert.ok(result.includes('Now the prose continues'), 'post-block prose survives')
    })

    test('F10: split-after-open — opener segment strips open block to end', () => {
      // The opener segment carries the fence + partial JSON; rule 2 already
      // strips to end-of-segment. Verifies the interaction with rule 3.
      const openerSegment = `Analysis prose before the block.

\`\`\`blueprint-clarify-findings
{"findings": [{"id": "f1", "category": "sec`

      const result = stripBlueprintBlocks(openerSegment)
      assert.ok(result.includes('Analysis prose before the block.'))
      assert.ok(!result.includes('blueprint-clarify-findings'))
      assert.ok(!result.includes('{"findings"'))
    })

    test('F10: closer-orphan segment — JSON tail + bare fence stripped from start', () => {
      // No fence at all in the previous segment (unfenced JSON), so the
      // continuation starts mid-JSON and its first fence is the closer.
      const orphan = `{"remaining": "keys": ["a"]}
\`\`\`

Summary text.`

      const result = stripBlueprintBlocks(orphan)
      assert.ok(!result.includes('"remaining"'), 'JSON tail must not render as prose')
      assert.ok(!result.includes('```'), 'bare fence must be stripped')
      assert.ok(result.includes('Summary text.'))
    })

    test('F10: plain code block opening a segment is NOT stripped', () => {
      // A legitimate ```ts opener carries an info string and is not a closer —
      // the guard must leave it alone.
      const legit = `\`\`\`ts
const x = 1
\`\`\`

Prose after.`

      const result = stripBlueprintBlocks(legit)
      assert.ok(result.includes('```ts'), 'legit code opener survives')
      assert.ok(result.includes('const x = 1'))
      assert.ok(result.includes('Prose after.'))
    })

    test('F10: prose before a bare fence (no JSON signal) is NOT stripped', () => {
      // No JSON signal before the fence → not a block continuation; the fence
      // is a legitimate code block opener for the following content.
      const prose = `Some plain prose line
\`\`\`
code body
\`\`\`

End.`

      const result = stripBlueprintBlocks(prose)
      assert.ok(result.includes('Some plain prose line'))
      assert.ok(result.includes('code body'))
    })
  })

  // ── parseBlueprintPlan ──

  describe('parseBlueprintPlan', () => {
    test('parses valid plan block', () => {
      const text = `Here is the plan.

\`\`\`blueprint-plan
{"items": [{"id": 1, "title": "Setup auth", "description": "Add OAuth2", "files": ["auth.ts"]}]}
\`\`\`

Done.`
      const result = parseBlueprintPlan(text)
      assert.ok(result)
      assert.equal((result.items as unknown[]).length, 1)
    })

    test('returns null when no plan block', () => {
      assert.equal(parseBlueprintPlan('no plan here'), null)
    })

    test('uses last block when multiple present', () => {
      const text = `\`\`\`blueprint-plan
{"items": [{"id": "old"}]}
\`\`\`
\`\`\`blueprint-plan
{"items": [{"id": "new"}]}
\`\`\``
      const result = parseBlueprintPlan(text)
      assert.ok(result)
      assert.equal((result.items as Array<{ id: string }>)[0].id, 'new')
    })
  })

  // ── parseBlueprintTasks ──

  describe('parseBlueprintTasks', () => {
    test('parses valid tasks block', () => {
      const text = `\`\`\`blueprint-tasks
{"tasks": [{"id": "t1", "description": "Build login", "wave": 1}]}
\`\`\``
      const result = parseBlueprintTasks(text)
      assert.ok(result)
      assert.equal((result.tasks as unknown[]).length, 1)
    })

    test('returns null when no tasks block', () => {
      assert.equal(parseBlueprintTasks('nothing'), null)
    })
  })

  // ── clarifyQuestionToGrillQuestion ──

  describe('clarifyQuestionToGrillQuestion', () => {
    test('maps fields correctly with allowOther=true', () => {
      const q: ClarifyQuestion = {
        id: 'q1',
        header: 'Auth Strategy',
        question: 'Which auth?',
        multiSelect: false,
        options: [
          { label: 'OAuth2', recommended: true, recommendedReason: 'Standard' },
          { label: 'API keys', recommended: false }
        ]
      }
      const gq = clarifyQuestionToGrillQuestion(q)
      assert.equal(gq.id, 'q1')
      assert.equal(gq.question, 'Which auth?')
      assert.equal(gq.header, 'Auth Strategy')
      assert.equal(gq.multiSelect, false)
      assert.equal(gq.allowOther, true)
      assert.equal(gq.options.length, 2)
      assert.equal(gq.options[0].recommended, true)
      assert.equal(gq.options[0].recommendedReason, 'Standard')
    })
  })

  // ── formatClarifyAnswerMessage ──

  describe('formatClarifyAnswerMessage', () => {
    const questions: ClarifyQuestion[] = [
      {
        id: 'q1',
        header: 'Auth',
        question: 'Which?',
        multiSelect: false,
        options: [{ label: 'OAuth2', recommended: true }]
      },
      {
        id: 'q2',
        header: 'DB',
        question: 'Which?',
        multiSelect: true,
        options: [{ label: 'Postgres', recommended: true }]
      }
    ]

    test('formats selected options with question IDs', () => {
      const states: Record<string, QuestionAnswerState> = {
        q1: { selectedOptions: ['OAuth2'], otherText: '', otherSelected: false, skipped: false },
        q2: {
          selectedOptions: ['Postgres', 'Redis'],
          otherText: '',
          otherSelected: false,
          skipped: false
        }
      }
      const result = formatClarifyAnswerMessage(questions, states)
      assert.ok(result.includes('**q1 — Auth**: OAuth2'))
      assert.ok(result.includes('**q2 — DB**: Postgres, Redis'))
    })

    test('marks skipped questions with question IDs', () => {
      const states: Record<string, QuestionAnswerState> = {
        q1: { selectedOptions: [], otherText: '', otherSelected: false, skipped: true },
        q2: { selectedOptions: ['Postgres'], otherText: '', otherSelected: false, skipped: false }
      }
      const result = formatClarifyAnswerMessage(questions, states)
      assert.ok(result.includes('**q1 — Auth**: _(skipped)_'))
      assert.ok(result.includes('**q2 — DB**: Postgres'))
    })

    test('includes Other text with question IDs', () => {
      const states: Record<string, QuestionAnswerState> = {
        q1: { selectedOptions: [], otherText: 'Custom JWT', otherSelected: true, skipped: false },
        q2: {
          selectedOptions: ['Postgres'],
          otherText: 'DynamoDB',
          otherSelected: true,
          skipped: false
        }
      }
      const result = formatClarifyAnswerMessage(questions, states)
      assert.ok(result.includes('**q1 — Auth**: Custom JWT'))
      assert.ok(result.includes('**q2 — DB**: Postgres, DynamoDB'))
    })

    test('handles missing state as skipped', () => {
      const result = formatClarifyAnswerMessage(questions, {})
      assert.ok(result.includes('_(skipped)_'))
    })
  })

  // ── deduplicateClarifyQuestions ──

  describe('deduplicateClarifyQuestions', () => {
    const q1: ClarifyQuestion = {
      id: 'q1',
      header: 'Auth',
      question: 'Which auth?',
      multiSelect: false,
      options: []
    }
    const q2: ClarifyQuestion = {
      id: 'q2',
      header: 'DB',
      question: 'Which DB?',
      multiSelect: false,
      options: []
    }
    const q3: ClarifyQuestion = {
      id: 'q3',
      header: 'Cache',
      question: 'Which cache?',
      multiSelect: false,
      options: []
    }

    test('removes exact duplicates (same id + question)', () => {
      const result = deduplicateClarifyQuestions([q1, q2, q3], [q1, q2])
      assert.equal(result.length, 1)
      assert.equal(result[0].id, 'q3')
    })

    test('keeps all when no overlap', () => {
      const result = deduplicateClarifyQuestions([q2, q3], [q1])
      assert.equal(result.length, 2)
    })

    test('returns empty when all are duplicates', () => {
      const result = deduplicateClarifyQuestions([q1, q2], [q1, q2])
      assert.equal(result.length, 0)
    })

    test('returns all when no previous', () => {
      const result = deduplicateClarifyQuestions([q1, q2], [])
      assert.equal(result.length, 2)
    })
  })

  // ── Merged fences (MERGED-FENCE-FIX) ──

  describe('back-to-back blocks with merged fences', () => {
    const round1 = '{"findings":[{"id":"f1","title":"ROUND1"}],"summary":"round one"}'
    const round2 = '{"findings":[{"id":"f9","title":"ROUND2"}],"summary":"round two"}'
    const questions =
      '{"questions":[{"id":"q1","header":"H","question":"Q?","multiSelect":false,"options":[{"label":"A","recommended":true}]}]}'

    // Observed in production: the clarify agent re-emits findings each round and
    // put the closing fence of block 1 on the same line as the opening fence of
    // block 2, so the two runs merged into six backticks.
    const merged =
      'Intro prose.\n\n```blueprint-clarify-findings\n' +
      round1 +
      '\n``````blueprint-clarify-findings\n' +
      round2 +
      '\n```\n'

    test('REGRESSION: the second block is stripped instead of leaking as chat text', () => {
      const stripped = stripBlueprintBlocks(merged)
      assert.equal(stripped, 'Intro prose.')
      assert.ok(!stripped.includes('blueprint-clarify-findings'), 'no bare label may survive')
      assert.ok(!stripped.includes('"findings"'), 'no raw JSON may survive')
    })

    test('REGRESSION: no dangling fence is left to render as an empty code block', () => {
      assert.ok(!stripBlueprintBlocks(merged).includes('```'))
    })

    test('the newest round still wins when fences are merged', () => {
      assert.equal(parseClarifyFindings(merged)?.summary, 'round two')
    })

    test('a findings block merged into a questions block parses and strips', () => {
      const mixed =
        'Prose.\n\n```blueprint-clarify-findings\n' +
        round1 +
        '\n``````blueprint-clarify-questions\n' +
        questions +
        '\n```\n'
      assert.equal(stripBlueprintBlocks(mixed), 'Prose.')
      assert.equal(parseClarifyQuestions(mixed)?.questions.length, 1)
      assert.equal(parseClarifyFindings(mixed)?.summary, 'round one')
    })

    test('a legitimate 4-backtick fence is left alone', () => {
      const wide = 'Hi.\n\n````blueprint-clarify-findings\n' + round1 + '\n````\n\nBye.'
      assert.equal(stripBlueprintBlocks(wide), 'Hi.\n\nBye.')
      assert.equal(parseClarifyFindings(wide)?.summary, 'round one')
    })

    test('normalizeFenceRuns only splits runs glued to a block label', () => {
      const prose = 'Six backticks `````` alone in prose stay put.'
      assert.equal(normalizeFenceRuns(prose), prose)
    })
  })

  // ── One bad block must not discard the good ones (LAST-MATCH-FIX) ──

  describe('a single malformed block is not fatal', () => {
    const goodFindings =
      '{"findings":[{"id":"f1","category":"security_gaps","severity":"high","status":"outstanding","title":"GOOD","description":"","specRefs":[],"recommendation":""}],"summary":"good round"}'
    const goodQuestions =
      '{"questions":[{"id":"q1","header":"Auth","question":"Which auth?","multiSelect":false,"options":[{"label":"OAuth2","recommended":true}]}]}'

    test('findings: a truncated newest emission falls back to the previous one', () => {
      const text =
        '```blueprint-clarify-findings\n' +
        goodFindings +
        '\n```\n\n```blueprint-clarify-findings\n{"findings": [{ truncated\n```\n'
      const result = parseClarifyFindings(text)
      assert.ok(result, 'a malformed tail must not discard the earlier valid block')
      assert.equal(result.summary, 'good round')
      assert.equal(result.findings[0].title, 'GOOD')
    })

    test('questions: a truncated newest emission falls back to the previous one', () => {
      const text =
        '```blueprint-clarify-questions\n' +
        goodQuestions +
        '\n```\n\n```blueprint-clarify-questions\n{"questions": [{ truncated\n```\n'
      const result = parseClarifyQuestions(text)
      assert.ok(result, 'a malformed tail must not discard the earlier valid block')
      assert.equal(result.questions.length, 1)
      assert.equal(result.questions[0].id, 'q1')
    })

    // A finding whose prose embeds a ``` fence terminates the lazy capture early,
    // so that emission can never parse. Observed as a plausible production trigger:
    // it is independent of the fence merge and survives normalizeFenceRuns.
    test('findings: an emission truncated by an embedded code fence is skipped', () => {
      const text =
        '```blueprint-clarify-findings\n' +
        goodFindings +
        '\n```\n\n```blueprint-clarify-findings\n' +
        '{"findings":[{"id":"f2","recommendation":"wrap it in ``` fenced code ```"}],"summary":"newest"}' +
        '\n```\n'
      assert.equal(parseClarifyFindings(text)?.summary, 'good round')
    })

    test('the newest VALID emission still wins over older valid ones', () => {
      const text =
        '```blueprint-clarify-findings\n{"findings":[],"summary":"oldest"}\n```\n\n' +
        '```blueprint-clarify-findings\n{"findings":[],"summary":"newest"}\n```\n\n' +
        '```blueprint-clarify-findings\n{ broken\n```\n'
      assert.equal(parseClarifyFindings(text)?.summary, 'newest')
    })

    test('all blocks malformed still returns null', () => {
      const text =
        '```blueprint-clarify-findings\n{ broken one\n```\n\n' +
        '```blueprint-clarify-findings\n{ broken two\n```\n'
      assert.equal(parseClarifyFindings(text), null)
      assert.equal(parseClarifyQuestions('```blueprint-clarify-questions\n{ nope\n```'), null)
      assert.equal(parseClarifyCompletion('```blueprint-phase-complete\n{ nope\n```'), null)
    })

    // Production shape (blueprint 3c66405c): findings re-emitted each round with a
    // merged 6-backtick fence, a well-formed questions block, and a damaged tail.
    // Pre-fix this logged "zero parsed blocks" and fell back to the free-text panel.
    test('REGRESSION: merged fences + damaged tail still yield findings AND questions', () => {
      const text =
        'Here is my analysis.\n\n```blueprint-clarify-findings\n' +
        goodFindings +
        '\n``````blueprint-clarify-questions\n' +
        goodQuestions +
        '\n```\n\n```blueprint-clarify-questions\n{"questions": [{ truncated\n```\n'

      const findings = parseClarifyFindings(text)
      const questions = parseClarifyQuestions(text)

      assert.ok(findings, 'findings must survive the merged fence')
      assert.equal(findings.summary, 'good round')
      assert.ok(questions, 'questions must survive the damaged tail')
      assert.equal(questions.questions[0].header, 'Auth')
      // With questions recovered, handleClarifyTurnEnd takes neither the nudge (C)
      // nor the awaitingInput (D) branch.
      assert.ok(questions.questions.length > 0)
    })
  })
})
