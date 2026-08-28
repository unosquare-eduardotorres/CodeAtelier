/**
 * M7 — adversarial code-review phase.
 *
 * Covers:
 * - parseCodeReviewFindings (defensive parsing, verdict derivation)
 * - findings → fix tasks mapping (severity threshold, BP-COLLISION-SAFE-RENUMBER,
 *   wave assignment, MAX_FIX_TASKS bound)
 * - re-review-once bound (second fix_required → ledger, never a loop)
 * - disabled-role skip (settleOptionalPhases — covered in depth by
 *   blueprint-code-review-skip.test.ts; here just the integration contract)
 * - adapter construction (external-reviewer stance, diff injection)
 *
 * The full agent-session lifecycle is not driven here — it needs a live LLM.
 * These tests pin the deterministic logic around it.
 *
 * Run: tsx src/main/services/__tests__/blueprint-code-review.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

let env: { db: import('better-sqlite3').Database; wsId: string } | null = null
let blueprintRepository: any
let blueprintTaskRepository: any
let blueprintPhaseRepository: any
let modelConfigService: any
let parseCodeReviewFindings: any

try {
  const helper = require('../../db/repositories/__tests__/db-test-helper')
  env = helper.attachTestDb()
  const repos = require('../../db/repositories/blueprint.repository')
  blueprintRepository = repos.blueprintRepository
  blueprintTaskRepository = repos.blueprintTaskRepository
  blueprintPhaseRepository = repos.blueprintPhaseRepository
  modelConfigService = require('../model-config.service').modelConfigService
  const svc = require('../blueprint-code-review.service')
  parseCodeReviewFindings = svc.parseCodeReviewFindings
} catch (err) {
  console.log(`⚠ code-review setup failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
  env = null
}

if (!env) {
  describe('code-review phase (skipped — no DB)', () => {
    test('findings parsing', () => {}, { skipReason: 'no DB' })
  })
} else {
  const wsId = env.wsId

  /**
   * Shared-runner guard (same rationale as blueprint-code-review-skip.test.ts):
   * files that run setupFullMock() can leave the blueprintService singleton
   * mock-bound for the rest of the process, in which case rows seeded through
   * the real repositories are invisible to it. Probe once; skip the
   * service-dependent block when mock-bound. The pure-logic blocks
   * (parsing, adapter) still run — they don't touch the service.
   */
  const serviceIsLive = (() => {
    try {
      const probe = blueprintRepository.create({ workspaceId: wsId, title: 'liveness probe' })
      const blueprintService = require('../blueprint.service').blueprintService
      return blueprintService.getBlueprint(probe.id)?.id === probe.id
    } catch {
      return false
    }
  })()

  function withRoleEnabled<T>(enabled: boolean, fn: () => T): T {
    const original = modelConfigService.isRoleEnabled
    modelConfigService.isRoleEnabled = (_ws: string | undefined, action: string) =>
      action === 'blueprint:code-review' ? enabled : original(_ws, action)
    try {
      return fn()
    } finally {
      modelConfigService.isRoleEnabled = original
    }
  }

  // ── Findings parsing ──

  describe('M7.1 — parseCodeReviewFindings', () => {
    test('parses a well-formed findings array with verdict', () => {
      const result = parseCodeReviewFindings({
        findings: [
          { file: 'src/a.ts', line: 10, severity: 'critical', summary: 'SQL injection', suggestedFix: 'Use prepared statements' },
          { file: 'src/b.ts', severity: 'medium', summary: 'Missing test' }
        ],
        verdict: 'fix_required'
      })
      assert.equal(result.verdict, 'fix_required')
      assert.equal(result.findings.length, 2)
      assert.equal(result.findings[0].severity, 'critical')
      assert.equal(result.findings[0].line, 10)
      assert.equal(result.findings[1].severity, 'medium')
      assert.equal(result.findings[1].line, undefined)
    })

    test('entries without file or summary are dropped', () => {
      const result = parseCodeReviewFindings({
        findings: [
          { severity: 'high', summary: 'no file' },
          { file: 'src/a.ts', severity: 'high' }, // no summary
          { file: 'src/ok.ts', severity: 'high', summary: 'fine' }
        ],
        verdict: 'approve'
      })
      assert.equal(result.findings.length, 1)
      assert.equal(result.findings[0].file, 'src/ok.ts')
    })

    test('unknown severity degrades to medium, unknown verdict derives from findings', () => {
      const result = parseCodeReviewFindings({
        findings: [{ file: 'src/a.ts', severity: 'catastrophic', summary: 'weird' }],
        verdict: 'ship-it'
      })
      assert.equal(result.findings[0].severity, 'medium')
      // no critical/high → concerns_noted, never fix_required from a bad verdict
      assert.equal(result.verdict, 'concerns_noted')
    })

    test('missing verdict with critical finding derives fix_required', () => {
      const result = parseCodeReviewFindings({
        findings: [{ file: 'src/a.ts', severity: 'critical', summary: 'RCE' }]
      })
      assert.equal(result.verdict, 'fix_required')
    })

    test('null completion and non-array findings → null', () => {
      assert.equal(parseCodeReviewFindings(null), null)
      assert.equal(parseCodeReviewFindings({ findings: 'nope' }), null)
    })
  })

  // ── Findings → fix tasks (M7.3) ──

  describe('M7.3 — findings → fix tasks mapping', () => {
    /**
     * Drive dispatchFixTasksAndRereview directly. Returns the blueprint id so
     * each test owns its own row (the harness runs tests concurrently — no
     * shared mutable state).
     */
    async function dispatchFixTasks(
      review: any,
      opts: { fixRound?: number; seedTasks?: boolean } = {}
    ): Promise<{ dispatched: boolean; blueprintId: string }> {
      const { blueprintCodeReviewService } = require('../blueprint-code-review.service')
      const svc: any = blueprintCodeReviewService
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Fix task test' })
      if (opts.fixRound != null) {
        blueprintRepository.update(bp.id, {
          settingsJson: { codeReviewFixRound: opts.fixRound }
        })
      }
      if (opts.seedTasks !== false) {
        // Seed existing tasks: T001 wave 1, R001 wave 2 (collision test)
        blueprintTaskRepository.createBulk(bp.id, [
          { taskId: 'T001', wave: 1, description: 'build task', filePathsJson: ['src/a.ts'] },
          { taskId: 'R001', wave: 2, description: 'prior fix', filePathsJson: ['src/b.ts'] }
        ])
      }

      const dispatched = await svc.dispatchFixTasksAndRereview({
        blueprintId: bp.id,
        workspaceId: wsId,
        workspacePath: '/tmp/nonexistent',
        review
      })
      return { dispatched, blueprintId: bp.id }
    }

    test('critical/high findings become R-tasks after existing R-tasks; medium/low do not', async () => {
      const { blueprintId } = await dispatchFixTasks({
        findings: [
          { file: 'src/a.ts', line: 1, severity: 'critical', summary: 'bad', suggestedFix: 'fix it' },
          { file: 'src/b.ts', severity: 'high', summary: 'also bad' },
          { file: 'src/c.ts', severity: 'medium', summary: 'meh' },
          { file: 'src/d.ts', severity: 'low', summary: 'style' }
        ],
        verdict: 'fix_required'
      })

      const tasks = blueprintTaskRepository.findByBlueprint(blueprintId)
      const rTasks = tasks.filter((t: any) => /^R\d+$/.test(t.taskId))
      assert.ok(rTasks.some((t: any) => t.taskId === 'R002'), 'continues after R001')
      assert.ok(rTasks.some((t: any) => t.taskId === 'R003'), 'second fix task')
      assert.ok(
        !rTasks.some((t: any) => t.description.includes('meh')),
        'medium findings never become tasks'
      )
      const r002 = rTasks.find((t: any) => t.taskId === 'R002')
      assert.equal(r002.wave, 3, 'fix wave follows the max existing wave')
      assert.ok(r002.description.includes('[code-review fix] critical'), 'description carries severity')
      assert.deepEqual(r002.filePathsJson, ['src/a.ts'])
    })

    test('no fixable findings → no tasks, no dispatch', async () => {
      const { dispatched, blueprintId } = await dispatchFixTasks({
        findings: [{ file: 'src/x.ts', severity: 'low', summary: 'style' }],
        verdict: 'concerns_noted'
      })
      assert.equal(dispatched, false)
      assert.equal(
        blueprintTaskRepository.findByBlueprint(blueprintId).length,
        2,
        'only the seeded tasks exist — none added'
      )
    })

    test('re-review-once bound: fix round already ran → surviving findings go to the ledger, no new tasks', async () => {
      const { dispatched, blueprintId } = await dispatchFixTasks(
        {
          findings: [{ file: 'src/a.ts', severity: 'critical', summary: 'still broken' }],
          verdict: 'fix_required'
        },
        { fixRound: 1 }
      )
      assert.equal(dispatched, false, 'second round never dispatches')
      const tasks = blueprintTaskRepository.findByBlueprint(blueprintId)
      assert.equal(
        tasks.filter((t: any) => /^R\d+$/.test(t.taskId)).length,
        1,
        'only the seeded R001 — no new R-tasks on the bounded round'
      )
      const rec = blueprintRepository.findById(blueprintId)
      const ledger = rec.unverifiedJson ?? []
      assert.ok(
        ledger.some(
          (i: any) => i.reason === 'finding_unresolved' && i.detail.includes('still broken')
        ),
        'surviving finding recorded as unverified'
      )
    })

    test('MAX_FIX_TASKS bounds the fix wave', async () => {
      const findings = Array.from({ length: 15 }, (_, i) => ({
        file: `src/f${i}.ts`,
        severity: 'high',
        summary: `problem ${i}`
      }))
      const { blueprintId } = await dispatchFixTasks({ findings, verdict: 'fix_required' })
      const tasks = blueprintTaskRepository.findByBlueprint(blueprintId)
      assert.equal(
        tasks.filter((t: any) => /^R\d+$/.test(t.taskId)).length,
        11,
        'fix wave capped at 10 (plus the seeded R001)'
      )
    })
  })

  // ── Disabled-role skip (integration contract) ──

  if (!serviceIsLive) {
    describe('M7.4 — disabled-role skip contract (skipped — service mock-bound)', () => {
      test('settleOptionalPhases marks the record skipped when the role is off', () => {}, {
        skipReason: 'blueprintService singleton is mock-bound in this process'
      })
    })
  } else {
    describe('M7.4 — disabled-role skip contract', () => {
      test('settleOptionalPhases marks the record skipped when the role is off', () => {
        const { blueprintService } = require('../blueprint.service')
        const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Skip contract' })
        blueprintPhaseRepository.createAllPhases(bp.id)

        withRoleEnabled(false, () => blueprintService.settleOptionalPhases(bp.id))

        const rec = blueprintPhaseRepository.findByBlueprintAndPhase(bp.id, 'code-review')
        assert.equal(rec.status, 'skipped')
      })
    })
  }

  // ── Adapter (M7.2) ──

  describe('M7.2 — BlueprintCodeReviewAdapter', () => {
    test('external-reviewer stance: diff injected into the phase message, not artifacts', () => {
      const { BlueprintCodeReviewAdapter } = require('../role-adapters/blueprint/blueprint-code-review.adapter')
      const adapter = new BlueprintCodeReviewAdapter({
        workspaceId: 'ws-1',
        blueprintId: 'bp-1',
        phaseContext: {
          blueprint: { id: 'bp-1', title: 'T' },
          constitution: null,
          previousArtifacts: [],
          specFilePath: '',
          blueprintDir: '',
          grillDecisions: [],
          workspaceDocs: ''
        },
        diff: 'diff --git a/src/a.ts b/src/a.ts\n+export const a = 1'
      })
      const msg = adapter.getPhaseMessage()
      assert.ok(msg.includes('FEATURE DIFF'), 'diff is injected into the message')
      assert.ok(msg.includes('export const a = 1'), 'diff content present')
      assert.ok(msg.includes('external reviewer'), 'stance stated')
      assert.ok(msg.includes('blueprint-phase-complete'), 'completion block requested')
    })

    test('empty diff renders an explicit empty marker', () => {
      const { BlueprintCodeReviewAdapter } = require('../role-adapters/blueprint/blueprint-code-review.adapter')
      const adapter = new BlueprintCodeReviewAdapter({
        workspaceId: 'ws-1',
        blueprintId: 'bp-1',
        phaseContext: {
          blueprint: { id: 'bp-1', title: 'T' },
          constitution: null,
          previousArtifacts: [],
          specFilePath: '',
          blueprintDir: '',
          grillDecisions: [],
          workspaceDocs: ''
        },
        diff: ''
      })
      assert.ok(adapter.getPhaseMessage().includes('(empty diff'))
    })
  })

  // ── Helpers ──
}

if (import.meta.url === `file://${process.argv[1]}`) void summaryAsync()
