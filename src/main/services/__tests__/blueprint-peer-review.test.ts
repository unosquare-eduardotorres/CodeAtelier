/**
 * M5 — per-task advisory peer review.
 *
 * Covers:
 * - findings → advisory-fix mapping (findings become fix instructions, not
 *   R-tasks — the fix attempt is appended to the task's retry ladder)
 * - one-round bound (PEER_REVIEW_MAX_ROUNDS = 1; survivors → ledger, never a loop)
 * - disabled-role skip (isRoleEnabled false → no pass, no cost)
 * - adapter stance (peer rubric + packet + write-set-scoped diff injection)
 * - off-rubric rejection integration (parsePeerReview drops non-rubric findings)
 * - goal condition shape
 *
 * The full agent-session lifecycle is not driven here — it needs a live LLM.
 * These tests pin the deterministic logic around it.
 *
 * Run: tsx src/main/services/__tests__/blueprint-peer-review.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

let env: { db: import('better-sqlite3').Database; wsId: string } | null = null
let blueprintRepository: any
let blueprintTaskRepository: any

try {
  const helper = require('../../db/repositories/__tests__/db-test-helper')
  env = helper.attachTestDb()
  const repos = require('../../db/repositories/blueprint.repository')
  blueprintRepository = repos.blueprintRepository
  blueprintTaskRepository = repos.blueprintTaskRepository
} catch (err) {
  console.log(`⚠ peer-review setup failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
  env = null
}

if (!env) {
  describe('peer-review pass (skipped — no DB)', () => {
    test('findings mapping', () => {}, { skipReason: 'no DB' })
  })
} else {
  const wsId = env.wsId

  // ── Findings → advisory fix (M5.3) ──

  describe('M5 — findings → advisory fix mapping', () => {
    /**
     * The build service formats findings as fix instructions for ONE retry
     * attempt. Drive the formatter directly — it is the deterministic core of
     * the advisory round.
     */
    function fixInstructions(findings: any[]): string {
      // The real formatter from the build service — the deterministic core of
      // the advisory round.
      const { buildPeerReviewFixInstructions } = require('../blueprint-build.service')
      return buildPeerReviewFixInstructions(findings)
    }

    test('findings become mechanical fix instructions, not new tasks', async () => {
      const instructions = fixInstructions([
        {
          category: 'ac-coverage',
          file: 'src/config.ts',
          location: 'parseConfig',
          issue: 'AC-2 requires env overrides but the diff hardcodes defaults',
          requiredChange: 'Read DATABASE_URL from process.env with the packet fallback',
          howVerified: 'npm test -- config'
        }
      ])
      assert.ok(instructions.includes('ac-coverage'), 'category present')
      assert.ok(instructions.includes('src/config.ts'), 'file present')
      assert.ok(instructions.includes('parseConfig'), 'location present when given')
      assert.ok(instructions.includes('Read DATABASE_URL'), 'requiredChange present')
      assert.ok(instructions.includes('npm test -- config'), 'howVerified present when given')
      assert.ok(instructions.includes('advisory'), 'advisory framing stated')
    })

    test('empty findings → no fix attempt', () => {
      assert.equal(fixInstructions([]), '')
    })

    test('the advisory round never creates R-tasks (unlike lead/code review)', async () => {
      // Contract: peer-review findings ride the task's existing retry ladder.
      // Seed a blueprint + task and assert the peer-review service exposes no
      // task-creation path — only recordSurvivingFindings writes, and only to
      // the ledger.
      const { blueprintPeerReviewService } = require('../blueprint-peer-review.service')
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Peer advisory test' })
      blueprintTaskRepository.createBulk(bp.id, [
        { taskId: 'T001', wave: 1, description: 'build task', filePathsJson: ['src/a.ts'] }
      ])

      const svc: any = blueprintPeerReviewService
      svc.recordSurvivingFindings(bp.id, 'T001', [
        {
          category: 'stub-residue',
          file: 'src/a.ts',
          issue: 'TODO left behind',
          requiredChange: 'Implement it'
        }
      ])

      const tasks = blueprintTaskRepository.findByBlueprint(bp.id)
      assert.equal(tasks.length, 1, 'no new tasks — the advisory round is not a wave')

      const ledger = blueprintRepository.findById(bp.id).unverifiedJson ?? []
      assert.ok(
        ledger.some(
          (i: any) =>
            i.taskId === 'T001' &&
            i.gate === 'peer-review' &&
            i.reason === 'finding_unresolved' &&
            i.detail.includes('TODO left behind')
        ),
        'surviving finding recorded to the ledger under the peer-review gate'
      )
    })
  })

  // ── One-round bound (M5.3) ──

  describe('M5 — one-round bound', () => {
    test('PEER_REVIEW_MAX_ROUNDS is 1 — the advisory round cannot loop', () => {
      const { PEER_REVIEW_MAX_ROUNDS } = require('../../../shared/task-review-types')
      assert.equal(PEER_REVIEW_MAX_ROUNDS, 1)
    })

    test('no-git baseline → ledger entry, empty outcome, no fix dispatch', async () => {
      const { blueprintPeerReviewService } = require('../blueprint-peer-review.service')
      const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Peer no-git test' })
      blueprintTaskRepository.createBulk(bp.id, [
        { taskId: 'T001', wave: 1, description: 'build task', filePathsJson: ['src/a.ts'] }
      ])
      const created = blueprintTaskRepository.findByBlueprint(bp.id)[0]

      const outcome = await (blueprintPeerReviewService as any).reviewTask({
        task: created,
        blueprintId: bp.id,
        workspaceId: wsId,
        workspacePath: '/tmp/nonexistent',
        executionPath: '/tmp/nonexistent',
        baselineCommit: null
      })

      assert.equal(outcome.fixDispatched, false, 'nothing to fix without a diff')
      assert.equal(outcome.review.findings.length, 0)
      const ledger = blueprintRepository.findById(bp.id).unverifiedJson ?? []
      assert.ok(
        ledger.some((i: any) => i.gate === 'peer-review' && i.reason === 'no_git'),
        'missing baseline recorded honestly as unverified'
      )
    })
  })

  // ── Disabled-role skip ──

  describe('M5 — disabled-role skip', () => {
    test('blueprint:peer-review is an optional role — off unless bound', () => {
      const { isOptionalRoleAction } = require('../../../shared/model-role-binding')
      assert.equal(
        isOptionalRoleAction('blueprint:peer-review'),
        true,
        'peer-review is optional — unbound workspaces skip the pass entirely'
      )
    })

    test('isRoleEnabled returns false for an unbound workspace (the dispatch guard)', () => {
      const { modelConfigService } = require('../model-config.service')
      // No modelRoles bound on this test workspace → optional role resolves off.
      const enabled = modelConfigService.isRoleEnabled('/tmp/nonexistent', 'blueprint:peer-review')
      assert.equal(enabled, false, 'unbound optional role → disabled → no pass, no cost')
    })
  })

  // ── Adapter stance ──

  describe('M5 — BlueprintPeerReviewAdapter', () => {
    const phaseContext = {
      blueprint: { id: 'bp-1', title: 'T' },
      constitution: null,
      previousArtifacts: [],
      specFilePath: '',
      blueprintDir: '',
      grillDecisions: [],
      workspaceDocs: ''
    }

    test('peer stance: rubric + packet + write-set-scoped diff injected', () => {
      const { BlueprintPeerReviewAdapter } = require('../role-adapters/blueprint/blueprint-peer-review.adapter')
      const adapter = new BlueprintPeerReviewAdapter({
        workspaceId: 'ws-1',
        blueprintId: 'bp-1',
        phaseContext,
        diff: 'diff --git a/src/a.ts b/src/a.ts\n+export const a = 1',
        packet: {
          allowedFiles: ['src/a.ts'],
          forbiddenFiles: [],
          testFiles: [],
          acceptanceCriteria: [{ text: 'AC-1: config loads', howVerified: 'npm test' }],
          testCommand: 'npm test'
        },
        taskDescription: 'Implement config loading'
      })
      const msg = adapter.getPhaseMessage()
      assert.ok(msg.includes('TASK DIFF'), 'diff is injected into the message')
      assert.ok(msg.includes('export const a = 1'), 'diff content present')
      assert.ok(
        msg.includes('ac-coverage') && msg.includes('packet-compliance'),
        'peer rubric stated'
      )
      assert.ok(
        msg.includes('stub-residue') && msg.includes('write-set'),
        'all four rubric categories stated'
      )
      assert.ok(msg.includes('AC-1: config loads'), 'packet acceptance criteria injected')
      assert.ok(msg.includes('blueprint-review-findings'), 'findings block requested')
      assert.ok(msg.includes('peer reviewer'), 'stance stated')
      assert.ok(
        /style opinions/i.test(msg) && /not\s+findings/i.test(msg),
        'style-opinion exclusion stated'
      )
    })

    test('missing packet renders an explicit marker, not a crash', () => {
      const { BlueprintPeerReviewAdapter } = require('../role-adapters/blueprint/blueprint-peer-review.adapter')
      const adapter = new BlueprintPeerReviewAdapter({
        workspaceId: 'ws-1',
        blueprintId: 'bp-1',
        phaseContext,
        diff: '',
        packet: null,
        taskDescription: 'Legacy task'
      })
      const msg = adapter.getPhaseMessage()
      assert.ok(msg.includes('no work packet'), 'absent packet is explicit')
      assert.ok(msg.includes('(empty diff'), 'empty diff is explicit')
    })

    test('model action is blueprint:peer-review (optional role)', () => {
      const { BlueprintPeerReviewAdapter } = require('../role-adapters/blueprint/blueprint-peer-review.adapter')
      const adapter: any = new BlueprintPeerReviewAdapter({
        workspaceId: 'ws-1',
        blueprintId: 'bp-1',
        phaseContext,
        diff: '',
        packet: null,
        taskDescription: 'T'
      })
      assert.equal(adapter.getModelAction(), 'blueprint:peer-review')
    })
  })

  // ── Off-rubric rejection integration ──

  describe('M5 — off-rubric rejection (parsePeerReview integration)', () => {
    const { parsePeerReview } = require('../../../shared/blueprint-artifact-parsers')

    const block = (body: Record<string, unknown>): string =>
      '```blueprint-review-findings\n' + JSON.stringify(body) + '\n```'

    const finding = (category: string): Record<string, unknown> => ({
      category,
      file: 'src/a.ts',
      issue: 'Something concrete',
      requiredChange: 'Make the exact change'
    })

    test('peer rubric is closed: off-rubric findings rejected with a reason', () => {
      const result = parsePeerReview(
        block({
          findings: [finding('spec-drift'), finding('stub-residue'), finding('style')]
        })
      )
      // spec-drift is LEAD-only — the peer rubric is the narrower set.
      assert.equal(result.findings.length, 1, 'only the on-rubric finding survives')
      assert.equal(result.findings[0].category, 'stub-residue')
      assert.equal(result.rejected.length, 2, 'off-rubric findings surfaced as rejected')
      assert.ok(
        result.rejected.every((r: any) => typeof r.reason === 'string' && r.reason.length > 0),
        'every rejection carries a reason'
      )
    })

    test('empty findings array is a valid clean result', () => {
      const result = parsePeerReview(block({ findings: [] }))
      assert.equal(result.findings.length, 0)
      assert.equal(result.rejected.length, 0)
    })

    test('missing block → empty result (no findings, no crash)', () => {
      const result = parsePeerReview('the model rambled without a block')
      assert.equal(result.findings.length, 0)
      assert.equal(result.rejected.length, 0)
    })
  })

  // ── Goal condition ──

  describe('M5 — buildPeerReviewGoalCondition', () => {
    test('names the task, the rubric, and the finding contract', () => {
      const { buildPeerReviewGoalCondition } = require('../blueprint-goal-conditions')
      const goal = buildPeerReviewGoalCondition('T003', 'Add config loading')
      assert.ok(goal.includes('T003'), 'task id present')
      assert.ok(goal.includes('Add config loading'), 'task description present')
      assert.ok(goal.includes('ac-coverage'), 'rubric present')
      assert.ok(goal.includes('packet-compliance'), 'full rubric present')
      assert.ok(goal.includes('blueprint-review-findings'), 'findings block required')
      assert.ok(
        goal.includes('empty array is valid'),
        'clean result explicitly allowed — no invented findings'
      )
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) void summaryAsync()
