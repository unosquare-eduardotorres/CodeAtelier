/**
 * Tier 1b (part 3) — mpa.runner, grill.runner, audit.runner, council.runner.
 *
 * These runners drive EventEmitter services, so the tests patch only the
 * *entry-point* method (evaluate / runAudit / orchestrate / start) and let the
 * real `on`/`off`/`emit` plumbing carry the events — which is what the runners
 * actually subscribe to. The deterministic MPA preflight runners use the REAL
 * classifyGoal, no patching at all.
 *
 * Run: tsx src/main/services/__tests__/e2e-runners-mpa-grill-audit.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

import { attachTestDb } from '../../db/repositories/__tests__/db-test-helper'
import { serial, tryRequire, makeCtx, statuses, errors, texts } from './e2e-runner-harness'

const dbContext = attachTestDb()

if (!dbContext) {
  describe('e2e-runners-mpa-grill-audit (skipped — no DB)', () => {
    test('db_setup_unavailable', () => {
      /* better-sqlite3 unavailable — nothing to assert */
    })
  })
} else {
  const wsId = dbContext.wsId
  const ctx = (o = {}): ReturnType<typeof makeCtx> => makeCtx(wsId, o)

  const mpaMod = tryRequire('../e2e-testing/service-runners/mpa.runner')
  const grillMod = tryRequire('../e2e-testing/service-runners/grill.runner')
  const auditMod = tryRequire('../e2e-testing/service-runners/audit.runner')
  const councilMod = tryRequire('../e2e-testing/service-runners/council.runner')

  // Bind the singletons the way the RUNNERS bind them — via dynamic import.
  // `require` can hand back a mock left behind by an earlier file in the shared
  // run (see the note in e2e-service-runners-behavior.test.ts), which would put
  // the patch on an object the runner never calls. The require seed keeps the
  // standalone run working; the import assignment wins before any test body runs.
  let orchestration = tryRequire('../mpa-orchestration.service')?.mpaOrchestrationService
  let campaign = tryRequire('../mpa-campaign.service')?.mpaCampaignService
  let grill = tryRequire('../grill-agent.service')?.grillAgentService
  let auditAgent = tryRequire('../audit-agent.service')?.auditAgentService
  let council = tryRequire('../council.service')?.councilService
  let repos = tryRequire('../../db/repositories')
  void import('../mpa-orchestration.service').then((m: any) => {
    orchestration = m?.mpaOrchestrationService ?? orchestration
  })
  void import('../mpa-campaign.service').then((m: any) => {
    campaign = m?.mpaCampaignService ?? campaign
  })
  void import('../grill-agent.service').then((m: any) => {
    grill = m?.grillAgentService ?? grill
  })
  void import('../audit-agent.service').then((m: any) => {
    auditAgent = m?.auditAgentService ?? auditAgent
  })
  void import('../council.service').then((m: any) => {
    council = m?.councilService ?? council
  })
  void import('../../db/repositories').then((m: any) => {
    repos = m?.auditRepository ? m : repos
  })
  // The reconcile runner imports this repository by file path, not via the barrel.
  const campaignRepo = tryRequire('../../db/repositories/mpa-campaign.repository')
    ?.mpaCampaignRepository

  // ── mpa.runner — deterministic preflight (real classifyGoal) ───────────────

  describe('mpa.runner — runMpaPreflight (no patching, real classifier)', () => {
    test(
      'emits a JSON classification followed by preflight_complete',
      serial(async () => {
        const t = await mpaMod.runMpaPreflight(ctx())
        assert.deepEqual(statuses(t), ['preflight_complete'])
        assert.deepEqual(errors(t), [])
        const parsed = JSON.parse(texts(t)[0])
        assert.equal(typeof parsed.goalType, 'string')
        assert.ok(Array.isArray(parsed.phases))
        assert.equal(parsed.isValid, true, 'a concrete feature goal must classify as valid')
        assert.ok(parsed.phases.length > 0)
      })
    )

    test(
      'the text entry is the only assistant output and parses as JSON',
      serial(async () => {
        const t = await mpaMod.runMpaPreflight(ctx())
        assert.equal(texts(t).length, 1)
        assert.doesNotThrow(() => JSON.parse(texts(t)[0]))
      })
    )
  })

  describe('mpa.runner — runMpaGoalConditions (no patching, real classifier)', () => {
    test(
      'a vague goal is rejected and always carries a rejection reason',
      serial(async () => {
        const t = await mpaMod.runMpaGoalConditions(ctx())
        assert.deepEqual(statuses(t), ['goal_conditions_checked'])
        const parsed = JSON.parse(texts(t)[0])
        assert.equal(parsed.isValid, false, '"fix stuff" must not classify as a valid goal')
        assert.equal(typeof parsed.rejectionReason, 'string')
        assert.ok(parsed.rejectionReason.length > 0)
      })
    )

    test(
      'preflight and goal-conditions disagree on validity for their two inputs',
      serial(async () => {
        const good = JSON.parse(texts(await mpaMod.runMpaPreflight(ctx()))[0])
        const bad = JSON.parse(texts(await mpaMod.runMpaGoalConditions(ctx()))[0])
        assert.equal(good.isValid, true)
        assert.equal(bad.isValid, false)
      })
    )
  })

  // ── mpa.runner — orchestration ─────────────────────────────────────────────

  describe('mpa.runner — runMpaOrchestration', () => {
    test(
      'records each phaseStart and the pipeline completion',
      serial(async (p) => {
        p.set(orchestration, 'orchestrate', async () => {
          orchestration.emit('phaseStart', { phase: 'plan' })
          orchestration.emit('phaseStart', { phase: 'build' })
          orchestration.emit('pipelineComplete', {})
        })
        const t = await mpaMod.runMpaOrchestration(ctx())
        assert.deepEqual(statuses(t), [
          'orchestration_starting',
          'phase_start: plan',
          'phase_start: build',
          'pipeline_complete'
        ])
        assert.deepEqual(errors(t), [])
      })
    )

    test(
      'a phase event without a name falls back to "unknown"',
      serial(async (p) => {
        p.set(orchestration, 'orchestrate', async () => {
          orchestration.emit('phaseStart', {})
        })
        const t = await mpaMod.runMpaOrchestration(ctx())
        assert.ok(statuses(t).includes('phase_start: unknown'))
      })
    )

    test(
      'an approvalNeeded event is auto-approved with the reported runId',
      serial(async (p) => {
        const approvals: unknown[][] = []
        p.set(orchestration, 'respondToGate', (...a: unknown[]) => {
          approvals.push(a)
        })
        p.set(orchestration, 'orchestrate', async () => {
          orchestration.emit('approvalNeeded', { runId: 'run-77' })
          await new Promise((r) => setTimeout(r, 0))
          await new Promise((r) => setTimeout(r, 0))
        })
        await mpaMod.runMpaOrchestration(ctx())
        assert.deepEqual(approvals, [['run-77', true]])
      })
    )

    test(
      'an approvalNeeded event without a runId is ignored',
      serial(async (p) => {
        let calls = 0
        p.set(orchestration, 'respondToGate', () => {
          calls++
        })
        p.set(orchestration, 'orchestrate', async () => {
          orchestration.emit('approvalNeeded', {})
          await new Promise((r) => setTimeout(r, 0))
        })
        await mpaMod.runMpaOrchestration(ctx())
        assert.equal(calls, 0)
      })
    )

    test(
      'listeners are detached once orchestration settles',
      serial(async (p) => {
        p.set(orchestration, 'orchestrate', async () => {})
        const before = orchestration.listenerCount('phaseStart')
        await mpaMod.runMpaOrchestration(ctx())
        assert.equal(orchestration.listenerCount('phaseStart'), before)
        assert.equal(orchestration.listenerCount('approvalNeeded'), 0)
      })
    )

    test(
      'listeners are detached even when orchestration rejects',
      serial(async (p) => {
        p.set(orchestration, 'orchestrate', async () => {
          throw new Error('planner crashed')
        })
        const t = await mpaMod.runMpaOrchestration(ctx())
        assert.deepEqual(errors(t), ['planner crashed'])
        assert.equal(orchestration.listenerCount('approvalNeeded'), 0)
        assert.equal(orchestration.listenerCount('pipelineComplete'), 0)
      })
    )

    test(
      'the goal and workspace from the context are forwarded to orchestrate',
      serial(async (p) => {
        const seen: any[] = []
        p.set(orchestration, 'orchestrate', async (a: any) => {
          seen.push(a)
        })
        const c = ctx()
        await mpaMod.runMpaOrchestration(c)
        assert.equal(seen[0].workspaceId, c.workspaceId)
        assert.equal(seen[0].workspacePath, c.workspacePath)
        assert.equal(seen[0].title, 'E2E MPA Test')
        assert.match(seen[0].goal, /createTask/)
        assert.ok(Array.isArray(seen[0].phases))
      })
    )
  })

  describe('mpa.runner — runMpaCancellation', () => {
    test(
      'cancels the workspace run once the first phase starts',
      serial(async (p) => {
        const cancels: unknown[] = []
        p.set(orchestration, 'cancel', (id: string) => cancels.push(id))
        p.set(orchestration, 'orchestrate', async () => {
          orchestration.emit('phaseStart', { phase: 'plan' })
          return new Promise(() => {}) // never settles — the runner cancels instead
        })
        const c = ctx()
        const t = await mpaMod.runMpaCancellation(c)
        const s = statuses(t)
        assert.ok(s.includes('orchestration_starting_for_cancel'))
        assert.ok(s.includes('first_phase_started'))
        assert.ok(s.includes('cancelled'))
        assert.deepEqual(cancels, [c.workspaceId])
      })
    )

    // NOTE: the "no phase ever starts" path is deliberately not covered — it can
    // only be reached by letting runMpaCancellation's 30s fallback fire, and the
    // harness must never shorten long timers (see e2e-runner-harness.ts).

    test(
      'an orchestration rejection is swallowed — cancellation still completes',
      serial(async (p) => {
        p.set(orchestration, 'cancel', () => {})
        p.set(orchestration, 'orchestrate', async () => {
          orchestration.emit('phaseStart', {})
          throw new Error('interrupted by cancel')
        })
        const t = await mpaMod.runMpaCancellation(ctx())
        assert.deepEqual(errors(t), [], 'the .catch() on orchestrate must absorb this')
        assert.ok(statuses(t).includes('cancelled'))
      })
    )
  })

  // ── mpa.runner — campaign runners ──────────────────────────────────────────

  describe('mpa.runner — runMpaCampaignSequential', () => {
    test(
      'reports both goal completions and the campaign completion',
      serial(async (p) => {
        p.set(orchestration, 'respondToGate', () => {})
        p.set(campaign, 'start', () => {
          campaign.emit('goalComplete', {})
          campaign.emit('goalComplete', {})
          campaign.emit('campaignComplete', {})
          return { campaignId: 'camp-1' }
        })
        const t = await mpaMod.runMpaCampaignSequential(ctx())
        assert.deepEqual(statuses(t), [
          'campaign_starting',
          'campaign_started: camp-1',
          'goal_complete_count: 2',
          'campaign_complete'
        ])
      })
    )

    test(
      'the campaign is started with two classified goals carrying uuid ids',
      serial(async (p) => {
        const seen: any[] = []
        p.set(orchestration, 'respondToGate', () => {})
        p.set(campaign, 'start', (a: any) => {
          seen.push(a)
          campaign.emit('campaignComplete', {})
          return { campaignId: 'c' }
        })
        const c = ctx()
        await mpaMod.runMpaCampaignSequential(c)
        assert.equal(seen[0].workspaceId, c.workspaceId)
        assert.equal(seen[0].title, 'E2E Sequential Campaign')
        assert.equal(seen[0].goals.length, 2)
        for (const g of seen[0].goals) {
          assert.match(g.id, /^[0-9a-f-]{36}$/)
          assert.ok(Array.isArray(g.phases))
          assert.ok(Array.isArray(g.successCriteria))
        }
        assert.notEqual(seen[0].goals[0].id, seen[0].goals[1].id)
      })
    )

    test(
      'all campaign and gate listeners are removed afterwards',
      serial(async (p) => {
        p.set(orchestration, 'respondToGate', () => {})
        p.set(campaign, 'start', () => {
          campaign.emit('campaignComplete', {})
          return { campaignId: 'c' }
        })
        await mpaMod.runMpaCampaignSequential(ctx())
        assert.equal(campaign.listenerCount('goalComplete'), 0)
        assert.equal(campaign.listenerCount('campaignComplete'), 0)
        assert.equal(orchestration.listenerCount('approvalNeeded'), 0)
      })
    )

    test(
      'a start() throw becomes an error entry and still detaches listeners',
      serial(async (p) => {
        p.set(orchestration, 'respondToGate', () => {})
        p.set(campaign, 'start', () => {
          throw new Error('campaign table locked')
        })
        const t = await mpaMod.runMpaCampaignSequential(ctx())
        assert.deepEqual(errors(t), ['campaign table locked'])
        assert.equal(campaign.listenerCount('goalComplete'), 0)
      })
    )
  })

  describe('mpa.runner — runMpaCampaignPauseRetry', () => {
    test(
      'auto-resolves a pause with skip and reports the completed pause cycle',
      serial(async (p) => {
        const responses: unknown[][] = []
        p.set(orchestration, 'respondToGate', () => {})
        p.set(campaign, 'respond', (...a: unknown[]) => responses.push(a))
        p.set(campaign, 'isRunningForWorkspace', () => false)
        p.set(campaign, 'start', () => {
          campaign.emit('campaignPaused', {})
          return { campaignId: 'c' }
        })
        const c = ctx()
        const t = await mpaMod.runMpaCampaignPauseRetry(c)
        const s = statuses(t)
        assert.ok(s.includes('campaign_paused'))
        assert.ok(s.includes('pause_cycle_complete'))
        assert.deepEqual(responses, [[c.workspaceId, 'skip']])
      })
    )

    test(
      'reports no_pause_detected when the campaign never pauses',
      serial(async (p) => {
        p.set(orchestration, 'respondToGate', () => {})
        p.set(campaign, 'isRunningForWorkspace', () => false)
        p.set(campaign, 'start', () => ({ campaignId: 'c' }))
        const t = await mpaMod.runMpaCampaignPauseRetry(ctx())
        assert.ok(statuses(t).includes('no_pause_detected'))
      })
    )

    test(
      'the single goal targets the deliberately nonexistent module',
      serial(async (p) => {
        const seen: any[] = []
        p.set(orchestration, 'respondToGate', () => {})
        p.set(campaign, 'isRunningForWorkspace', () => false)
        p.set(campaign, 'start', (a: any) => {
          seen.push(a)
          return { campaignId: 'c' }
        })
        await mpaMod.runMpaCampaignPauseRetry(ctx())
        assert.equal(seen[0].goals.length, 1)
        assert.equal(seen[0].goals[0].title, 'Refactor nonexistent')
      })
    )

    test(
      'a start() throw becomes an error entry',
      serial(async (p) => {
        p.set(orchestration, 'respondToGate', () => {})
        p.set(campaign, 'start', () => {
          throw new Error('cannot start')
        })
        const t = await mpaMod.runMpaCampaignPauseRetry(ctx())
        assert.deepEqual(errors(t), ['cannot start'])
        assert.equal(campaign.listenerCount('campaignPaused'), 0)
      })
    )
  })

  describe('mpa.runner — runMpaCampaignSkip', () => {
    test(
      'cancels the campaign after the first phase and reports skip_stop_ok',
      serial(async (p) => {
        const cancels: unknown[] = []
        p.set(orchestration, 'respondToGate', () => {})
        p.set(campaign, 'cancel', (id: string) => cancels.push(id))
        p.set(campaign, 'isRunningForWorkspace', () => false)
        p.set(campaign, 'start', () => {
          orchestration.emit('phaseStart', { phase: 'plan' })
          return { campaignId: 'c' }
        })
        const c = ctx()
        const t = await mpaMod.runMpaCampaignSkip(c)
        assert.ok(statuses(t).includes('campaign_cancelled'))
        assert.ok(statuses(t).includes('skip_stop_ok'))
        assert.deepEqual(cancels, [c.workspaceId])
      })
    )

    test(
      'reports skip_stop_no_cancel when no phase ever starts',
      serial(async (p) => {
        p.set(orchestration, 'respondToGate', () => {})
        p.set(campaign, 'cancel', () => {})
        p.set(campaign, 'isRunningForWorkspace', () => false)
        p.set(campaign, 'start', () => ({ campaignId: 'c' }))
        const t = await mpaMod.runMpaCampaignSkip(ctx())
        assert.ok(statuses(t).includes('skip_stop_no_cancel'))
      })
    )

    test(
      'orchestration listeners are detached afterwards',
      serial(async (p) => {
        p.set(orchestration, 'respondToGate', () => {})
        p.set(campaign, 'cancel', () => {})
        p.set(campaign, 'isRunningForWorkspace', () => false)
        p.set(campaign, 'start', () => ({ campaignId: 'c' }))
        await mpaMod.runMpaCampaignSkip(ctx())
        assert.equal(orchestration.listenerCount('approvalNeeded'), 0)
        assert.equal(orchestration.listenerCount('phaseStart'), 0)
      })
    )
  })

  describe('mpa.runner — runMpaCampaignReconcile (real repository)', () => {
    test(
      'a leftover running campaign is marked failed by reconcileStale',
      serial(async () => {
        const t = await mpaMod.runMpaCampaignReconcile(ctx())
        const s = statuses(t)
        assert.deepEqual(errors(t), [])
        assert.equal(s.length, 2)
        assert.match(s[0], /^stale_campaign_created: /)
        assert.equal(s[1], 'reconcile_ok', `unexpected reconcile outcome: ${s[1]}`)
      })
    )

    test(
      'reports the observed status when reconciliation leaves the row alone',
      serial(async (p) => {
        p.set(campaign, 'reconcileStale', () => 0)
        const t = await mpaMod.runMpaCampaignReconcile(ctx())
        assert.ok(statuses(t).some((s) => s.startsWith('reconcile_unexpected: status=')))
      })
    )

    test(
      'a repository failure becomes an error entry',
      serial(async (p) => {
        p.set(campaignRepo, 'create', () => {
          throw new Error('campaign insert failed')
        })
        const t = await mpaMod.runMpaCampaignReconcile(ctx())
        assert.deepEqual(errors(t), ['campaign insert failed'])
      })
    )
  })

  // ── grill.runner ───────────────────────────────────────────────────────────

  describe('grill.runner — runGrillEvaluate', () => {
    test(
      'emits the first evaluation as JSON text plus a completion status',
      serial(async (p) => {
        p.set(grill, 'evaluate', async () => {
          grill.emit('evaluation', { score: 8, track: 'requirements' })
          grill.emit('complete')
        })
        const t = await grillMod.runGrillEvaluate(ctx())
        assert.deepEqual(statuses(t), ['grill_evaluate_starting', 'grill_evaluation_complete'])
        assert.deepEqual(JSON.parse(texts(t)[0]), { score: 8, track: 'requirements' })
      })
    )

    test(
      'reports completion with no evaluations when only complete fires',
      serial(async (p) => {
        p.set(grill, 'evaluate', async () => {
          grill.emit('complete')
        })
        const t = await grillMod.runGrillEvaluate(ctx())
        assert.ok(statuses(t).includes('grill_completed_no_evaluations'))
        assert.equal(texts(t).length, 0)
      })
    )

    // NOTE: the grill_timeout path needs the runner's 300s fallback to fire, which
    // the harness will not shorten — see e2e-runner-harness.ts.

    test(
      'evaluate receives the documented track and provider',
      serial(async (p) => {
        const seen: any[] = []
        p.set(grill, 'evaluate', async (a: any) => {
          seen.push(a)
          grill.emit('complete')
        })
        const c = ctx()
        await grillMod.runGrillEvaluate(c)
        assert.equal(seen[0].workspaceId, c.workspaceId)
        assert.equal(seen[0].trackId, 'requirements')
        assert.equal(seen[0].llmProvider, 'local-llm')
        assert.equal(seen[0].ideaTitle, 'E2E Test Feature')
      })
    )

    test(
      'listeners are removed after completion so runs cannot cross-talk',
      serial(async (p) => {
        p.set(grill, 'evaluate', async () => {
          grill.emit('complete')
        })
        await grillMod.runGrillEvaluate(ctx())
        assert.equal(grill.listenerCount('evaluation'), 0)
        assert.equal(grill.listenerCount('complete'), 0)
      })
    )

    test(
      'a rejecting evaluate becomes an error entry',
      serial(async (p) => {
        p.set(grill, 'evaluate', async () => {
          throw new Error('no local model loaded')
        })
        const t = await grillMod.runGrillEvaluate(ctx())
        assert.deepEqual(errors(t), ['no local model loaded'])
      })
    )
  })

  describe('grill.runner — runGrillMultiTrack', () => {
    test(
      'runs both tracks and sums their evaluation counts',
      serial(async (p) => {
        const tracks: string[] = []
        p.set(grill, 'evaluate', async (a: any) => {
          tracks.push(a.trackId)
          grill.emit('evaluation', { t: a.trackId })
          grill.emit('evaluation', { t: a.trackId })
          grill.emit('complete')
        })
        const t = await grillMod.runGrillMultiTrack(ctx())
        assert.deepEqual(tracks, ['requirements', 'architecture'])
        const s = statuses(t)
        assert.ok(s.includes('grill_track_starting: requirements'))
        assert.ok(s.includes('grill_track_starting: architecture'))
        assert.ok(s.includes('evaluations_count: 4'))
      })
    )

    test(
      'an already-aborted signal skips every track',
      serial(async (p) => {
        const ac = new AbortController()
        ac.abort()
        let calls = 0
        p.set(grill, 'evaluate', async () => {
          calls++
        })
        const t = await grillMod.runGrillMultiTrack(ctx({ signal: ac.signal }))
        assert.equal(calls, 0)
        assert.deepEqual(statuses(t), ['evaluations_count: 0'])
      })
    )

    test(
      'a failure on the first track aborts the loop with an error entry',
      serial(async (p) => {
        let calls = 0
        p.set(grill, 'evaluate', async () => {
          calls++
          throw new Error('track failed')
        })
        const t = await grillMod.runGrillMultiTrack(ctx())
        assert.equal(calls, 1)
        assert.deepEqual(errors(t), ['track failed'])
      })
    )
  })

  describe('grill.runner — iteration, condense and plan generation', () => {
    test(
      'runGrillIteration feeds the first score into the second evaluation',
      serial(async (p) => {
        const seen: any[] = []
        p.set(grill, 'evaluate', async (a: any) => {
          seen.push(a)
          grill.emit('evaluation', { score: 6 })
          grill.emit('complete')
        })
        const t = await grillMod.runGrillIteration(ctx())
        assert.equal(seen.length, 2)
        assert.equal(seen[0].previousScore, undefined)
        assert.equal(seen[1].previousScore, 6)
        assert.match(seen[1].iterationHistory, /Previous feedback/)
        assert.ok(statuses(t).includes('iteration_complete'))
      })
    )

    test(
      'runGrillIteration defaults previousScore to 5 when none was emitted',
      serial(async (p) => {
        const seen: any[] = []
        p.set(grill, 'evaluate', async (a: any) => {
          seen.push(a)
          grill.emit('complete')
        })
        await grillMod.runGrillIteration(ctx())
        assert.equal(seen[1].previousScore, 5)
      })
    )

    test(
      'runGrillCondenseRequirement reports condensed after the evaluation settles',
      serial(async (p) => {
        p.set(grill, 'evaluate', async () => {
          grill.emit('complete')
        })
        const t = await grillMod.runGrillCondenseRequirement(ctx())
        assert.deepEqual(statuses(t), ['condense_starting', 'condensed'])
      })
    )

    test(
      'runGrillGeneratePlan emits a three-item plan when evaluations exist',
      serial(async (p) => {
        p.set(grill, 'evaluate', async () => {
          grill.emit('evaluation', { score: 9 })
          grill.emit('complete')
        })
        const t = await grillMod.runGrillGeneratePlan(ctx())
        assert.ok(statuses(t).includes('plan_generated'))
        const plan = JSON.parse(texts(t)[0])
        assert.equal(plan.items.length, 3)
        for (const item of plan.items) {
          assert.equal(typeof item.title, 'string')
          assert.equal(typeof item.description, 'string')
        }
      })
    )

    test(
      'runGrillGeneratePlan emits no plan when there were no evaluations',
      serial(async (p) => {
        p.set(grill, 'evaluate', async () => {
          grill.emit('complete')
        })
        const t = await grillMod.runGrillGeneratePlan(ctx())
        assert.ok(statuses(t).includes('no_evaluations_for_plan'))
        assert.equal(texts(t).length, 0)
      })
    )

    test(
      'a rejecting evaluate in the plan runner becomes an error entry',
      serial(async (p) => {
        p.set(grill, 'evaluate', async () => {
          throw new Error('plan backend down')
        })
        const t = await grillMod.runGrillGeneratePlan(ctx())
        assert.deepEqual(errors(t), ['plan backend down'])
      })
    )
  })

  // ── audit.runner ───────────────────────────────────────────────────────────

  describe('audit.runner — runAuditStartRun', () => {
    test(
      'records the run id, progress, findings, coverage and completion',
      serial(async (p) => {
        p.set(auditAgent, 'runAudit', async () => {
          auditAgent.emit('progress', { trackId: 'code', progress: 50 })
          auditAgent.emit('result', { findings: [{ id: 'f1' }, { id: 'f2' }], coverageStats: {} })
          auditAgent.emit('complete')
        })
        const t = await auditMod.runAuditStartRun(ctx())
        const s = statuses(t)
        assert.match(s[0], /^audit_started: runId=/)
        assert.ok(s.includes('audit_progress: code 50%'))
        assert.ok(s.includes('findings_present: count=2'))
        assert.ok(s.includes('coverage_stats_present'))
        assert.ok(s.includes('audit_complete'))
        assert.deepEqual(errors(t), [])
      })
    )

    test(
      'a progress event without a percentage defaults to 0%',
      serial(async (p) => {
        p.set(auditAgent, 'runAudit', async () => {
          auditAgent.emit('progress', { trackId: 'code' })
        })
        const t = await auditMod.runAuditStartRun(ctx())
        assert.ok(statuses(t).includes('audit_progress: code 0%'))
      })
    )

    test(
      'an empty findings array does not count as findings',
      serial(async (p) => {
        p.set(auditAgent, 'runAudit', async () => {
          auditAgent.emit('result', { findings: [] })
        })
        p.set(repos.auditRepository, 'findResultsByRunId', () => [])
        const t = await auditMod.runAuditStartRun(ctx())
        assert.ok(!statuses(t).some((s) => s.startsWith('findings_present')))
      })
    )

    test(
      'the database fallback supplies findings when no result event fired',
      serial(async (p) => {
        p.set(auditAgent, 'runAudit', async () => {})
        p.set(repos.auditRepository, 'findResultsByRunId', () => [
          { findings: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], coverageStats: { lines: 80 } }
        ])
        const t = await auditMod.runAuditStartRun(ctx())
        const s = statuses(t)
        assert.ok(s.includes('findings_present: count=3'))
        assert.ok(s.includes('coverage_stats_present'))
      })
    )

    test(
      'runAudit is invoked in light mode against the code track only',
      serial(async (p) => {
        const seen: any[] = []
        p.set(auditAgent, 'runAudit', async (a: any) => {
          seen.push(a)
        })
        p.set(repos.auditRepository, 'findResultsByRunId', () => [])
        const c = ctx()
        await auditMod.runAuditStartRun(c)
        assert.equal(seen[0].mode, 'light')
        assert.deepEqual(seen[0].selectedTracks, ['code'])
        assert.equal(seen[0].workspaceId, c.workspaceId)
        assert.equal(seen[0].llmProvider, 'local-llm')
        assert.equal(typeof seen[0].auditRunId, 'string')
      })
    )

    test(
      'event listeners are detached even when runAudit rejects',
      serial(async (p) => {
        p.set(auditAgent, 'runAudit', async () => {
          throw new Error('analyzer crashed')
        })
        const t = await auditMod.runAuditStartRun(ctx())
        assert.deepEqual(errors(t), ['analyzer crashed'])
        assert.equal(auditAgent.listenerCount('progress'), 0)
        assert.equal(auditAgent.listenerCount('result'), 0)
        assert.equal(auditAgent.listenerCount('complete'), 0)
      })
    )
  })

  describe('audit.runner — findings and coverage variants', () => {
    test(
      'runAuditFindings annotates the transcript when the fixture produced none',
      serial(async (p) => {
        p.set(auditAgent, 'runAudit', async () => {})
        p.set(repos.auditRepository, 'findResultsByRunId', () => [])
        const t = await auditMod.runAuditFindings(ctx())
        assert.ok(
          statuses(t).some((s) => s.includes('count=0 (unexpected — fixture has planted markers)'))
        )
      })
    )

    test(
      'runAuditFindings adds no annotation when findings were present',
      serial(async (p) => {
        p.set(auditAgent, 'runAudit', async () => {
          auditAgent.emit('result', { findings: [{ id: 'f1' }] })
        })
        p.set(repos.auditRepository, 'findResultsByRunId', () => [])
        const t = await auditMod.runAuditFindings(ctx())
        assert.ok(!statuses(t).some((s) => s.includes('unexpected')))
        assert.ok(statuses(t).includes('findings_present: count=1'))
      })
    )

    test(
      'runAuditCoverage selects both the code and documentation tracks',
      serial(async (p) => {
        const seen: any[] = []
        p.set(auditAgent, 'runAudit', async (a: any) => {
          seen.push(a)
        })
        p.set(repos.auditRepository, 'findResultsByRunId', () => [])
        await auditMod.runAuditCoverage(ctx())
        assert.deepEqual(seen[0].selectedTracks, ['code', 'documentation'])
      })
    )

    test(
      'a repository failure while creating the run becomes an error entry',
      serial(async (p) => {
        p.set(repos.auditRepository, 'createRun', () => {
          throw new Error('audit_runs insert failed')
        })
        const t = await auditMod.runAuditCoverage(ctx())
        assert.deepEqual(errors(t), ['audit_runs insert failed'])
      })
    )
  })

  // ── council.runner ─────────────────────────────────────────────────────────
  //
  // NOTE: runCouncilToStage's cleanup() does NOT clearTimeout its 20-minute
  // fallback, so that timer stays pending after the promise resolves. Under the
  // clamped timers it fires ~25ms later and appends to the (already returned)
  // transcript, so every assertion below snapshots the array first.

  describe('council.runner — runCouncilStartSession', () => {
    test(
      'stops at two member completions without waiting for a verdict',
      serial(async (p) => {
        p.set(council, 'evaluate', async () => {
          council.emit('phase-changed', { phase: 'debate' })
          council.emit('member-complete', {})
          council.emit('member-complete', {})
        })
        const s = statuses(await councilMod.runCouncilStartSession(ctx()))
        assert.deepEqual(s, [
          'council_starting',
          'phase_changed: debate',
          'member_complete: 1',
          'member_complete: 2'
        ])
      })
    )

    test(
      'a phase event without a name falls back to "unknown"',
      serial(async (p) => {
        p.set(council, 'evaluate', async () => {
          council.emit('phase-changed', {})
          council.emit('complete')
        })
        const s = statuses(await councilMod.runCouncilStartSession(ctx()))
        assert.ok(s.includes('phase_changed: unknown'))
      })
    )

    // NOTE: council_timeout needs the runner's 20-minute fallback to fire, which
    // the harness will not shorten — see e2e-runner-harness.ts.

    test(
      'evaluate receives a plan input with the fixture files in scope',
      serial(async (p) => {
        const seen: any[] = []
        p.set(council, 'evaluate', async (a: any) => {
          seen.push(a)
          council.emit('complete')
        })
        const c = ctx()
        await councilMod.runCouncilStartSession(c)
        assert.equal(seen[0].inputType, 'plan')
        assert.equal(seen[0].workspaceId, c.workspaceId)
        assert.equal(seen[0].llmProvider, 'local-llm')
        assert.deepEqual(seen[0].filesInScope, ['src/hello.ts', 'src/tasks.ts'])
        assert.equal(seen[0].structuredPlan, null)
      })
    )

    test(
      'a rejecting evaluate becomes an error entry',
      serial(async (p) => {
        p.set(council, 'evaluate', async () => {
          throw new Error('advisors unavailable')
        })
        const t = await councilMod.runCouncilStartSession(ctx())
        assert.deepEqual(errors(t), ['advisors unavailable'])
      })
    )
  })

  describe('council.runner — opinions, synthesis and structured output', () => {
    test(
      'runCouncilAdvisorOpinions appends the advisor count',
      serial(async (p) => {
        p.set(council, 'evaluate', async () => {
          council.emit('member-complete', {})
          council.emit('member-complete', {})
        })
        const s = statuses(await councilMod.runCouncilAdvisorOpinions(ctx()))
        assert.ok(s.includes('advisor_opinions_received: 2'))
      })
    )

    test(
      'runCouncilAdvisorOpinions reports 0 when the members never reported',
      serial(async (p) => {
        p.set(council, 'evaluate', async () => {
          council.emit('complete')
        })
        const s = statuses(await councilMod.runCouncilAdvisorOpinions(ctx()))
        assert.ok(s.includes('advisor_opinions_received: 0'))
      })
    )

    test(
      'runCouncilSynthesis records a synthesis once a verdict arrives',
      serial(async (p) => {
        p.set(council, 'evaluate', async () => {
          council.emit('verdict', { decision: 'approve' })
        })
        const s = statuses(await councilMod.runCouncilSynthesis(ctx()))
        assert.ok(s.includes('verdict'))
        assert.ok(s.includes('synthesis'))
      })
    )

    test(
      'runCouncilSynthesis records no synthesis without a verdict',
      serial(async (p) => {
        p.set(council, 'evaluate', async () => {
          council.emit('complete')
        })
        const s = statuses(await councilMod.runCouncilSynthesis(ctx()))
        assert.ok(!s.includes('synthesis'))
      })
    )

    test(
      'runCouncilStructuredOutput serialises the verdict as assistant text',
      serial(async (p) => {
        p.set(council, 'evaluate', async () => {
          council.emit('verdict', { decision: 'approve', risks: ['auth'] })
          council.emit('complete')
        })
        const t = await councilMod.runCouncilStructuredOutput(ctx())
        const parsed = JSON.parse(texts(t)[0])
        assert.deepEqual(parsed, { decision: 'approve', risks: ['auth'] })
      })
    )

    test(
      'runCouncilStructuredOutput emits no text when no verdict was produced',
      serial(async (p) => {
        p.set(council, 'evaluate', async () => {
          council.emit('complete')
        })
        const t = await councilMod.runCouncilStructuredOutput(ctx())
        assert.equal(texts(t).length, 0)
      })
    )
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
