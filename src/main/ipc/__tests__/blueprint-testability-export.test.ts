/**
 * Unit tests for the Testability Ledger export logic.
 *
 * KNOWN LIMIT — the button click itself is not covered anywhere. The E2E fixture
 * attaches over raw CDP to the renderer only (`_electron.launch()` is
 * incompatible with Electron 41+, see the headers of ux-audit-screenshots.e2e.ts
 * and e2e/helpers/electron-app.ts), so no spec can stub `dialog.showSaveDialog`.
 * These tests cover the decisions behind the dialog instead; the click remains
 * an honest gap rather than a test-only branch in production IPC.
 *
 * Run: tsx src/main/ipc/__tests__/blueprint-testability-export.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import {
  buildTestabilityInput,
  collectTestability,
  deriveTestabilityFilename,
  exportTestabilityLedger,
  readTestabilityIdeaRefs,
  selectTestabilityIdeas,
  testabilityEntryKey,
  testabilityIdeaDraft,
  type TestabilitySources
} from '../blueprint-testability'
import { buildTestabilityReportMarkdown } from '../../../shared/testability-report'
import type { BlueprintTask } from '../../../shared/blueprint-types'
import type { PreflightCheck } from '../../../shared/preflight-types'

function failedTask(taskId: string): BlueprintTask {
  return {
    id: `row-${taskId}`,
    blueprintId: 'bp1',
    taskId,
    wave: 1,
    userStory: null,
    description: `wire up ${taskId}`,
    filePathsJson: [],
    isParallel: false,
    dependsOnJson: [],
    status: 'failed',
    executorRunId: null,
    startedAt: null,
    completedAt: null,
    completionJson: null,
    skippedByUserAt: null,
    failureReason: 'command not found',
    outcomeKind: null
  } as unknown as BlueprintTask
}

function sources(overrides: Partial<TestabilitySources> = {}): TestabilitySources {
  return {
    blueprint: {
      title: 'Payments Rework',
      status: 'complete',
      shortName: 'payments-rework',
      settingsJson: { verificationDepth: 'e2e' },
      unverifiedJson: [
        { gate: 'e2e', taskId: 'E2E', reason: 'no_command', detail: 'no e2e command resolved' }
      ]
    },
    tasks: [failedTask('T003')],
    readPreflight: () => undefined,
    generatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

/** Records what the export actually did, so "no write" can be asserted. */
function recordingIo(dialog: { canceled: boolean; filePath?: string }): {
  io: Parameters<typeof exportTestabilityLedger>[1]
  writes: Array<{ filePath: string; contents: string }>
  defaultPaths: string[]
} {
  const writes: Array<{ filePath: string; contents: string }> = []
  const defaultPaths: string[] = []
  return {
    writes,
    defaultPaths,
    io: {
      showSaveDialog: async (defaultPath) => {
        defaultPaths.push(defaultPath)
        return dialog
      },
      writeFile: async (filePath, contents) => {
        writes.push({ filePath, contents })
      },
      now: () => new Date('2026-01-15T10:00:00.000Z')
    }
  }
}

