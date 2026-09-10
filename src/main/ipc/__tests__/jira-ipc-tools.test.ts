/**
 * jira.ipc.ts — real IPC handler coverage.
 *
 * No test had ever loaded this module (0% of 489 lines). These tests register
 * the real handlers against the electron-stub ipcMain and invoke them through
 * tryInvokeHandler, with jira-rest.service / blueprint.service /
 * jira-issue-sync.service mocked and the blueprint repository mocked —
 * covering argument validation, the JQL/comment/bulk limits, error
 * user-facing-ification, and the grouped blueprint conversion flow including
 * duplicate skipping, per-ticket failure isolation and attachment import.
 *
 * jira.ipc destructures the service functions at load time, so the mocks are
 * created ONCE and reconfigured per test via mockImplementation — swapping the
 * property on the mock object would not rebind the module's captured
 * references.
 *
 * Run: tsx src/main/ipc/__tests__/jira-ipc-tools.test.ts
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test, describe, summaryAsync, runExclusive } from '../../services/__tests__/test-harness'
import {
  setupFullMock,
  getMockRepo,
  tryInvokeHandler,
  createSpy,
  mockService,
  unmockService
} from '../../services/__tests__/setup-full-mock'

setupFullMock()

// jira.ipc imports JiraRequestError from jira-rest.service — which this file
// mocks — so the class the handlers instanceof-check against is supplied by
// the mock. A locally-defined subclass keeps the curated-vs-generic branches
// of toUserFacing distinguishable without loading the real service.
class JiraRequestErrorCtor extends Error {}

function issue(key: string, over: Record<string, unknown> = {}): any {
  return {
    key,
    summary: `Summary of ${key}`,
    type: 'Task',
    status: 'Open',
    assignee: 'Dana',
    labels: [],
    description: 'Body',
    comments: [],
    attachments: [],
    browseUrl: `https://test.atlassian.net/browse/${key}`,
    ...over
  }
}

// ── Service mocks — created once; tests reconfigure the same spies ─────────

const searchIssues = createSpy(async () => ({ issues: [], count: 0 }))
const listProjects = createSpy(async () => [])
const listBoards = createSpy(async () => [])
const listSprints = createSpy(async () => [])
const getIssue = createSpy(async (_ws: string, key: string) => issue(key))
const addComment = createSpy(async () => undefined)
const assignToMe = createSpy(async () => ({ displayName: 'Dana' }))
const listTransitions = createSpy(async () => [])
const transitionIssue = createSpy(async () => undefined)
const downloadAttachment = createSpy(async () => Buffer.from('file-bytes'))

mockService('jira-rest.service', {
  searchIssues,
  listProjects,
  listBoards,
  listSprints,
  getIssue,
  addComment,
  assignToMe,
  listTransitions,
  transitionIssue,
  downloadAttachment,
  JiraRequestError: JiraRequestErrorCtor
})

const syncBlueprintInProgress = createSpy(async () => undefined)
mockService('jira-issue-sync.service', { syncBlueprintInProgress })

const createBlueprint = createSpy(() => ({ id: 'bp-1', title: 'Group' }))
// blueprint-handoff-options.test registers the broader key
// 'services/blueprint.service' and never unmocks it; the substring-matching
// interceptor would hand jira.ipc THAT stub (no .create). Drop it and register
// ours under both spellings so whichever key matches, the real mock wins.
unmockService('services/blueprint.service')
mockService('blueprint.service', { blueprintService: { create: createBlueprint } })
mockService('services/blueprint.service', { blueprintService: { create: createBlueprint } })

const blueprintRepo = getMockRepo('blueprint')

// ── Module load ──────────────────────────────────────────────────────────────

let loaded = false
try {
  require('../jira.ipc').registerJiraIpc()
  loaded = true
} catch (err) {
  console.error(`jira.ipc load FAILED: ${(err as Error).message}`)
}

if (loaded) {
  describe('jira.ipc — jira:searchIssues', () => {
    test('happy path forwards to the service and returns its rows', async () => {
      await runExclusive(async () => {
        searchIssues.mockImplementation(async () => ({ issues: [{ key: 'PROJ-1' }], count: 1 }))
        const r = await tryInvokeHandler('jira:searchIssues', {
          workspaceId: 'ws-1',
          jql: 'project = PROJ',
          maxResults: 5
        })
        assert.equal(r.ok, true)
        assert.equal((r.result as any).count, 1)
      })
    })

    test('a missing workspaceId is rejected', async () => {
      const r = await tryInvokeHandler('jira:searchIssues', { jql: 'x' })
      assert.equal(r.ok, false)
      assert.match(String((r as any).error), /workspaceId/)
    })

    test('an oversized JQL query is rejected before any request', async () => {
      const r = await tryInvokeHandler('jira:searchIssues', {
        workspaceId: 'ws-1',
        jql: 'x'.repeat(5000)
      })
      assert.equal(r.ok, false)
      assert.match(String((r as any).error), /Query too long/)
    })

    test('an unexpected service error becomes the generic user-facing message', async () => {
      await runExclusive(async () => {
        searchIssues.mockImplementation(async () => {
          throw new Error('secret stack / token leak')
        })
        const r = await tryInvokeHandler('jira:searchIssues', {
          workspaceId: 'ws-1',
          jql: 'project = PROJ'
        })
        assert.equal(r.ok, false)
        assert.match(String((r as any).error), /Jira request failed/)
        assert.ok(!String((r as any).error).includes('token leak'))
      })
    })

    test('a JiraRequestError keeps its curated message', async () => {
      await runExclusive(async () => {
        searchIssues.mockImplementation(async () => {
          throw new JiraRequestErrorCtor('Issue PROJ-9 does not exist')
        })
        const r = await tryInvokeHandler('jira:searchIssues', {
          workspaceId: 'ws-1',
          jql: 'project = PROJ'
        })
        assert.equal(r.ok, false)
        assert.match(String((r as any).error), /does not exist/)
      })
    })
  })

  describe('jira.ipc — simple proxy channels', () => {
    test('jira:listProjects returns the service list', async () => {
      await runExclusive(async () => {
        listProjects.mockImplementation(async () => [{ key: 'PROJ', name: 'Project' }])
        const r = await tryInvokeHandler('jira:listProjects', { workspaceId: 'ws-1' })
        assert.equal(r.ok, true)
        assert.equal((r.result as any[]).length, 1)
      })
    })

    test('jira:listBoards requires a projectKey', async () => {
      const r = await tryInvokeHandler('jira:listBoards', { workspaceId: 'ws-1' })
      assert.equal(r.ok, false)
      assert.match(String((r as any).error), /projectKey/)
    })

    test('jira:listSprints rejects a missing boardId', async () => {
      const r = await tryInvokeHandler('jira:listSprints', { workspaceId: 'ws-1' })
      assert.equal(r.ok, false)
      assert.match(String((r as any).error), /boardId/)
    })

    test('jira:getIssue returns the detail', async () => {
      await runExclusive(async () => {
        getIssue.mockImplementation(async () => issue('PROJ-42'))
        const r = await tryInvokeHandler('jira:getIssue', {
          workspaceId: 'ws-1',
          issueKey: 'PROJ-42'
        })
        assert.equal(r.ok, true)
        assert.equal((r.result as any).key, 'PROJ-42')
      })
    })

    test('jira:addComment succeeds and reports {success:true}', async () => {
      await runExclusive(async () => {
        addComment.mockImplementation(async () => undefined)
        const r = await tryInvokeHandler('jira:addComment', {
          workspaceId: 'ws-1',
          issueKey: 'PROJ-1',
          body: 'Fixed in #42'
        })
        assert.equal(r.ok, true)
        assert.deepEqual(r.result, { success: true })
      })
    })

    test('jira:addComment rejects an oversized comment', async () => {
      const r = await tryInvokeHandler('jira:addComment', {
        workspaceId: 'ws-1',
        issueKey: 'PROJ-1',
        body: 'x'.repeat(31_000)
      })
      assert.equal(r.ok, false)
      assert.match(String((r as any).error), /Comment too long/)
    })

    test('jira:assignToMe returns the current user', async () => {
      await runExclusive(async () => {
        assignToMe.mockImplementation(async () => ({ displayName: 'Dana Doe' }))
        const r = await tryInvokeHandler('jira:assignToMe', {
          workspaceId: 'ws-1',
          issueKey: 'PROJ-1'
        })
        assert.equal(r.ok, true)
        assert.equal((r.result as any).displayName, 'Dana Doe')
      })
    })

    test('jira:transitionIssue returns {success:true}', async () => {
      await runExclusive(async () => {
        transitionIssue.mockImplementation(async () => undefined)
        const r = await tryInvokeHandler('jira:transitionIssue', {
          workspaceId: 'ws-1',
          issueKey: 'PROJ-1',
          transitionId: '31'
        })
        assert.equal(r.ok, true)
        assert.deepEqual(r.result, { success: true })
      })
    })

    test('jira:listTransitions returns the service list', async () => {
      await runExclusive(async () => {
        listTransitions.mockImplementation(async () => [{ id: '11', name: 'In Progress' }])
        const r = await tryInvokeHandler('jira:listTransitions', {
          workspaceId: 'ws-1',
          issueKey: 'PROJ-1'
        })
        assert.equal(r.ok, true)
        assert.equal((r.result as any[]).length, 1)
      })
    })
  })

  describe('jira.ipc — jira:convertedKeys', () => {
    test('indexes blueprints by their jiraIssueKeys settings', async () => {
      await runExclusive(async () => {
        blueprintRepo.findByWorkspace = createSpy(() => [
          { id: 'bp-1', settingsJson: { jiraIssueKeys: ['PROJ-1', 'PROJ-2'] } },
          { id: 'bp-legacy', settingsJson: { jiraIssueKey: 'PROJ-9' } }
        ])
        const r = await tryInvokeHandler('jira:convertedKeys', { workspaceId: 'ws-1' })
        assert.equal(r.ok, true)
        const map = r.result as Record<string, string>
        assert.equal(map['PROJ-1'], 'bp-1')
        assert.equal(map['PROJ-2'], 'bp-1')
        assert.equal(map['PROJ-9'], 'bp-legacy')
      })
    })
  })

  describe('jira.ipc — jira:createBlueprints', () => {
    test('too many selected issues is refused', async () => {
      await runExclusive(async () => {
        const keys = Array.from({ length: 26 }, (_, i) => `PROJ-${i}`)
        const r = await tryInvokeHandler('jira:createBlueprints', {
          workspaceId: 'ws-1',
          issueKeys: keys
        })
        assert.equal(r.ok, false)
        assert.match(String((r as any).error), /too many issues/)
      })
    })

    test('already-converted tickets are skipped, the rest become ONE blueprint', async () => {
      await runExclusive(async () => {
        blueprintRepo.findByWorkspace = createSpy(() => [
          { id: 'bp-existing', settingsJson: { jiraIssueKeys: ['PROJ-DONE'] } }
        ])
        getIssue.mockImplementation(async (_ws: string, key: string) =>
          issue(key, { parent: 'EPIC-1', parentSummary: 'Auth work', parentType: 'Epic' })
        )
        createBlueprint.calls.length = 0
        createBlueprint.callCount = 0
        const r = await tryInvokeHandler('jira:createBlueprints', {
          workspaceId: 'ws-1',
          issueKeys: ['PROJ-DONE', 'PROJ-A', 'PROJ-B']
        })
        assert.equal(r.ok, true)
        const result = r.result as any
        assert.deepEqual(
          result.skipped,
          [{ issueKey: 'PROJ-DONE', blueprintId: 'bp-existing' }],
          'duplicate is reported as skipped, not an error'
        )
        assert.equal(createBlueprint.callCount, 1, 'exactly one blueprint for the group')
        assert.deepEqual(result.created.issueKeys.sort(), ['PROJ-A', 'PROJ-B'])
        assert.equal(result.failed.length, 0)
      })
    })

    test('unreadable tickets fail individually without losing the group', async () => {
      await runExclusive(async () => {
        blueprintRepo.findByWorkspace = createSpy(() => [])
        getIssue.mockImplementation(async (_ws: string, key: string) => {
          if (key === 'PROJ-BAD') throw new JiraRequestErrorCtor('404: no such issue')
          return issue(key)
        })
        createBlueprint.calls.length = 0
        createBlueprint.callCount = 0
        const r = await tryInvokeHandler('jira:createBlueprints', {
          workspaceId: 'ws-1',
          issueKeys: ['PROJ-GOOD', 'PROJ-BAD']
        })
        assert.equal(r.ok, true)
        const result = r.result as any
        assert.deepEqual(result.failed, [{ issueKey: 'PROJ-BAD', error: '404: no such issue' }])
        assert.equal(result.created.issueKeys.length, 1)
      })
    })

    test('all-unreadable selections create nothing', async () => {
      await runExclusive(async () => {
        blueprintRepo.findByWorkspace = createSpy(() => [])
        getIssue.mockImplementation(async () => {
          throw new Error('Jira unreachable')
        })
        createBlueprint.calls.length = 0
        createBlueprint.callCount = 0
        const r = await tryInvokeHandler('jira:createBlueprints', {
          workspaceId: 'ws-1',
          issueKeys: ['PROJ-1']
        })
        assert.equal(r.ok, true)
        const result = r.result as any
        assert.equal(result.created, null)
        assert.equal(result.failed.length, 1)
        assert.equal(createBlueprint.callCount, 0)
      })
    })

    test('attachments are downloaded into the managed docs dir and recorded', async () => {
      await runExclusive(async () => {
        blueprintRepo.findByWorkspace = createSpy(() => [])
        getIssue.mockImplementation(async () =>
          issue('PROJ-ATT', {
            attachments: [
              {
                id: 'a1',
                filename: 'screenshot.png',
                contentUrl: 'https://jira/attach/1',
                size: 9
              }
            ]
          })
        )
        downloadAttachment.mockImplementation(async () => Buffer.from('file-bytes'))
        blueprintRepo.update = createSpy(() => ({}))
        const r = await tryInvokeHandler('jira:createBlueprints', {
          workspaceId: 'ws-1',
          issueKeys: ['PROJ-ATT']
        })
        assert.equal(r.ok, true)
        assert.equal((r.result as any).created.blueprintId, 'bp-1')
        assert.equal(downloadAttachment.callCount, 1)
        // settings_json was widened with the imported reference document
        const updateArgs = blueprintRepo.update.calls[0]?.[1]
        const recorded = updateArgs?.settingsJson?.referenceDocuments as any[]
        assert.ok(recorded?.length === 1, 'one reference document recorded')
        assert.ok(existsSync(recorded[0].path), `attachment written to ${recorded[0].path}`)
        assert.ok(recorded[0].name.includes('screenshot.png'))
      })
    })
  })
} else {
  describe('jira.ipc (load failure — NOT skipped)', () => {
    test('module loads under the full mock', () => {
      assert.ok(false, 'jira.ipc must load — a silent skip here is dead coverage')
    })
  })
}

describe('jira.ipc — cleanup', () => {
  test('service mocks are unregistered for later files', async () => {
    await runExclusive(async () => {
      // The mocks above are deliberately narrow (one method each) — any later
      // file requiring the real blueprint.service would silently get this
      // three-method stub instead. runExclusive bodies run in registration
      // order, so this runs after every handler test above.
      unmockService('jira-rest.service')
      unmockService('jira-issue-sync.service')
      unmockService('blueprint.service')
      unmockService('services/blueprint.service')
      assert.ok(true)
    })
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
