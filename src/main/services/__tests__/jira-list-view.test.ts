/**
 * Jira ticket list — the view-model layer between a JQL result and the rows on
 * screen.
 *
 * These functions are the reason the panel can filter, sort and group at all,
 * and every one of them is a place where a plausible-looking implementation
 * quietly lies:
 *
 *   - a filter that does not normalise punctuation makes `CHR2` match nothing,
 *     which reads as "no such ticket" rather than "wrong comparison";
 *   - a priority sort built on `mapJiraPriority` ranks Lowest equal to Medium,
 *     because that helper collapses onto P1–P3;
 *   - "unknown last" has to hold in *both* directions or an unprioritised
 *     ticket tops the list the moment someone flips the arrow.
 *
 * There is no renderer unit harness in this repo, which is exactly why this
 * logic lives in `shared/` rather than inside the hook.
 *
 * Run: tsx src/main/services/__tests__/jira-list-view.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import type { JiraIssueRow } from '../../../shared/jira.types'
import {
  JIRA_SORT_FIELDS,
  JIRA_SORT_LABELS,
  asSortField,
  filterIssues,
  groupByProject,
  priorityImportance,
  projectKeyOf,
  projectKeysOf,
  sortIssues
} from '../../../shared/jira-list-view'

function row(overrides: Partial<JiraIssueRow> & { key: string }): JiraIssueRow {
  return {
    summary: 'A ticket',
    assignee: 'Unassigned',
    ...overrides
  }
}

/** Keys only — what almost every assertion below is really about. */
function keys(rows: readonly JiraIssueRow[]): string[] {
  return rows.map((r) => r.key)
}

// ── projectKeyOf ──

describe('jira-list-view — projectKeyOf', () => {
  test('splits a normal key on the last dash', () => {
    assert.equal(projectKeyOf('CHR-40'), 'CHR')
    assert.equal(projectKeyOf('NSLJD-1234'), 'NSLJD')
  })

  test('handles the underscore/digit keys Jira also allows', () => {
    assert.equal(projectKeyOf('AB1_C-9'), 'AB1_C')
  })

  test('uppercases, so a hand-typed key groups with its siblings', () => {
    assert.equal(projectKeyOf('chr-40'), 'CHR')
  })

  test('a malformed key is returned whole rather than throwing', () => {
    // A row that lands in its own bucket is recoverable; a crash in a map
    // callback takes the whole list down.
    assert.equal(projectKeyOf('not-a-key'), 'NOT-A-KEY')
    assert.equal(projectKeyOf('CHR'), 'CHR')
    assert.equal(projectKeyOf(''), '')
    assert.equal(projectKeyOf('   '), '')
  })

  test('projectKeysOf is unique and sorted', () => {
    const rows = [row({ key: 'NSLJD-2' }), row({ key: 'CHR-1' }), row({ key: 'CHR-2' })]
    assert.deepEqual(projectKeysOf(rows), ['CHR', 'NSLJD'])
  })
})

// ── filterIssues ──

describe('jira-list-view — filterIssues', () => {
  const rows = [
    row({
      key: 'CHR-240',
      summary: 'Checkout total ignores discounts',
      status: 'In Progress',
      type: 'Bug',
      assignee: 'Josh Lane'
    }),
    row({
      key: 'CHR-7',
      summary: 'Add SSO login',
      status: 'To Do',
      type: 'Story',
      assignee: 'Mia Chen'
    }),
    row({
      key: 'NSLJD-88',
      summary: 'Nightly job times out',
      status: 'Blocked',
      type: 'Bug',
      assignee: 'Josh Lane'
    })
  ]

  test('CHR2 matches CHR-240 — punctuation is normalised away on both sides', () => {
    // This is the whole point of the normalisation: nobody types the dash.
    assert.deepEqual(keys(filterIssues(rows, 'CHR2')), ['CHR-240'])
  })

  test('terms are ANDed across key, summary, assignee, status and type', () => {
    assert.deepEqual(keys(filterIssues(rows, 'chr bug josh')), ['CHR-240'])
  })

  test('a term matching nothing yields an empty list, not a crash', () => {
    assert.deepEqual(filterIssues(rows, 'zzzz'), [])
  })

  test('a multi-word status matches even though the row stores it with a space', () => {
    assert.deepEqual(keys(filterIssues(rows, 'in progress')), ['CHR-240'])
  })

  test('an empty or all-punctuation filter matches everything', () => {
    // Returning nothing here would look exactly like a failed query.
    assert.equal(filterIssues(rows, '').length, 3)
    assert.equal(filterIssues(rows, '   ').length, 3)
    assert.equal(filterIssues(rows, '---').length, 3)
  })

  test('rows with missing optional fields do not throw', () => {
    const sparse = [row({ key: 'CHR-1', summary: '' })]
    assert.equal(filterIssues(sparse, 'chr').length, 1)
    assert.equal(filterIssues(sparse, 'bug').length, 0)
  })

  test('the input array is never mutated', () => {
    const original = [...rows]
    filterIssues(rows, 'chr')
    assert.deepEqual(rows, original)
  })
})

