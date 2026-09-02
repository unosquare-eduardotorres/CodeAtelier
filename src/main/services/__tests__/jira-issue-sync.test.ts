/**
 * Jira status write-back — the transition matcher and the pipeline sync.
 *
 * This is the first thing in the app that writes to Jira without a user
 * clicking, so the tests are about restraint as much as behaviour:
 *
 *  - a workspace that did not opt in must not reach the REST layer *at all*
 *  - the epic anchor is never transitioned, only the tickets that were selected
 *  - a workflow that offers no match is a skip, never a failure
 *  - a completion carrying unverified checks comments instead of claiming Done
 *  - nothing here may ever throw into a blueprint
 *
 * The REST calls and the repositories are replaced through `jiraSyncDeps`, so
 * no network and no SQLite are involved.
 *
 * Run: tsx src/main/services/__tests__/jira-issue-sync.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, runExclusive, summaryAsync } from './test-harness'
import { setupFullMock } from './setup-full-mock'
import { findTransitionTo } from '../../../shared/jira-transition-match'
import { readJiraSyncLog } from '../../../shared/jira.types'
import type { JiraTransition } from '../../../shared/jira.types'
import { formatTransitions } from '../../mcp-servers/jira-api'

// The full mock, not just the electron stub: the service imports the blueprint
// and workspace repositories at module load, and loading those standalone walks
// into the db/index ↔ base-repository import cycle. Every repository call is
// replaced through `jiraSyncDeps` below, so the mock repos are never read.
setupFullMock()

const sync = require('../jira-issue-sync.service')
const { jiraSyncDeps, syncBlueprintIssues, syncBlueprintDone } = sync

// ── Part B: matching a transition across arbitrary workflows ──

function t(over: Partial<JiraTransition> & { id: string }): JiraTransition {
  return { name: over.name ?? over.id, ...over }
}

describe('findTransitionTo — one rule for the checkbox and the pipeline', () => {
  test('matches on the status category, so a non-English workflow still works', () => {
    const german = [
      t({
        id: '1',
        name: 'Bearbeitung beginnen',
        toStatus: 'In Arbeit',
        toCategory: 'indeterminate'
      })
    ]
    assert.equal(findTransitionTo(german, 'in-progress')?.id, '1')

    const spanish = [t({ id: '2', name: 'Finalizar', toStatus: 'Terminado', toCategory: 'done' })]
    assert.equal(findTransitionTo(spanish, 'done')?.id, '2')
  })

  test('falls back to the English name when Jira sent no status category', () => {
    // Jira Server / DC responses that do not expand the category at all.
    const started = [t({ id: '4', name: 'Start Progress', toStatus: 'In Progress' })]
    assert.equal(findTransitionTo(started, 'in-progress')?.id, '4')

    const closed = [t({ id: '5', name: 'Close Issue', toStatus: 'Closed' })]
    assert.equal(findTransitionTo(closed, 'done')?.id, '5')
  })

  test('returns null when the workflow offers nothing that matches', () => {
    const backlogOnly = [t({ id: '6', name: 'Reopen', toStatus: 'To Do', toCategory: 'new' })]
    assert.equal(findTransitionTo(backlogOnly, 'in-progress'), null)
    assert.equal(findTransitionTo(backlogOnly, 'done'), null)
    assert.equal(findTransitionTo([], 'done'), null)
  })

  test('never reads "Won\'t Do" as done, though Jira categorises it as done', () => {
    // The trap this whole matcher exists for: category alone would close a
    // ticket as a duplicate and call it delivered.
    const resolutions = [
      t({ id: '7', name: "Won't Do", toStatus: "Won't Do", toCategory: 'done' }),
      t({ id: '8', name: 'Mark as Duplicate', toStatus: 'Duplicate', toCategory: 'done' })
    ]
    assert.equal(findTransitionTo(resolutions, 'done'), null)

    const withRealDone = [...resolutions, t({ id: '9', name: 'Done', toCategory: 'done' })]
    assert.equal(findTransitionTo(withRealDone, 'done')?.id, '9')
  })

  test('does not read Blocked or In Review as "I have started this"', () => {
    const indeterminate = [
      t({ id: '10', name: 'Block', toStatus: 'Blocked', toCategory: 'indeterminate' }),
      t({ id: '11', name: 'Send to review', toStatus: 'In Review', toCategory: 'indeterminate' })
    ]
    assert.equal(findTransitionTo(indeterminate, 'in-progress'), null)
  })

  test('prefers the named In Progress when several in-flight states are offered', () => {
    const many = [
      t({ id: '12', name: 'Do it', toStatus: 'Doing', toCategory: 'indeterminate' }),
      t({ id: '13', name: 'Start', toStatus: 'In Progress', toCategory: 'indeterminate' })
    ]
    assert.equal(findTransitionTo(many, 'in-progress')?.id, '13')
  })

  test('formatTransitions carries the status category through from Jira', () => {
    const shaped = formatTransitions({
      transitions: [
        {
          id: 21,
          name: 'Start',
          to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } }
        },
        { id: 31, name: 'Odd', to: { name: 'Odd', statusCategory: { key: 'made-up' } } }
      ]
    })
    assert.equal(shaped[0].toCategory, 'indeterminate')
    // An unknown key is dropped rather than passed through as a category.
    assert.equal(shaped[1].toCategory, undefined)
  })
})

// ── Part A: the pipeline write point ──

interface Recorder {
  listed: string[]
  moved: Array<{ key: string; transitionId: string }>
  comments: Array<{ key: string; body: string }>
  saved: Record<string, unknown> | null
}

const realDeps = { ...jiraSyncDeps }

/** A blueprint built from two selected tickets under an epic that was not. */
function fakeBlueprint(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'bp-1',
    workspaceId: 'ws-1',
    title: 'Checkout total ignores discounts',
    status: 'complete',
    unverifiedJson: null,
    settingsJson: {
      jiraIssueKeys: ['CHR-40', 'CHR-41'],
      jiraIssueKey: 'CHR-1',
      jiraEpicKey: 'CHR-1'
    },
    ...over
  }
}