describe('exportTestabilityLedger', () => {
  test('cancelling_writes_nothing', async () => {
    const { io, writes } = recordingIo({ canceled: true })
    const result = await exportTestabilityLedger(sources(), io)

    assert.equal(result.exported, false, 'a cancelled dialog is not an export')
    assert.equal(writes.length, 0, 'cancelling must not touch the filesystem')
  })

  test('dismissed_dialog_without_a_path_writes_nothing', async () => {
    // Some platforms resolve canceled:false with no filePath. Treating that as
    // success would call writeFile(undefined).
    const { io, writes } = recordingIo({ canceled: false, filePath: undefined })
    const result = await exportTestabilityLedger(sources(), io)

    assert.equal(result.exported, false)
    assert.equal(writes.length, 0)
  })

  test('confirming_writes_the_rendered_ledger', async () => {
    const { io, writes } = recordingIo({ canceled: false, filePath: '/tmp/ledger.md' })
    const result = await exportTestabilityLedger(sources(), io)

    assert.equal(result.exported, true)
    assert.equal(result.filePath, '/tmp/ledger.md')
    assert.equal(writes.length, 1)
    assert.equal(writes[0].filePath, '/tmp/ledger.md')
    assert.ok(
      writes[0].contents.startsWith('# Testability Ledger'),
      `expected a ledger document, got: ${writes[0].contents.slice(0, 60)}`
    )
    assert.ok(writes[0].contents.includes('T003'), 'the failed task must reach the file')
  })

  test('unreadable_preflight_artifact_does_not_sink_the_export', async () => {
    // A blueprint that never reached REVIEW has no preflight artifact. The task
    // and gate evidence is independently useful, so the export must survive.
    let reported: unknown = null
    const { io, writes } = recordingIo({ canceled: false, filePath: '/tmp/ledger.md' })
    const result = await exportTestabilityLedger(
      sources({
        readPreflight: () => {
          throw new Error('no review phase')
        },
        onPreflightError: (err) => {
          reported = err
        }
      }),
      io
    )

    assert.equal(result.exported, true, 'a missing preflight artifact is not a failure')
    assert.ok(writes[0].contents.includes('T003'))
    assert.ok(reported instanceof Error, 'the caller still gets told, for the log')
  })

  test('preflight_failures_reach_the_report_when_readable', async () => {
    const checks: PreflightCheck[] = [
      {
        id: 'postgres-reachable',
        name: 'PostgreSQL',
        kind: 'service',
        status: 'blocker',
        message: 'db.internal:5432 refused the connection',
        remediation: 'Start the database or point DATABASE_URL at a live host'
      } as unknown as PreflightCheck
    ]
    const entries = collectTestability(sources({ readPreflight: () => checks }))

    const infra = entries.find((e) => e.ref === 'postgres-reachable')
    assert.ok(infra, 'a preflight blocker is unproven scope and belongs in the ledger')
    assert.equal(infra.reason, 'blocked-by-environment')
  })

  test('non_array_preflight_payload_is_ignored', async () => {
    const input = buildTestabilityInput(
      sources({ readPreflight: () => 'corrupt' as unknown as PreflightCheck[] })
    )
    assert.equal(input.preflight, undefined, 'a non-array payload must not be trusted')
  })
})

describe('deriveTestabilityFilename', () => {
  const at = new Date('2026-01-15T10:00:00.000Z')

  test('prefers_the_short_name', () => {
    assert.equal(
      deriveTestabilityFilename({ title: 'Payments Rework', shortName: 'pay-v2' }, at),
      'testability-pay-v2-2026-01-15.md'
    )
  })

  test('falls_back_to_a_slugged_title', () => {
    assert.equal(
      deriveTestabilityFilename({ title: 'Payments  Rework!! (v2)', shortName: null }, at),
      'testability-payments-rework-v2-2026-01-15.md'
    )
  })

  test('a_title_with_no_usable_characters_still_yields_a_filename', () => {
    // Slugging '###' leaves an empty string; the fallback keeps the dialog from
    // opening on 'testability--2026-01-15.md'.
    assert.equal(
      deriveTestabilityFilename({ title: '###', shortName: null }, at),
      'testability-blueprint-2026-01-15.md'
    )
  })

  test('very_long_titles_are_truncated', () => {
    const name = deriveTestabilityFilename({ title: 'a'.repeat(200), shortName: null }, at)
    assert.equal(name, `testability-${'a'.repeat(60)}-2026-01-15.md`)
  })
})

describe('follow-up idea drafting', () => {
  test('entry_key_is_stable_and_distinguishes_same_ref_rows', () => {
    const entries = collectTestability(sources())
    const keys = entries.map(testabilityEntryKey)
    assert.equal(new Set(keys).size, keys.length, 'keys must not collide within one ledger')
    assert.deepEqual(collectTestability(sources()).map(testabilityEntryKey), keys, 'and be stable')
  })

  test('draft_carries_the_reason_and_next_step', () => {
    const entry = collectTestability(sources()).find((e) => e.ref === 'T003')
    assert.ok(entry)
    const draft = testabilityIdeaDraft(entry, 'Payments Rework')

    assert.ok(draft.title.includes('T003'))
    assert.ok(draft.description.includes('Payments Rework'), 'must name its origin blueprint')
    assert.ok(draft.description.includes(entry.detail))
    assert.ok(draft.description.includes(entry.ref))
  })

  test('idea_title_is_bounded', () => {
    const draft = testabilityIdeaDraft(
      { reason: 'closed-unproven', ref: 'T001', title: 'x'.repeat(400), detail: 'd' },
      'bp'
    )
    assert.ok(draft.title.length <= 200)
  })
})