// ── sortIssues ──

describe('jira-list-view — sortIssues by priority', () => {
  const rows = [
    row({ key: 'A-1', priority: 'Medium' }),
    row({ key: 'A-2', priority: 'Blocker' }),
    row({ key: 'A-3', priority: 'Lowest' }),
    row({ key: 'A-4', priority: 'High' })
  ]

  test('descending puts the most urgent first — what "Priority desc" means on a board', () => {
    assert.deepEqual(keys(sortIssues(rows, 'priority', 'desc')), ['A-2', 'A-4', 'A-1', 'A-3'])
  })

  test('ascending is the exact reverse', () => {
    assert.deepEqual(keys(sortIssues(rows, 'priority', 'asc')), ['A-3', 'A-1', 'A-4', 'A-2'])
  })

  test('Lowest and Medium are not collapsed together', () => {
    // mapJiraPriority in jira-format.ts maps both to P3; reusing it here would
    // make this ordering arbitrary.
    assert.notEqual(priorityImportance('lowest'), priorityImportance('medium'))
  })

  test('an unknown priority sorts last in BOTH directions', () => {
    const withUnknown = [
      row({ key: 'A-1', priority: 'Wibble' }),
      row({ key: 'A-2', priority: 'High' }),
      row({ key: 'A-3' })
    ]
    assert.deepEqual(keys(sortIssues(withUnknown, 'priority', 'desc')), ['A-2', 'A-1', 'A-3'])
    assert.deepEqual(keys(sortIssues(withUnknown, 'priority', 'asc')), ['A-2', 'A-1', 'A-3'])
  })

  test('the Bug scheme names rank alongside the default scheme', () => {
    assert.equal(priorityImportance('Critical'), priorityImportance('Highest'))
    assert.equal(priorityImportance('Major'), priorityImportance('High'))
    assert.equal(priorityImportance('Trivial'), priorityImportance('Lowest'))
    assert.equal(priorityImportance('nonsense'), null)
    assert.equal(priorityImportance(undefined), null)
  })
})