function installStub(opts: {
  workspaceSettings?: Record<string, unknown>
  blueprint?: Record<string, unknown>
  findBlueprintThrows?: boolean
  transitionsFor?: (key: string) => JiraTransition[]
  onTransition?: (key: string) => void
  configured?: boolean
}): Recorder {
  const rec: Recorder = { listed: [], moved: [], comments: [], saved: null }
  const blueprint = opts.blueprint ?? fakeBlueprint()

  jiraSyncDeps.getWorkspaceSettings = (): Record<string, unknown> =>
    opts.workspaceSettings ?? { jiraSyncStatus: true }
  jiraSyncDeps.isJiraConfigured = (): boolean => opts.configured !== false
  jiraSyncDeps.findBlueprint = (): unknown => {
    if (opts.findBlueprintThrows) throw new Error('db is gone')
    return blueprint
  }
  jiraSyncDeps.saveBlueprintSettings = (_id: string, settings: Record<string, unknown>): void => {
    rec.saved = settings
  }
  jiraSyncDeps.listTransitions = async (_ws: string, key: string): Promise<JiraTransition[]> => {
    rec.listed.push(key)
    const fn =
      opts.transitionsFor ??
      ((): JiraTransition[] => [
        t({ id: '21', name: 'Done', toCategory: 'done' }),
        t({ id: '11', name: 'Start', toStatus: 'In Progress', toCategory: 'indeterminate' })
      ])
    return fn(key)
  }
  jiraSyncDeps.transitionIssue = async (
    _ws: string,
    key: string,
    transitionId: string
  ): Promise<void> => {
    opts.onTransition?.(key)
    rec.moved.push({ key, transitionId })
  }
  jiraSyncDeps.addComment = async (_ws: string, key: string, body: string): Promise<void> => {
    rec.comments.push({ key, body })
  }
  return rec
}

/**
 * Install the stub, run the body, put the real deps back.
 *
 * Serialized: `jiraSyncDeps` is a process-global and the harness starts every
 * async test at once, so two tests swapping it would otherwise clobber each
 * other across every `await`.
 */
function withStub(
  opts: Parameters<typeof installStub>[0],
  body: (rec: Recorder) => Promise<void>
): Promise<void> {
  return runExclusive(async () => {
    const rec = installStub(opts)
    try {
      await body(rec)
    } finally {
      Object.assign(jiraSyncDeps, realDeps)
    }
  })
}

