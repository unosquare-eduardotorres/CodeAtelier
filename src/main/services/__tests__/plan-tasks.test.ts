/**
 * Unit tests for shared/plan-tasks.ts — derivePlanTasks, derivePhaseFiles,
 * matchPlanTaskForFile, renderTaskManifest.
 *
 * These are the single source of truth for taskId derivation shared between
 * the renderer (plan panel) and the build-kickoff prompt sent to the model,
 * and for matching observed file writes back to a plan task. A bug here
 * silently breaks task-level tracking on both the model-report path and the
 * tool-activity-derived path.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import {
  derivePlanTasks,
  derivePhaseFiles,
  matchPlanTaskForFile,
  renderTaskManifest
} from '../../../shared/plan-tasks'
import type { StructuredPlan } from '../../../shared/types'

function makePlan(overrides?: Partial<StructuredPlan>): StructuredPlan {
  return {
    title: 'Test Plan',
    summary: 'test',
    phases: [
      {
        id: 1,
        title: 'Phase One',
        complexity: 3,
        risk: 'low',
        description: 'first phase',
        files: [
          { file: 'src/a.ts', change: 'Add A' },
          { file: 'src/b.ts', change: 'Add B' }
        ]
      },
      {
        id: 2,
        title: 'Phase Two',
        complexity: 3,
        risk: 'low',
        description: 'second phase',
        files: [{ file: 'src/c.ts', change: 'Add C' }]
      }
    ],
    ...overrides
  }
}

describe('derivePlanTasks', () => {
  test('taskId is `${phaseId}-${index}`, 0-based', () => {
    const derived = derivePlanTasks(makePlan())
    assert.equal(derived[0].tasks[0].taskId, '1-0')
    assert.equal(derived[0].tasks[1].taskId, '1-1')
    assert.equal(derived[1].tasks[0].taskId, '2-0')
  })

  test('task title prefers change over file', () => {
    const derived = derivePlanTasks(makePlan())
    assert.equal(derived[0].tasks[0].title, 'Add A')
  })

  test('task title falls back to file when change is empty', () => {
    const plan = makePlan({
      phases: [
        {
          id: 1,
          title: 'P1',
          complexity: 1,
          risk: 'low',
          description: '',
          files: [{ file: 'src/x.ts', change: '' }]
        }
      ]
    })
    assert.equal(derivePlanTasks(plan)[0].tasks[0].title, 'src/x.ts')
  })

  test('phase with no files derives zero tasks (phase-level tracking only)', () => {
    const plan = makePlan({
      phases: [{ id: 1, title: 'No files', complexity: 1, risk: 'low', description: '' }]
    })
    assert.deepEqual(derivePlanTasks(plan)[0].tasks, [])
  })

  test('null/undefined plan derives empty array, does not throw', () => {
    assert.deepEqual(derivePlanTasks(null), [])
    assert.deepEqual(derivePlanTasks(undefined), [])
  })
})

describe('derivePhaseFiles', () => {
  test('maps phaseId -> file list', () => {
    const files = derivePhaseFiles(makePlan())
    assert.deepEqual(files[1], ['src/a.ts', 'src/b.ts'])
    assert.deepEqual(files[2], ['src/c.ts'])
  })
})

describe('renderTaskManifest', () => {
  test('emits the exact taskId the model must echo back', () => {
    const manifest = renderTaskManifest(makePlan())
    assert.ok(manifest.includes('taskId="1-0"'), 'manifest must contain taskId="1-0"')
    assert.ok(manifest.includes('taskId="2-0"'), 'manifest must contain taskId="2-0"')
  })

  test('empty plan renders empty string', () => {
    assert.equal(renderTaskManifest(null), '')
  })
})

describe('matchPlanTaskForFile', () => {
  test('exact repo-relative match', () => {
    const match = matchPlanTaskForFile(makePlan(), 'src/a.ts')
    assert.ok(match)
    assert.equal(match?.taskId, '1-0')
    assert.equal(match?.phaseId, 1)
  })

  test('absolute path matches on path-boundary suffix', () => {
    const match = matchPlanTaskForFile(makePlan(), '/Users/eduardo/workspace/src/c.ts')
    assert.ok(match)
    assert.equal(match?.taskId, '2-0')
  })

  test('Windows backslash paths are normalized before matching', () => {
    const match = matchPlanTaskForFile(makePlan(), 'C:\\workspace\\src\\a.ts')
    assert.ok(match)
    assert.equal(match?.taskId, '1-0')
  })

  test('no match for an unrelated file', () => {
    assert.equal(matchPlanTaskForFile(makePlan(), 'src/unrelated.ts'), null)
  })

  test('does NOT falsely match a different file with the declared name as a bare substring', () => {
    // Declared task file is "store.ts". A written "my-store.ts" shares the
    // "store.ts" suffix as a substring but is a DIFFERENT file — matching it
    // would falsely complete the wrong task.
    const plan = makePlan({
      phases: [
        {
          id: 1,
          title: 'P1',
          complexity: 1,
          risk: 'low',
          description: '',
          files: [{ file: 'store.ts', change: 'Add store' }]
        }
      ]
    })
    const match = matchPlanTaskForFile(plan, 'src/renderer/my-store.ts')
    assert.equal(
      match,
      null,
      'writing my-store.ts must not be treated as completing the store.ts task'
    )
  })

  test('same file declared in two phases → ambiguous, returns null rather than guessing', () => {
    const plan = makePlan({
      phases: [
        {
          id: 1,
          title: 'P1',
          complexity: 1,
          risk: 'low',
          description: '',
          files: [{ file: 'src/shared/util.ts', change: 'A' }]
        },
        {
          id: 2,
          title: 'P2',
          complexity: 1,
          risk: 'low',
          description: '',
          files: [{ file: 'src/shared/util.ts', change: 'B' }]
        }
      ]
    })
    // Both phases declare the IDENTICAL file — a length-tie between the two
    // candidates. A wrong auto-completion is worse than a missed one, so this
    // must resolve to null instead of picking (and thus completing) either phase.
    const match = matchPlanTaskForFile(plan, 'src/shared/util.ts')
    assert.equal(match, null)
  })

  test('null/undefined plan returns null, does not throw', () => {
    assert.equal(matchPlanTaskForFile(null, 'src/a.ts'), null)
    assert.equal(matchPlanTaskForFile(undefined, 'src/a.ts'), null)
  })
})