describe('follow-up selection (dedupe)', () => {
  const entries = collectTestability(
    sources({
      readPreflight: () => [
        {
          id: 'docker',
          name: 'Docker',
          kind: 'service',
          status: 'blocker',
          message: 'docker not installed'
        } as unknown as PreflightCheck
      ]
    })
  )
  const allKeys = new Set(entries.map(testabilityEntryKey))

  test('the_entries_ipc_returns_exactly_what_the_markdown_renders', () => {
    // The dialog must never show a SHORTER list than the export produces for the
    // same blueprint — preflight findings live on a main-only artifact, and
    // re-deriving them in the renderer is precisely how that drift happens.
    const markdown = buildTestabilityReportMarkdown(
      buildTestabilityInput(
        sources({
          readPreflight: () => [
            {
              id: 'docker',
              name: 'Docker',
              kind: 'service',
              status: 'blocker',
              message: 'docker not installed'
            } as unknown as PreflightCheck
          ]
        })
      )
    )
    for (const entry of entries) {
      assert.ok(
        markdown.includes(entry.title),
        `"${entry.title}" is offered as an idea but never appears in the export`
      )
    }
    assert.ok(markdown.includes('Open items:** ' + entries.length))
  })

  test('all_selected_and_nothing_linked_yields_every_entry', () => {
    const picked = selectTestabilityIdeas(entries, allKeys, {})
    assert.equal(picked.length, entries.length)
  })

  test('a_second_click_creates_nothing', () => {
    // Simulate the first click having recorded its ids.
    const linked: Record<string, string> = {}
    for (const { entryKey } of selectTestabilityIdeas(entries, allKeys, {})) {
      linked[entryKey] = `idea-${entryKey}`
    }
    assert.equal(selectTestabilityIdeas(entries, allKeys, linked).length, 0)
  })

  test('a_partly_linked_ledger_only_offers_the_rest', () => {
    const first = testabilityEntryKey(entries[0])
    const picked = selectTestabilityIdeas(entries, allKeys, { [first]: 'idea-1' })
    assert.equal(picked.length, entries.length - 1)
    assert.ok(!picked.some((p) => p.entryKey === first))
  })

  test('unselected_rows_are_skipped', () => {
    const only = new Set([testabilityEntryKey(entries[0])])
    const picked = selectTestabilityIdeas(entries, only, {})
    assert.equal(picked.length, 1)
    assert.equal(picked[0].entry.ref, entries[0].ref)
  })

  test('an_unknown_key_from_a_stale_dialog_matches_nothing', () => {
    // The renderer may hold a ledger from before a re-run. Keys that no longer
    // exist must be ignored rather than fabricating an idea.
    const picked = selectTestabilityIdeas(entries, new Set(['closed-unproven::T999::gone']), {})
    assert.equal(picked.length, 0)
  })
})

describe('readTestabilityIdeaRefs', () => {
  test('missing_key_is_an_empty_map', () => {
    assert.deepEqual(readTestabilityIdeaRefs(undefined), {})
    assert.deepEqual(readTestabilityIdeaRefs({}), {})
  })

  test('non_string_values_are_dropped_not_trusted', () => {
    // A corrupt map must degrade to "offer the row again", never to a crash or
    // to silently hiding a row behind a bogus link.
    const refs = readTestabilityIdeaRefs({
      testabilityIdeaIds: { good: 'idea-1', bad: 42, empty: '' }
    })
    assert.deepEqual(refs, { good: 'idea-1' })
  })

  test('an_array_payload_is_rejected', () => {
    assert.deepEqual(readTestabilityIdeaRefs({ testabilityIdeaIds: ['idea-1'] }), {})
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