describe('syncBlueprintIssues — moving the tickets a blueprint covers', () => {
  test('writes nothing at all when the workspace has not opted in', () =>
    withStub({ workspaceSettings: {} }, async (rec) => {
      // Not "makes no change" — makes no *request*. The REST layer is never
      // reached, so a workspace that did not ask for this cannot be surprised.
      const outcome = await syncBlueprintIssues('bp-1', 'in-progress')
      assert.deepEqual(rec.listed, [])
      assert.deepEqual(rec.moved, [])
      assert.equal(rec.saved, null)
      assert.deepEqual(outcome.moved, [])
    }))

  test('moves every ticket in the group, and never the epic anchor', () =>
    withStub({}, async (rec) => {
      const outcome = await syncBlueprintIssues('bp-1', 'in-progress')
      assert.deepEqual(outcome.moved, ['CHR-40', 'CHR-41'])
      assert.deepEqual(rec.listed, ['CHR-40', 'CHR-41'])
      assert.ok(!rec.listed.includes('CHR-1'), 'the epic was never touched')
      assert.deepEqual(
        rec.moved.map((m) => m.transitionId),
        ['11', '11']
      )
    }))

  test('one ticket failing does not lose the rest of the group', () =>
    withStub(
      {
        onTransition: (key) => {
          if (key === 'CHR-40') throw new Error('Jira rejected the transition.')
        }
      },
      async (rec) => {
        const outcome = await syncBlueprintIssues('bp-1', 'done')
        assert.deepEqual(outcome.failed, [
          { key: 'CHR-40', error: 'Jira rejected the transition.' }
        ])
        assert.deepEqual(outcome.moved, ['CHR-41'])
        assert.equal(rec.moved.length, 1)
      }
    ))

  test('a workflow offering no match is a skip, not a failure', () =>
    withStub({ transitionsFor: () => [] }, async () => {
      const outcome = await syncBlueprintIssues('bp-1', 'in-progress')
      assert.deepEqual(outcome.skipped, ['CHR-40', 'CHR-41'])
      assert.deepEqual(outcome.failed, [])
      assert.deepEqual(outcome.moved, [])
    }))

  test('an unreadable workflow is reported, never thrown', () =>
    withStub(
      {
        transitionsFor: () => {
          throw new Error('You do not have permission to view this issue.')
        }
      },
      async () => {
        const outcome = await syncBlueprintIssues('bp-1', 'done')
        assert.equal(outcome.failed.length, 2)
        assert.equal(outcome.moved.length, 0)
      }
    ))

  test('records what it did on the blueprint, so the run can show it', () =>
    withStub({}, async (rec) => {
      await syncBlueprintIssues('bp-1', 'in-progress')
      const ledger = readJiraSyncLog(rec.saved ?? {})
      assert.deepEqual(ledger['in-progress']?.moved, ['CHR-40', 'CHR-41'])
      // The original settings survive the write.
      assert.deepEqual((rec.saved as Record<string, unknown>).jiraIssueKeys, ['CHR-40', 'CHR-41'])
    }))

  test('never throws, even when the blueprint lookup itself fails', () =>
    withStub({ findBlueprintThrows: true }, async () => {
      const outcome = await syncBlueprintIssues('bp-1', 'done')
      assert.deepEqual(outcome.moved, [])
      assert.deepEqual(outcome.failed, [])
    }))

  test('does nothing when Jira is not connected for the workspace', () =>
    withStub({ configured: false }, async (rec) => {
      await syncBlueprintIssues('bp-1', 'done')
      assert.deepEqual(rec.listed, [])
    }))
})

// ── Part C2: the completion gate ──

const UNVERIFIED = [{ taskId: 'T003', gate: 'tests', reason: 'no_command' }]

describe('syncBlueprintDone — what a finished run is allowed to claim', () => {
  test('a clean completion moves the tickets to Done', () =>
    withStub({}, async (rec) => {
      const outcome = await syncBlueprintDone('bp-1')
      assert.deepEqual(outcome.moved, ['CHR-40', 'CHR-41'])
      assert.deepEqual(rec.comments, [])
    }))

  test('a completion carrying unverified checks comments instead of closing', () =>
    withStub({ blueprint: fakeBlueprint({ unverifiedJson: UNVERIFIED }) }, async (rec) => {
      const outcome = await syncBlueprintDone('bp-1')
      assert.deepEqual(rec.moved, [], 'the status was left alone')
      assert.deepEqual(outcome.commented, ['CHR-40', 'CHR-41'])
      // The comment has to say what could not be proven, or it is noise.
      assert.match(rec.comments[0].body, /T003\/tests: no_command/)
      assert.match(rec.comments[0].body, /left unchanged/)
    }))

  test('jiraDoneOnWarnings opts back into Done regardless of the ledger', () =>
    withStub(
      {
        blueprint: fakeBlueprint({ unverifiedJson: UNVERIFIED }),
        workspaceSettings: { jiraSyncStatus: true, jiraDoneOnWarnings: true }
      },
      async (rec) => {
        const outcome = await syncBlueprintDone('bp-1')
        assert.deepEqual(outcome.moved, ['CHR-40', 'CHR-41'])
        assert.deepEqual(rec.comments, [])
      }
    ))

  test('a failed or cancelled run is left alone entirely', () =>
    withStub({ blueprint: fakeBlueprint({ status: 'failed' }) }, async (rec) => {
      await syncBlueprintDone('bp-1')
      assert.deepEqual(rec.listed, [])
      assert.deepEqual(rec.comments, [])
    }))

  test('does not write a second time for a blueprint already synced', () =>
    // Several services write the terminal 'complete' status depending on the
    // path the run took; the recorded outcome is what stops two of them from
    // both moving the same ticket.
    withStub(
      {
        blueprint: fakeBlueprint({
          settingsJson: {
            jiraIssueKeys: ['CHR-40'],
            jiraSync: {
              done: {
                intent: 'done',
                at: '2026-01-01T00:00:00Z',
                moved: ['CHR-40'],
                skipped: [],
                failed: []
              }
            }
          }
        })
      },
      async (rec) => {
        await syncBlueprintDone('bp-1')
        assert.deepEqual(rec.listed, [])
      }
    ))
})

// summaryAsync() calls process.exit() — only run it as the entry point, or the
// shared runner is terminated mid-list.
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
