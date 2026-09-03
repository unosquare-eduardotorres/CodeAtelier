/**
 * Task-failure display helpers — pattern mapping for the Retry screen.
 *
 * The Retry banner used to show only the ephemeral lastError (null after a
 * reload). These helpers turn the PERSISTED failure reasons
 * (blueprint_tasks.failure_reason) and the verification-failure artifact into
 * human-readable text, so a retry after reload still explains itself.
 *
 * Run: tsx src/renderer/src/utils/__tests__/task-failure-display.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../../../main/services/__tests__/test-harness'
import {
  humanizeFailureReason,
  extractMissingFiles,
  deriveTaskFailureDisplay,
  capTaskList
} from '../task-failure-display'

describe('humanizeFailureReason — pattern mapping', () => {
  test('null → generic no-reason message', () => {
    assert.match(humanizeFailureReason(null), /no reason was recorded/)
  })

  test('undefined → generic no-reason message', () => {
    assert.match(humanizeFailureReason(undefined), /no reason was recorded/)
  })

  test('empty string → generic no-reason message', () => {
    assert.match(humanizeFailureReason(''), /no reason was recorded/)
  })

  test('"planned missing" → covers both dead-session and impossible-deliverable causes', () => {
    const out = humanizeFailureReason('verification failed — 2 planned missing')
    // Dead-session cause must still be mentioned (the common historical case)
    assert.match(out, /OpenCode server/)
    // ...but the message must not assert server death as the ONLY cause —
    // R005 (blueprint 718c) ran full LLM turns and still "planned missing"
    // because its deliverable (tasks.md) was pipeline metadata, impossible
    // by construction.
    assert.match(out, /planned file itself may be wrong or impossible/)
    assert.doesNotMatch(out, /died before writing any files/)
  })

  test('"stalled — no activity" → sibling-teardown explanation', () => {
    const out = humanizeFailureReason('BUILD-T001 phase stalled — no activity for 5m')
    assert.match(out, /went silent mid-task/)
    assert.match(out, /sibling/)
  })

  test('"Phase cancelled" → cancelled explanation', () => {
    assert.equal(humanizeFailureReason('Phase cancelled'), 'Cancelled before finishing.')
  })

  test('"executor error:" prefix is preserved verbatim (already actionable)', () => {
    const out = humanizeFailureReason('executor error: ServeError: port 4096 already in use')
    assert.equal(out, 'Executor error: ServeError: port 4096 already in use')
  })

  test('sendOutcome: overload', () => {
    assert.match(humanizeFailureReason('overload'), /overloaded/)
  })

  test('sendOutcome: turn_limit_exhausted', () => {
    assert.match(humanizeFailureReason('turn_limit_exhausted'), /turn limit/)
  })

  test('sendOutcome: context_overflow', () => {
    assert.match(humanizeFailureReason('context_overflow'), /context window/)
  })

  test('no-write-activity', () => {
    assert.match(humanizeFailureReason('no-write-activity'), /never invoked a write tool/)
  })

  test('quality gate failed', () => {
    assert.match(humanizeFailureReason('quality gate failed: G3'), /quality gate/)
  })

  test('B3 stop-loss reason reports the repeat count, not the canned sentence', () => {
    // Exactly the shape blueprint-build.service.ts appends: the escalation
    // reason first, the stop-loss clause after it.
    const out = humanizeFailureReason(
      'quality gate failed: lint — stop-loss after 2 identical gate failure(s) ' +
        '(lint) — skipped 1 builder attempt(s), escalated to blueprint:lead-review'
    )
    assert.match(out, /same quality gate 2× in a row/)
    assert.match(out, /remaining builder attempts were skipped/)
    assert.doesNotMatch(
      out,
      /failed a deterministic quality gate/,
      'the generic branch must not win — it discards the counts'
    )
  })

  test('a plain gate failure still falls through to the generic sentence', () => {
    assert.equal(
      humanizeFailureReason('quality gate failed: lint'),
      'The task output failed a deterministic quality gate.'
    )
  })

  test('unknown reason surfaces verbatim (never hidden)', () => {
    assert.equal(humanizeFailureReason('some novel failure xyz'), 'some novel failure xyz')
  })
})

describe('extractMissingFiles — verification-failure artifact parsing', () => {
  const ARTIFACT = [
    '## Task T003 — claimed files missing on disk',
    '',
    '**Claimed but absent (1):**',
    '- `docs/signature-request.md`',
    '',
    '**Planned but absent (2):**',
    '- `src/qc_export.py`',
    '- `tests/qc_export.test.py`',
    ''
  ].join('\n')

  test('extracts bullet file paths', () => {
    const files = extractMissingFiles(ARTIFACT)
    assert.deepEqual(files, [
      'docs/signature-request.md',
      'src/qc_export.py',
      'tests/qc_export.test.py'
    ])
  })

  test('caps at max (default 3)', () => {
    const many = ['- `a.py`', '- `b.py`', '- `c.py`', '- `d.py`', '- `e.py`']
      .map((l) => l + '\n')
      .join('')
    assert.deepEqual(extractMissingFiles(many), ['a.py', 'b.py', 'c.py'])
  })

  test('respects custom max', () => {
    const many = ['- `a.py`', '- `b.py`', '- `c.py`'].map((l) => l + '\n').join('')
    assert.deepEqual(extractMissingFiles(many, 2), ['a.py', 'b.py'])
  })

  test('null / undefined / empty → []', () => {
    assert.deepEqual(extractMissingFiles(null), [])
    assert.deepEqual(extractMissingFiles(undefined), [])
    assert.deepEqual(extractMissingFiles(''), [])
  })

  test('no bullets → []', () => {
    assert.deepEqual(extractMissingFiles('## Task T003\n\nplain text, no bullets'), [])
  })
})

describe('deriveTaskFailureDisplay — composite shape', () => {
  test('maps task fields + artifact into display shape', () => {
    const disp = deriveTaskFailureDisplay(
      {
        taskId: 'T003',
        failureReason: 'verification failed — 1 planned missing',
        attempts: 6
      },
      '**Planned but absent (1):**\n- `docs/signature-request.md`\n'
    )
    assert.equal(disp.title, 'T003')
    assert.match(disp.hint, /planned file\(s\) are missing/)
    assert.match(disp.hint, /OpenCode server/)
    assert.equal(disp.attempts, 6)
    assert.deepEqual(disp.missingFiles, ['docs/signature-request.md'])
  })

  test('attempts badge data: 1 → singular, >1 → plural (caller renders)', () => {
    const one = deriveTaskFailureDisplay({ taskId: 'T001', failureReason: null, attempts: 1 })
    assert.equal(one.attempts, 1)
    const six = deriveTaskFailureDisplay({ taskId: 'T003', failureReason: null, attempts: 6 })
    assert.equal(six.attempts, 6)
  })

  test('no artifact → empty missingFiles', () => {
    const disp = deriveTaskFailureDisplay({
      taskId: 'T004',
      failureReason: 'overload',
      attempts: 2
    })
    assert.deepEqual(disp.missingFiles, [])
  })
})

describe('capTaskList — list truncation', () => {
  const tasks = [1, 2, 3, 4, 5, 6, 7].map((i) => ({ i }))

  test('≤ max → all shown, hiddenCount 0', () => {
    const r = capTaskList(tasks.slice(0, 5), 5)
    assert.equal(r.shown.length, 5)
    assert.equal(r.hiddenCount, 0)
  })

  test('> max → first max shown, rest counted', () => {
    const r = capTaskList(tasks, 5)
    assert.equal(r.shown.length, 5)
    assert.deepEqual(r.shown.map((t) => t.i), [1, 2, 3, 4, 5])
    assert.equal(r.hiddenCount, 2)
  })

  test('empty list → nothing shown', () => {
    const r = capTaskList([], 5)
    assert.equal(r.shown.length, 0)
    assert.equal(r.hiddenCount, 0)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