describe('jira-list-view — sortIssues by date, text and key', () => {
  test('updated descending is newest first', () => {
    const rows = [
      row({ key: 'A-1', updated: '2026-01-01T00:00:00.000Z' }),
      row({ key: 'A-2', updated: '2026-06-01T00:00:00.000Z' }),
      row({ key: 'A-3', updated: '2026-03-01T00:00:00.000Z' })
    ]
    assert.deepEqual(keys(sortIssues(rows, 'updated', 'desc')), ['A-2', 'A-3', 'A-1'])
    assert.deepEqual(keys(sortIssues(rows, 'updated', 'asc')), ['A-1', 'A-3', 'A-2'])
  })

  test('created is ordered independently of updated', () => {
    const rows = [
      row({ key: 'A-1', created: '2026-06-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z' }),
      row({ key: 'A-2', created: '2026-01-01T00:00:00.000Z', updated: '2026-06-01T00:00:00.000Z' })
    ]
    assert.deepEqual(keys(sortIssues(rows, 'created', 'desc')), ['A-1', 'A-2'])
    assert.deepEqual(keys(sortIssues(rows, 'updated', 'desc')), ['A-2', 'A-1'])
  })

  test('a missing or unparseable timestamp sorts last in both directions', () => {
    const rows = [
      row({ key: 'A-1' }),
      row({ key: 'A-2', updated: 'not a date' }),
      row({ key: 'A-3', updated: '2026-01-01T00:00:00.000Z' })
    ]
    assert.equal(keys(sortIssues(rows, 'updated', 'desc'))[0], 'A-3')
    assert.equal(keys(sortIssues(rows, 'updated', 'asc'))[0], 'A-3')
  })

  test('key ordering is numeric within a project, so CHR-9 precedes CHR-10', () => {
    const rows = [row({ key: 'CHR-10' }), row({ key: 'CHR-9' }), row({ key: 'ABC-2' })]
    assert.deepEqual(keys(sortIssues(rows, 'key', 'asc')), ['ABC-2', 'CHR-9', 'CHR-10'])
  })

  test('status and assignee sort case-insensitively with blanks last', () => {
    const rows = [
      row({ key: 'A-1', status: 'in progress' }),
      row({ key: 'A-2', status: 'Blocked' }),
      row({ key: 'A-3' })
    ]
    assert.deepEqual(keys(sortIssues(rows, 'status', 'asc')), ['A-2', 'A-1', 'A-3'])
  })

  test('ties keep their input order', () => {
    const rows = [
      row({ key: 'A-1', priority: 'High' }),
      row({ key: 'A-2', priority: 'High' }),
      row({ key: 'A-3', priority: 'High' })
    ]
    assert.deepEqual(keys(sortIssues(rows, 'priority', 'desc')), ['A-1', 'A-2', 'A-3'])
  })

  test('rank leaves the rows exactly as Jira returned them', () => {
    // Rank is a per-instance custom field that never appears in a search
    // response; inventing a local order would disagree with ORDER BY Rank.
    const rows = [row({ key: 'A-3' }), row({ key: 'A-1' }), row({ key: 'A-2' })]
    assert.deepEqual(keys(sortIssues(rows, 'rank', 'asc')), ['A-3', 'A-1', 'A-2'])
    assert.deepEqual(keys(sortIssues(rows, 'rank', 'desc')), ['A-3', 'A-1', 'A-2'])
  })

  test('sorting returns a copy rather than reordering the caller-s array', () => {
    const rows = [row({ key: 'A-2' }), row({ key: 'A-1' })]
    const sorted = sortIssues(rows, 'key', 'asc')
    assert.deepEqual(keys(rows), ['A-2', 'A-1'])
    assert.deepEqual(keys(sorted), ['A-1', 'A-2'])
  })

  test('an empty list is not a special case', () => {
    assert.deepEqual(sortIssues([], 'priority', 'desc'), [])
  })
})

// ── groupByProject ──

describe('jira-list-view — groupByProject', () => {
  test('buckets by project, preserving first-appearance and inner order', () => {
    const rows = [
      row({ key: 'CHR-2' }),
      row({ key: 'NSLJD-1' }),
      row({ key: 'CHR-1' }),
      row({ key: 'NSLJD-9' })
    ]
    const groups = groupByProject(rows)
    assert.deepEqual(
      groups.map((g) => g.project),
      ['CHR', 'NSLJD']
    )
    assert.deepEqual(keys(groups[0].rows), ['CHR-2', 'CHR-1'])
    assert.deepEqual(keys(groups[1].rows), ['NSLJD-1', 'NSLJD-9'])
  })

  test('grouping a sorted list keeps the sort inside each bucket', () => {
    const rows = sortIssues(
      [row({ key: 'CHR-10' }), row({ key: 'NSLJD-1' }), row({ key: 'CHR-2' })],
      'key',
      'asc'
    )
    const groups = groupByProject(rows)
    assert.deepEqual(keys(groups[0].rows), ['CHR-2', 'CHR-10'])
  })

  test('an empty list produces no groups', () => {
    assert.deepEqual(groupByProject([]), [])
  })
})

// ── Sort field metadata ──

describe('jira-list-view — sort field metadata', () => {
  test('every sort field has a label, so the dropdown cannot render undefined', () => {
    for (const field of JIRA_SORT_FIELDS) {
      assert.equal(typeof JIRA_SORT_LABELS[field], 'string')
      assert.ok(JIRA_SORT_LABELS[field].length > 0)
    }
  })

  test('asSortField rejects anything not in the list', () => {
    // Persisted view state is a JSON blob on disk — a stale value must fall back
    // rather than reach the comparator.
    assert.equal(asSortField('priority'), 'priority')
    assert.equal(asSortField('customfield_10021'), 'updated')
    assert.equal(asSortField(undefined), 'updated')
    assert.equal(asSortField(42), 'updated')
  })
})

// summaryAsync() calls process.exit() — only run it as the entry point, or the
// shared runner is terminated mid-list.
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
