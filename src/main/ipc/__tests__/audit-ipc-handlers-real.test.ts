/**
 * audit.ipc.ts — real handler coverage for the non-streaming channels.
 *
 * The existing audit IPC tests assert registration and vacuous ok/not-ok
 * outcomes. These tests drive the actual handler bodies with mocked
 * repositories and services: stale-run reconciliation on getLatest, history /
 * deleteRun, plan listing + export (with a save dialog that actually saves),
 * finding-handoff bookkeeping, generatePlan, and the rerunTrack guard errors.
 *
 * Run: tsx src/main/ipc/__tests__/audit-ipc-handlers-real.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, summaryAsync, runExclusive } from '../../services/__tests__/test-harness'
import {
  setupFullMock,
  getMockRepo,
  mockMainWindow,
  tryInvokeHandler,
  createSpy,
  mockService,
  unmockService
} from '../../services/__tests__/setup-full-mock'

setupFullMock()

// ── Service mocks ────────────────────────────────────────────────────────────

const auditAgentService = {
  isRunning: false,
  cancel: createSpy(() => undefined),
  runSingleTrack: createSpy(async () => undefined)
}
mockService('audit-agent.service', { auditAgentService })

const generate = createSpy(async () => ({
  id: 'plan-1',
  title: 'Security Fix Plan',
  summary: 'Fix the three injections'
}))
mockService('audit-plan-generator.service', {
  auditPlanGeneratorService: { generate }
})

mockService('notification.service', {
  notificationService: { notify: createSpy(() => undefined) }
})

const auditRepo = getMockRepo('audit')
const wsRepo = getMockRepo('workspace')
const auditPlanRepo = getMockRepo('auditPlan')

// ── Module load ──────────────────────────────────────────────────────────────

let loaded = false
try {
  // Earlier audit IPC tests load audit.ipc with their own service mocks, and
  // a cached module's captured auditAgentService cannot be rebound — load a
  // fresh instance under THIS file's mocks.
  delete require.cache[require.resolve('../audit.ipc')]
  require('../audit.ipc').registerAuditIpc(mockMainWindow)
  loaded = true
} catch (err) {
  console.error(`audit.ipc load FAILED: ${(err as Error).message}`)
}

function run(over: Record<string, unknown> = {}): any {
  return {
    id: 'run-1',
    workspaceId: 'ws-1',
    kind: 'code',
    mode: 'deep',
    status: 'completed',
    overallScore: 72,
    createdAt: '2026-09-09 10:00:00',
    selectedTracks: ['security'],
    results: [],
    detectedTechs: ['typescript'],
    selectedSkills: {},
    ...over
  }
}

function result(over: Record<string, unknown> = {}): any {
  return {
    id: 'res-1',
    runId: 'run-1',
    trackId: 'security',
    status: 'completed',
    score: 61,
    coverageSufficient: true,
    summary: 'Three injection risks in the SQL layer.',
    findings: [
      {
        id: 'f1',
        severity: 'high',
        title: 'String-concatenated SQL',
        filePath: 'src/db.ts',
        recommendation: 'Use parameterized queries'
      }
    ],
    ...over
  }
}

if (loaded) {
  describe('audit.ipc — getLatest', () => {
    test('a finished run is returned as-is', async () => {
      await runExclusive(async () => {
        auditRepo.getLatestForWorkspace = createSpy(() => run())
        const r = await tryInvokeHandler('audit:getLatest', { workspaceId: 'ws-1' })
        assert.equal(r.ok, true)
        assert.equal((r.result as any).status, 'completed')
      })
    })

    test('a stale "running" run is reconciled to cancelled/partial', async () => {
      await runExclusive(async () => {
        const cancelledResults = [
          result({ id: 'res-run', status: 'running' }),
          result({ id: 'res-pend', status: 'pending' }),
          result({ id: 'res-done', status: 'completed', score: 80 })
        ]
        const stale = run({ status: 'running', results: cancelledResults })
        auditRepo.getLatestForWorkspace = createSpy(() => stale)
        const updateResultCalls: string[] = []
        auditRepo.updateResult = createSpy((id: string) => {
          updateResultCalls.push(id)
          return {}
        })
        auditRepo.updateRun = createSpy((_id: string, patch: any) => ({ ...stale, ...patch }))

        const r = await tryInvokeHandler('audit:getLatest', { workspaceId: 'ws-1' })
        assert.equal(r.ok, true)
        // only the in-flight tracks were cancelled
        assert.deepEqual(updateResultCalls.sort(), ['res-pend', 'res-run'])
        const patch = auditRepo.updateRun.calls[0][1]
        assert.equal(patch.status, 'partial', 'one completed track ⇒ partial, not cancelled')
        assert.equal((r.result as any).status, 'partial')
      })
    })

    test('a stale run with no completed tracks is cancelled outright', async () => {
      await runExclusive(async () => {
        auditRepo.getLatestForWorkspace = createSpy(() =>
          run({ status: 'running', results: [result({ status: 'running', score: null })] })
        )
        auditRepo.updateResult = createSpy(() => ({}))
        auditRepo.updateRun = createSpy((_id: string, patch: any) => ({ status: patch.status }))
        const r = await tryInvokeHandler('audit:getLatest', { workspaceId: 'ws-1' })
        assert.equal(r.ok, true)
        assert.equal(auditRepo.updateRun.calls[0][1].status, 'cancelled')
      })
    })
  })

  describe('audit.ipc — history / delete / cancel', () => {
    test('getHistory forwards the workspace and default limit', async () => {
      await runExclusive(async () => {
        auditRepo.getHistoryForWorkspace = createSpy(() => [run({ id: 'run-old' })])
        const r = await tryInvokeHandler('audit:getHistory', { workspaceId: 'ws-1' })
        assert.equal(r.ok, true)
        assert.equal((r.result as any[]).length, 1)
        assert.deepEqual(auditRepo.getHistoryForWorkspace.calls[0], ['ws-1', 10])
      })
    })

    test('deleteRun requires a runId and reports the outcome', async () => {
      await runExclusive(async () => {
        const missing = await tryInvokeHandler('audit:deleteRun', {})
        assert.equal(missing.ok, false)
        assert.match(String((missing as any).error), /runId/)

        auditRepo.deleteRun = createSpy(() => true)
        const r = await tryInvokeHandler('audit:deleteRun', { runId: 'run-1' })
        assert.equal(r.ok, true)
        assert.deepEqual(r.result, { deleted: true })
      })
    })

    test('cancel delegates to the running agent', async () => {
      await runExclusive(async () => {
        const r = await tryInvokeHandler('audit:cancel')
        assert.equal(r.ok, true)
        assert.equal(auditAgentService.cancel.callCount, 1)
      })
    })
  })

  describe('audit.ipc — rerunTrack guards', () => {
    test('refuses while an audit is running', async () => {
      await runExclusive(async () => {
        auditAgentService.isRunning = true
        try {
          const r = await tryInvokeHandler('audit:rerunTrack', {
            workspaceId: 'ws-1',
            trackId: 'security',
            mode: 'deep'
          })
          assert.equal(r.ok, false)
          assert.match(String((r as any).error), /already running/)
        } finally {
          auditAgentService.isRunning = false
        }
      })
    })

    test('refuses for an unknown workspace or a workspace without a repo', async () => {
      await runExclusive(async () => {
        wsRepo.findById = createSpy(() => null)
        const noWs = await tryInvokeHandler('audit:rerunTrack', {
          workspaceId: 'ws-x',
          trackId: 'security',
          mode: 'deep'
        })
        assert.equal(noWs.ok, false)
        assert.match(String((noWs as any).error), /not found/)

        wsRepo.findById = createSpy(() => ({ id: 'ws-1', repoPath: null }))
        const noRepo = await tryInvokeHandler('audit:rerunTrack', {
          workspaceId: 'ws-1',
          trackId: 'security',
          mode: 'deep'
        })
        assert.equal(noRepo.ok, false)
        assert.match(String((noRepo as any).error), /no repo path/)
      })
    })
  })

  describe('audit.ipc — plans', () => {
    test('getPlans lists the run plans', async () => {
      await runExclusive(async () => {
        auditPlanRepo.getPlansForRun = createSpy(() => [
          { id: 'plan-1', title: 'Security Fix Plan' }
        ])
        const r = await tryInvokeHandler('audit:getPlans', { runId: 'run-1' })
        assert.equal(r.ok, true)
        assert.equal((r.result as any[]).length, 1)
        assert.deepEqual(auditPlanRepo.getPlansForRun.calls[0], ['run-1'])
      })
    })

    test('generatePlan drives the plan generator', async () => {
      await runExclusive(async () => {
        const r = await tryInvokeHandler('audit:generatePlan', {
          workspaceId: 'ws-1',
          runId: 'run-1',
          findings: result().findings
        })
        assert.equal(r.ok, true, String((r as any).error))
        assert.deepEqual(generate.calls[0][0], {
          workspaceId: 'ws-1',
          runId: 'run-1',
          findings: result().findings
        })
      })
    })

    test('exportPlanMarkdown refuses when there is no plan', async () => {
      await runExclusive(async () => {
        auditRepo.getLatestForWorkspace = createSpy(() => run())
        auditPlanRepo.getPlansForRun = createSpy(() => [])
        const r = await tryInvokeHandler('audit:exportPlanMarkdown', { workspaceId: 'ws-1' })
        assert.equal(r.ok, false)
        assert.match(String((r as any).error), /No remediation plan/)
      })
    })

    test('exportMarkdown writes the health report to the chosen file', async () => {
      await runExclusive(async () => {
        const dir = mkdtempSync(join(tmpdir(), 'audit-export-'))
        try {
          const target = join(dir, 'report.md')
          const electron = require('electron')
          const originalDialog = electron.dialog.showSaveDialog
          electron.dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })

          auditRepo.getLatestForWorkspace = createSpy(() =>
            run({ results: [result()], selectedTracks: ['security'] })
          )
          wsRepo.findById = createSpy(() => ({ id: 'ws-1', name: 'Demo Workspace' }))

          const r = await tryInvokeHandler('audit:exportMarkdown', { workspaceId: 'ws-1' })
          assert.equal(r.ok, true, String((r as any).error))
          const written = readFileSync(target, 'utf-8')
          assert.ok(written.includes('# Workspace Health Report'), written)
          assert.ok(written.includes('**Workspace:** Demo Workspace'), written)
          assert.ok(written.includes('String-concatenated SQL'), written)
          assert.ok(written.includes('Use parameterized queries'), written)

          electron.dialog.showSaveDialog = originalDialog
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      })
    })

    test('exportMarkdown refuses when no run exists', async () => {
      await runExclusive(async () => {
        auditRepo.getLatestForWorkspace = createSpy(() => null)
        const r = await tryInvokeHandler('audit:exportMarkdown', { workspaceId: 'ws-1' })
        assert.equal(r.ok, false)
        assert.match(String((r as any).error), /No audit run found/)
      })
    })
  })
} else {
  describe('audit.ipc (load failure — NOT skipped)', () => {
    test('audit.ipc loads under the full mock', () => {
      assert.ok(false, 'audit.ipc must load — a silent skip here is dead coverage')
    })
  })
}

describe('audit.ipc — cleanup', () => {
  test('service mocks unregistered for later files', async () => {
    await runExclusive(async () => {
      unmockService('audit-agent.service')
      unmockService('audit-plan-generator.service')
      unmockService('notification.service')
      assert.ok(true)
    })
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
