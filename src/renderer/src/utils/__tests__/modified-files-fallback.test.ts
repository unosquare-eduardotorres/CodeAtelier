/**
 * Tests for aggregateModifiedFilesFromActivities — the VERIFY fallback that
 * builds the modified-files list from streamed tool activity when no git
 * baseline exists (source === 'none').
 *
 * Run: tsx src/renderer/src/utils/__tests__/modified-files-fallback.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../../main/services/__tests__/test-harness'
import { aggregateModifiedFilesFromActivities } from '../modified-files-fallback'
import type { ToolActivity } from '../../../../shared/types'

function makeActivity(overrides: Partial<ToolActivity> & { id: string }): ToolActivity {
  return {
    toolName: 'Edit',
    status: 'completed',
    startedAt: 0,
    operationType: 'edit',
    ...overrides
  }
}

describe('aggregateModifiedFilesFromActivities', () => {
  test('empty input → empty list', () => {
    assert.deepEqual(aggregateModifiedFilesFromActivities([]), [])
  })

  test('filters non-edit/write ops, non-completed, and missing filePath', () => {
    const activities = [
      makeActivity({ id: '1', operationType: 'read', filePath: 'a.ts' }),
      makeActivity({ id: '2', operationType: 'shell' }),
      makeActivity({ id: '3', status: 'running', filePath: 'b.ts' }),
      makeActivity({ id: '4', status: 'error', filePath: 'c.ts' }),
      makeActivity({ id: '5', operationType: 'write', filePath: undefined })
    ]
    assert.deepEqual(aggregateModifiedFilesFromActivities(activities), [])
  })

  test('counts from editDiffs using the countDiffLines contract', () => {
    const activities = [
      makeActivity({
        id: '1',
        filePath: 'src/a.ts',
        editDiffs: [
          { oldString: 'line1\nline2\n', newString: 'line1-changed\nline2\n' },
          { oldString: 'x', newString: 'x\ny\nz' }
        ]
      })
    ]
    const result = aggregateModifiedFilesFromActivities(activities)
    assert.equal(result.length, 1)
    // pair 1: −2 +2 · pair 2: −1 +3 → totals −3 +5
    assert.equal(result[0].additions, 5)
    assert.equal(result[0].deletions, 3)
    assert.equal(result[0].status, 'M')
  })

  test('all diffs with empty oldString → status A', () => {
    const activities = [
      makeActivity({
        id: '1',
        operationType: 'write',
        filePath: 'new.ts',
        editDiffs: [{ oldString: '', newString: 'a\nb\n' }]
      })
    ]
    const result = aggregateModifiedFilesFromActivities(activities)
    assert.equal(result[0].status, 'A')
    assert.equal(result[0].additions, 2)
    assert.equal(result[0].deletions, 0)
  })

  test('no editDiffs at all → status A with zero counts (write with no captured diff)', () => {
    const activities = [makeActivity({ id: '1', filePath: 'plain.ts' })]
    const result = aggregateModifiedFilesFromActivities(activities)
    assert.equal(result[0].status, 'A')
    assert.equal(result[0].additions, 0)
    assert.equal(result[0].deletions, 0)
  })

  test('dedupes by path — last activity wins', () => {
    const activities = [
      makeActivity({
        id: '1',
        filePath: 'same.ts',
        editDiffs: [{ oldString: '', newString: 'a\nb\nc\nd\ne\n' }]
      }),
      makeActivity({
        id: '2',
        filePath: 'same.ts',
        editDiffs: [{ oldString: 'old', newString: 'new' }]
      })
    ]
    const result = aggregateModifiedFilesFromActivities(activities)
    assert.equal(result.length, 1)
    // second activity's counts (−1 +1), not the first's (+5)
    assert.equal(result[0].additions, 1)
    assert.equal(result[0].deletions, 1)
    assert.equal(result[0].status, 'M')
  })

  test('sorts by churn descending', () => {
    const activities = [
      makeActivity({
        id: '1',
        filePath: 'low.ts',
        editDiffs: [{ oldString: 'a', newString: 'b' }]
      }),
      makeActivity({
        id: '2',
        filePath: 'high.ts',
        editDiffs: [{ oldString: 'a\nb\nc', newString: 'x\ny\nz\nw\nv' }]
      }),
      makeActivity({
        id: '3',
        filePath: 'mid.ts',
        editDiffs: [{ oldString: 'a\nb', newString: 'x' }]
      })
    ]
    const result = aggregateModifiedFilesFromActivities(activities)
    assert.deepEqual(
      result.map((f) => f.path),
      ['high.ts', 'mid.ts', 'low.ts']
    )
  })

  test('write ops count alongside edit ops', () => {
    const activities = [
      makeActivity({
        id: '1',
        operationType: 'write',
        filePath: 'w.ts',
        editDiffs: [{ oldString: 'old\ncontent\n', newString: 'fresh\n' }]
      })
    ]
    const result = aggregateModifiedFilesFromActivities(activities)
    assert.equal(result[0].path, 'w.ts')
    assert.equal(result[0].status, 'M')
    assert.equal(result[0].additions, 1)
    assert.equal(result[0].deletions, 2)
  })
})
