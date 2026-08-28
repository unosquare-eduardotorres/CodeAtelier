/**
 * M6.1/M6.3 — post-verify lead-review pass.
 *
 * Covers:
 * - findings → R-tasks mapping (BP-COLLISION-SAFE-RENUMBER, wave assignment,
 *   MAX_FIX_TASKS bound, description carries category + requiredChange)
 * - round bound (leadReviewRound ≥ 1 → survivors to the ledger, never a loop)
 * - verdict gating (approved requires zero findings — via parseLeadReview)
 * - disabled skip (leadReviewPass off → verify completes without dispatching)
 * - adapter construction (lead rubric + verify summary + diff injection)
 * - goal condition shape
 *
 * The full agent-session lifecycle is not driven here — it needs a live LLM.
 * These tests pin the deterministic logic around it.
 *
 * Run: tsx src/main/services/__tests__/blueprint-lead-review.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

let env: { db: import('better-sqlite3').Database; wsId: string } | null = null
let blueprintRepository: any
let blueprintTaskRepository: any
let blueprintPhaseRepository: any

try {
  const helper = require('../../db/repositories/__tests__/db-test-helper')
  env = helper.attachTestDb()
  const repos = require('../../db/repositories/blueprint.repository')
  blueprintRepository = repos.blueprintRepository
  blueprintTaskRepository = repos.blueprintTaskRepository
  blueprintPhaseRepository = repos.blueprintPhaseRepository
} catch (err) {
  console.log(`⚠ lead-review setup failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
  env = null
}

if (!env) {
  describe('lead-review pass (skipped — no DB)', () => {
    test('findings mapping', () => {}, { skipReason: 'no DB' })
  })
} else {
  const wsId = env.wsId

  /**
   * Shared-runner guard (same rationale as blueprint-code-review.test.ts):
   * files that run setupFullMock() can leave the blueprintService singleton
   * mock-bound for the rest of the process. dispatchFixTasks touches
   * blueprintService only on the dispatch path (which these tests never take —
   * the fix wave is dispatched with a nonexistent workspacePath and the
   * dispatch failure falls back to the ledger), so no probe is needed here.
   */

  // ── Findings → fix tasks (M6.1) ──

  describe('M6.1 — findings → R-tasks mapping', () => {
    /**
     * Drive dispatchFixTasks directly. Each test owns its own blueprint row.
     */
    async function dispatchFixTasks(
      review: any,
      opts: { leadReviewRound?: number; seedTasks?: boolean } = {}
    ): Promise<{ dispatched: boolean; blueprintId: string }> {
      const { blueprintLeadReviewService } = require('../blueprint-lead-review.service')
      const svc: any = blueprintLeadReviewService
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Lead fix task test' })
      if (opts.leadReviewRound != null) {
        blueprintRepository.update(bp.id, {
          settingsJson: { leadReviewRound: opts.leadReviewRound }
        })
      }
      if (opts.seedTasks !== false) {
        // Seed existing tasks: T001 wave 1, R001 wave 2 (collision test)
        blueprintTaskRepository.createBulk(bp.id, [
          { taskId: 'T001', wave: 1, description: 'build task', filePathsJson: ['src/a.ts'] },
          { taskId: 'R001', wave: 2, description: 'prior fix', filePathsJson: ['src/b.ts'] }
        ])
      }

      const dispatched = await svc.dispatchFixTasks({
        blueprintId: bp.id,
        workspaceId: wsId,
        workspacePath: '/tmp/nonexistent',
        review
      })
      return { dispatched, blueprintId: bp.id }
    }

    test('findings become R-tasks after existing R-tasks, wave follows the max', async () => {
      const { blueprintId } = await dispatchFixTasks({
        verdict: 'changes-required',
        findings: [
          {
            category: 'spec-drift',
            file: 'src/greet.ts',
            location: 'handleGreeting()',
            issue: 'Ignores the spec name parameter',
            requiredChange: 'Thread the name parameter into buildGreeting()',
            howVerified: 'GET /hello?name=Ada returns Hello, Ada'
          },
          {
            category: 'test-gaming',
            file: 'src/greet.test.ts',
            issue: 'Asserts on a hardcoded value the implementation also hardcodes',
            requiredChange: 'Assert against a computed expectation'
          }
        ],
        rejected: []
      })

      const tasks = blueprintTaskRepository.findByBlueprint(blueprintId)
      const rTasks = tasks.filter((t: any) => /^R\d+$/.test(t.taskId))
      assert.ok(rTasks.some((t: any) => t.taskId === 'R002'), 'continues after R001')
      assert.ok(rTasks.some((t: any) => t.taskId === 'R003'), 'second fix task')
      const r002 = rTasks.find((t: any) => t.taskId === 'R002')
      assert.equal(r002.wave, 3, 'fix wave follows the max existing wave')
      assert.ok(
        r002.description.includes('[lead-review fix] spec-drift'),
        'description carries the category'
      )
      assert.ok(
        r002.description.includes('Thread the name parameter'),
        'description carries the requiredChange'
      )
      assert.ok(
        r002.description.includes('How to verify: GET /hello?name=Ada'),
        'description carries howVerified when present'
      )
      assert.deepEqual(r002.filePathsJson, ['src/greet.ts'])
    })

    test('approved verdict → no tasks, no dispatch', async () => {
      const { dispatched, blueprintId } = await dispatchFixTasks({
        verdict: 'approved',
        findings: [],
        rejected: []
      })
      assert.equal(dispatched, false)
      assert.equal(
        blueprintTaskRepository.findByBlueprint(blueprintId).length,
        2,
        'only the seeded tasks exist — none added'
      )
    })

    test('round bound: leadReviewRound already set → survivors to the ledger, no new tasks', async () => {
      const { dispatched, blueprintId } = await dispatchFixTasks(
        {
          verdict: 'changes-required',
          findings: [
            {
              category: 'correctness',
              file: 'src/x.ts',
              issue: 'Race on the counter',
              requiredChange: 'Guard the increment with the existing mutex'
            }
          ],
          rejected: []
        },
        { leadReviewRound: 1 }
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
          (i: any) =>
            i.gate === 'lead-review-pass' &&
            i.reason === 'finding_unresolved' &&
            i.detail.includes('Race on the counter')
        ),
        'surviving finding recorded as unverified under the lead-review-pass gate'
      )
    })

    test('MAX_FIX_TASKS bounds the fix wave', async () => {
      const findings = Array.from({ length: 15 }, (_, i) => ({
        category: 'stub-residue',
        file: `src/f${i}.ts`,
        issue: `TODO left behind ${i}`,
        requiredChange: `Implement it ${i}`
      }))
      const { blueprintId } = await dispatchFixTasks({
        verdict: 'changes-required',
        findings,
        rejected: []
      })
      const tasks = blueprintTaskRepository.findByBlueprint(blueprintId)
      assert.equal(
        tasks.filter((t: any) => /^R\d+$/.test(t.taskId)).length,
        11,
        'fix wave capped at 10 (plus the seeded R001)'
      )
    })
  })

  // ── Verdict gating (M6.2 contract, restated for the pass) ──

  describe('M6.1 — verdict gating via parseLeadReview', () => {
    const { parseLeadReview } = require('../../../shared/blueprint-artifact-parsers')

    const block = (body: Record<string, unknown>): string =>
      '```blueprint-review-findings\n' + JSON.stringify(body) + '\n```'

    const finding = (): Record<string, unknown> => ({
      category: 'spec-drift',
      file: 'src/a.ts',
      issue: 'Diverges from the spec',
      requiredChange: 'Match the spec'
    })

    test('approved requires the stated verdict AND zero findings', () => {
      const approved = parseLeadReview(
        block({ verdict: 'approved', findings: [] })
      )
      assert.equal(approved.verdict, 'approved')

      const notReally = parseLeadReview(
        block({ verdict: 'approved', findings: [finding()] })
      )
      assert.equal(
        notReally.verdict,
        'changes-required',
        '"approved, but change this" is not an approval'
      )
    })

    test('missing verdict or missing block → changes-required', () => {
      assert.equal(
        parseLeadReview(block({ findings: [] })).verdict,
        'changes-required'
      )
      assert.equal(parseLeadReview('no block at all').verdict, 'changes-required')
    })

    test('off-rubric findings are rejected, never passed to the builder', () => {
      const result = parseLeadReview(
        block({
          verdict: 'changes-required',
          findings: [
            { ...finding(), category: 'style' },
            { ...finding(), category: 'correctness' }
          ]
        })
      )
      assert.equal(result.findings.length, 1, 'only the on-rubric finding survives')
      assert.equal(result.rejected.length, 1, 'the off-rubric finding is surfaced as rejected')
    })
  })

  // ── Disabled skip (settings gate) ──

  describe('M6.1 — settings gate (disabled skip contract)', () => {
    test('leadReviewPass defaults OFF — absent setting means no pass', () => {
      // The verify service checks wsSettings.leadReviewPass === true; anything
      // else (absent, false, wrong type) skips the pass. Pin the semantics the
      // service dispatch relies on.
      const eligible = (wsSettings: Record<string, unknown>, round: unknown): boolean => {
        if (wsSettings.leadReviewPass !== true) return false
        return typeof round !== 'number' || (round as number) < 2
      }
      assert.equal(eligible({}, undefined), false, 'absent → off')
      assert.equal(eligible({ leadReviewPass: false }, undefined), false, 'false → off')
      assert.equal(eligible({ leadReviewPass: 'yes' }, undefined), false, 'wrong type → off')
      assert.equal(eligible({ leadReviewPass: true }, undefined), true, 'on, no round → dispatch')
      assert.equal(eligible({ leadReviewPass: true }, 0), true, 'on, round 0 → dispatch')
      assert.equal(eligible({ leadReviewPass: true }, 1), true, 'on, round 1 → round-2 check')
      assert.equal(eligible({ leadReviewPass: true }, 2), false, 'on, round 2 → settled')
    })

    test('WorkspaceSettings.leadReviewPass is declared next to gateCommands', () => {
      // Type-level contract: the setting exists on the shared type. Reading the
      // compiled interface via a settings object round-trip.
      const settings: import('../../../shared/types').WorkspaceSettings = {
        gateCommands: { test: { command: 'npm test' } },
        leadReviewPass: true
      }
      assert.equal(settings.leadReviewPass, true)
    })
  })

  // ── Adapter (M6.1) ──

  describe('M6.1 — BlueprintLeadReviewAdapter', () => {
    const phaseContext = {
      blueprint: { id: 'bp-1', title: 'T' },
      constitution: null,
      previousArtifacts: [],
      specFilePath: '',
      blueprintDir: '',
      grillDecisions: [],
      workspaceDocs: ''
    }

    test('lead stance: rubric + verify summary + diff injected into the phase message', () => {
      const { BlueprintLeadReviewAdapter } = require('../role-adapters/blueprint/blueprint-lead-review.adapter')
      const adapter = new BlueprintLeadReviewAdapter({
        workspaceId: 'ws-1',
        blueprintId: 'bp-1',
        phaseContext,
        diff: 'diff --git a/src/a.ts b/src/a.ts\n+export const a = 1',
        verifySummary: 'overallStatus: passed'
      })
      const msg = adapter.getPhaseMessage()
      assert.ok(msg.includes('FEATURE DIFF'), 'diff is injected into the message')
      assert.ok(msg.includes('export const a = 1'), 'diff content present')
      assert.ok(msg.includes('spec-drift') && msg.includes('test-gaming'), 'rubric stated')
      assert.ok(msg.includes('overallStatus: passed'), 'verify summary present')
      assert.ok(msg.includes('blueprint-review-findings'), 'findings block requested')
      assert.ok(msg.includes('lead reviewer'), 'stance stated')
    })

    test('empty diff renders an explicit empty marker', () => {
      const { BlueprintLeadReviewAdapter } = require('../role-adapters/blueprint/blueprint-lead-review.adapter')
      const adapter = new BlueprintLeadReviewAdapter({
        workspaceId: 'ws-1',
        blueprintId: 'bp-1',
        phaseContext,
        diff: '',
        verifySummary: ''
      })
      assert.ok(adapter.getPhaseMessage().includes('(empty diff'))
    })

    test('model action is blueprint:lead-review (mandatory role, never optional)', () => {
      const { BlueprintLeadReviewAdapter } = require('../role-adapters/blueprint/blueprint-lead-review.adapter')
      const { isOptionalRoleAction } = require('../../../shared/model-role-binding')
      const adapter: any = new BlueprintLeadReviewAdapter({
        workspaceId: 'ws-1',
        blueprintId: 'bp-1',
        phaseContext,
        diff: '',
        verifySummary: ''
      })
      assert.equal(adapter.getModelAction(), 'blueprint:lead-review')
      assert.equal(
        isOptionalRoleAction('blueprint:lead-review'),
        false,
        'lead-review stays mandatory — the escalation ladder depends on it'
      )
    })
  })

  // ── Goal condition ──

  describe('M6.1 — buildLeadReviewPassGoalCondition', () => {
    test('names the rubric, the finding contract, and the verdict rule', () => {
      const { buildLeadReviewPassGoalCondition } = require('../blueprint-goal-conditions')
      const goal = buildLeadReviewPassGoalCondition('Test Feature')
      assert.ok(goal.includes('Test Feature'))
      assert.ok(goal.includes('spec-drift'))
      assert.ok(goal.includes('test-gaming'))
      assert.ok(goal.includes('blueprint-review-findings'))
      assert.ok(goal.includes('approved only when there are zero findings'))
    })
  })

  // ── Pass artifact persistence ──

  describe('M6.1 — pass artifact lands on the verify phase record', () => {
    test('appendPassArtifact appends type lead-review-pass to verify artifacts', () => {
      const { blueprintLeadReviewService } = require('../blueprint-lead-review.service')
      const svc: any = blueprintLeadReviewService
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Artifact test' })
      blueprintPhaseRepository.createAllPhases(bp.id)

      svc.appendPassArtifact(bp.id, { findings: [], verdict: 'approved', rejected: [] })

      const verifyPhase = blueprintPhaseRepository.findByBlueprintAndPhase(bp.id, 'verify')
      const artifacts = verifyPhase.artifactsJson ?? []
      assert.ok(
        artifacts.some((a: any) => a.type === 'lead-review-pass'),
        'lead-review-pass artifact appended to the verify phase record'
      )
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) void summaryAsync()
