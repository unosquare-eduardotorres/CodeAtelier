/**
 * blueprint-plan-revision.test.ts — BP-REVISION-LEDGER-01.
 *
 * "Request Changes" collected the human's text, sent it over IPC, and then
 * dropped it: the handler never read `args.feedback`. The pipeline rewound to
 * PLAN and re-ran plan → tasks → review with no record of what was asked, so
 * the expensive path ran without the information that justified running it.
 *
 * These tests pin the three things that fix requires:
 *   1. the ledger stores every request and survives a rewind,
 *   2. the prompt actually carries it into the re-run,
 *   3. a revision block that cannot be applied is rejected, not half-applied.
 *
 * Run: tsx src/main/services/__tests__/blueprint-plan-revision.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

// ═══════════════════════════════════════════════════════════════════════
// Revision block parsing — pure, no DB
// ═══════════════════════════════════════════════════════════════════════

let parsePlanRevisionBlock: (text: string) => Record<string, unknown> | null
let parsersLoaded = false
try {
  parsePlanRevisionBlock = require('../blueprint-artifact-parsers').parsePlanRevisionBlock
  parsersLoaded = true
} catch (err) {
  console.log(`⚠ blueprint-artifact-parsers load failed — parser tests skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

if (parsersLoaded) {
  describe('parsePlanRevisionBlock', () => {
    test('parses a well-formed revision', () => {
      const text = [
        'Some narration first.',
        '```blueprint-plan-revision',
        JSON.stringify({
          summary: 'Split the migration into two steps',
          changes: ['Added step 3a', 'Removed the destructive rebuild'],
          concerns: [],
          planMarkdown: '# Plan\n\n1. Do the thing'
        }),
        '```',
        'And the readable plan after.'
      ].join('\n')

      const r = parsePlanRevisionBlock(text)!
      assert.ok(r)
      assert.equal(r.summary, 'Split the migration into two steps')
      assert.deepEqual(r.changes, ['Added step 3a', 'Removed the destructive rebuild'])
      assert.equal(r.planMarkdown, '# Plan\n\n1. Do the thing')
    })

    test('a block with no planMarkdown is rejected, not half-applied', () => {
      // Applying a "revision" that carries no plan would overwrite the real plan
      // with nothing while telling the human their feedback landed.
      const text = [
        '```blueprint-plan-revision',
        JSON.stringify({ summary: 'I agree', changes: ['x'], concerns: [] }),
        '```'
      ].join('\n')
      assert.equal(parsePlanRevisionBlock(text), null)
    })

    test('an empty planMarkdown is rejected too', () => {
      const text = [
        '```blueprint-plan-revision',
        JSON.stringify({ summary: 's', changes: [], concerns: [], planMarkdown: '   ' }),
        '```'
      ].join('\n')
      assert.equal(parsePlanRevisionBlock(text), null)
    })

    test('concerns survive even when the agent pushes back', () => {
      // Agent disagreement is a legitimate outcome the human has to see.
      const text = [
        '```blueprint-plan-revision',
        JSON.stringify({
          summary: 'Left mostly as-is',
          changes: [],
          concerns: ['The requested index would break the unique constraint'],
          planMarkdown: '# Plan\nunchanged'
        }),
        '```'
      ].join('\n')
      const r = parsePlanRevisionBlock(text)!
      assert.deepEqual(r.concerns, ['The requested index would break the unique constraint'])
    })

    test('no block at all → null', () => {
      assert.equal(parsePlanRevisionBlock('just prose, no fenced block'), null)
    })

    test('malformed JSON → null, not a throw', () => {
      const text = ['```blueprint-plan-revision', '{ not json at all', '```'].join('\n')
      assert.equal(parsePlanRevisionBlock(text), null)
    })

    test('non-string entries in changes/concerns are discarded', () => {
      const text = [
        '```blueprint-plan-revision',
        JSON.stringify({
          summary: 's',
          changes: ['ok', 42, null, { a: 1 }],
          concerns: 'not-an-array',
          planMarkdown: '# Plan'
        }),
        '```'
      ].join('\n')
      const r = parsePlanRevisionBlock(text)!
      assert.deepEqual(r.changes, ['ok'])
      assert.deepEqual(r.concerns, [])
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════
// Prompt injection — the ledger has to reach the agent
// ═══════════════════════════════════════════════════════════════════════

let buildPhaseSystemPrompt: (phase: string, ctx: Record<string, unknown>) => string
let loaderLoaded = false
try {
  buildPhaseSystemPrompt = require('../blueprint-prompt-loader').buildPhaseSystemPrompt
  loaderLoaded = true
} catch (err) {
  console.log(`⚠ blueprint-prompt-loader load failed — prompt tests skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

function baseContext(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    blueprint: {
      id: 'bp-1',
      title: 'T',
      shortName: 'bp',
      description: '',
      priority: 'P1',
      currentPhase: 'plan',
      settings: {}
    },
    constitution: null,
    previousArtifacts: [],
    specFilePath: 'blueprints/bp/spec.md',
    blueprintDir: 'blueprints/bp',
    ...extra
  }
}

if (loaderLoaded) {
  describe('{{REVISION_FEEDBACK}} injection', () => {
    test('the human’s words reach the plan prompt verbatim', () => {
      const prompt = buildPhaseSystemPrompt(
        'plan',
        baseContext({
          revisionRequests: [
            {
              round: 1,
              at: '2026-01-01T00:00:00.000Z',
              phase: 'review',
              feedback: 'Use Postgres, not SQLite — we already run one in prod.',
              disposition: 'rewound'
            }
          ]
        })
      )
      assert.ok(
        prompt.includes('Use Postgres, not SQLite — we already run one in prod.'),
        'feedback text must appear in the prompt'
      )
      assert.ok(prompt.includes('<revision_requests>'))
      assert.ok(!prompt.includes('{{REVISION_FEEDBACK}}'), 'placeholder must be substituted')
    })

    test('every round is carried, not just the newest', () => {
      // A re-run that only sees round 3 happily regresses what was agreed in
      // round 1 — indistinguishable, from the outside, from ignoring the human.
      const prompt = buildPhaseSystemPrompt(
        'plan',
        baseContext({
          revisionRequests: [
            {
              round: 1,
              at: '2026-01-01T00:00:00.000Z',
              phase: 'review',
              feedback: 'FIRST-ROUND-MARKER',
              disposition: 'revised'
            },
            {
              round: 2,
              at: '2026-01-02T00:00:00.000Z',
              phase: 'review',
              feedback: 'SECOND-ROUND-MARKER',
              disposition: 'revised'
            }
          ]
        })
      )
      assert.ok(prompt.includes('FIRST-ROUND-MARKER'))
      assert.ok(prompt.includes('SECOND-ROUND-MARKER'))
    })

    test('reaches tasks and review too, not only plan', () => {
      for (const phase of ['tasks', 'review']) {
        const prompt = buildPhaseSystemPrompt(
          phase,
          baseContext({
            revisionRequests: [
              {
                round: 1,
                at: '2026-01-01T00:00:00.000Z',
                phase: 'review',
                feedback: `MARKER-FOR-${phase}`,
                disposition: 'revised'
              }
            ]
          })
        )
        assert.ok(prompt.includes(`MARKER-FOR-${phase}`), `${phase} prompt must carry the ledger`)
      }
    })

    test('no requests → placeholder resolves to nothing, no empty scaffolding', () => {
      const prompt = buildPhaseSystemPrompt('plan', baseContext())
      assert.ok(!prompt.includes('{{REVISION_FEEDBACK}}'))
      assert.ok(!prompt.includes('<revision_requests>'))
    })

    test('a change request is NOT phrased to the agent as a failure', () => {
      // {{RETRY_CONTEXT}} says "the previous attempt FAILED". Telling an agent it
      // failed when a human merely wants something different produces an apology
      // and a from-scratch rewrite instead of a targeted edit.
      const prompt = buildPhaseSystemPrompt(
        'plan',
        baseContext({
          revisionRequests: [
            {
              round: 1,
              at: '2026-01-01T00:00:00.000Z',
              phase: 'review',
              feedback: 'Rename the table.',
              disposition: 'revised'
            }
          ]
        })
      )
      const block = prompt.slice(
        prompt.indexOf('<revision_requests>'),
        prompt.indexOf('</revision_requests>')
      )
      assert.ok(!/FAILED/.test(block), 'revision block must not tell the agent it failed')
      assert.ok(!/\*\*Error:\*\*/.test(block), 'revision block must not present an error')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // The revised PLAN itself has to reach the agent — not just the ledger
  // ═══════════════════════════════════════════════════════════════════════

  describe('the revised plan reaches the prompt', () => {
    test('THE REGRESSION: a revised plan’s text reaches the TASKS prompt', () => {
      // The ledger tests above prove the human's *words* get through. Nothing
      // proved the *plan* did — and it did not: the revision service appended a
      // second plan artifact carrying contentMd plus revision metadata in
      // contentJson, and renderSingleArtifact() prefers projected JSON for
      // `plan`, so TASKS received {"summary":"…"} and never saw the plan.
      //
      // This is the shape the service persists now: one plan artifact,
      // contentMd, no contentJson.
      const prompt = buildPhaseSystemPrompt(
        'tasks',
        baseContext({
          previousArtifacts: [{ type: 'plan', contentMd: '# Plan\nREVISED-PLAN-MARKER' }]
        })
      )
      assert.ok(prompt.includes('REVISED-PLAN-MARKER'), 'the revised plan must reach TASKS')
    })

    test('why: a plan artifact with contentJson renders as JSON and loses its markdown', () => {
      // Pins the loader behaviour the fix depends on. If this ever stops being
      // true, the "no contentJson on the plan artifact" rule in
      // blueprint-plan-revision.service.ts can be relaxed — until then it is
      // load-bearing, not stylistic.
      const prompt = buildPhaseSystemPrompt(
        'tasks',
        baseContext({
          previousArtifacts: [
            {
              type: 'plan',
              contentMd: '# Plan\nSWALLOWED-PLAN-MARKER',
              contentJson: { revisionRound: 1, summary: 's', changes: [], concerns: [] }
            }
          ]
        })
      )
      assert.ok(
        !prompt.includes('SWALLOWED-PLAN-MARKER'),
        'contentJson on a plan artifact suppresses contentMd — this is why the service omits it'
      )
    })

    test('two plan artifacts would hand TASKS two contradictory plans', () => {
      // assemblePhaseContext() pushes EVERY relevant artifact, so appending a
      // revised plan alongside the original leaves the agent to guess. The fix
      // is to keep exactly one; this test documents the failure it avoids.
      const prompt = buildPhaseSystemPrompt(
        'tasks',
        baseContext({
          previousArtifacts: [
            { type: 'plan', contentMd: '# Plan\nORIGINAL-PLAN-MARKER' },
            { type: 'plan', contentMd: '# Plan\nREVISED-PLAN-MARKER' }
          ]
        })
      )
      assert.ok(prompt.includes('ORIGINAL-PLAN-MARKER') && prompt.includes('REVISED-PLAN-MARKER'))
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════
// Ledger persistence — the part that has to survive a rewind
// ═══════════════════════════════════════════════════════════════════════

let env: { db: import('better-sqlite3').Database; wsId: string } | null = null
let blueprintRepository: any
let blueprintPhaseRepository: any
let blueprintService: any

try {
  const helper = require('../../db/repositories/__tests__/db-test-helper')
  env = helper.attachTestDb()
  const repos = require('../../db/repositories/blueprint.repository')
  blueprintRepository = repos.blueprintRepository
  blueprintPhaseRepository = repos.blueprintPhaseRepository
  blueprintService = require('../blueprint.service').blueprintService
} catch (err) {
  console.log(`⚠ revision ledger setup failed — DB tests skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
  env = null
}

// The service pulls in agent sessions and role adapters — load it separately so
// a failure there does not take the ledger tests down with it.
let blueprintPlanRevisionService: any = null
let buildRevisedApproval: any = null
let approvalGateBlock: any = null
try {
  const mod = require('../blueprint-plan-revision.service')
  blueprintPlanRevisionService = mod.blueprintPlanRevisionService
  buildRevisedApproval = mod.buildRevisedApproval
  approvalGateBlock = mod.approvalGateBlock
} catch (err) {
  console.log(`⚠ blueprint-plan-revision.service load failed — guard tests skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

// ══════════════════════════════════════════════════════════════════════
// The re-raised gate — pure, no DB. Snapshot and event are built from this one
// payload precisely because building them separately let them drift.
// ══════════════════════════════════════════════════════════════════════

if (buildRevisedApproval && approvalGateBlock) {
  const revision = {
    summary: 'Split the migration',
    changes: ['Added step 3a'],
    concerns: ['Backfill may be slow'],
    planMarkdown: '# Plan\nREVISED-BODY'
  }
  const priorApproval = {
    blueprintId: 'bp-1',
    planSummary: 'the plan they objected to',
    completion: { coveragePercent: 97, findings: { critical: 3 } },
    reviewMarkdown: '# Review\nfindings',
    preflight: { result: { checks: [{ id: 'node' }] }, overridden: false }
  }

  describe('buildRevisedApproval', () => {
    test('carries the blueprint id — gate actions address nothing without it', () => {
      const gate = buildRevisedApproval({ blueprintId: 'bp-1', round: 2, revision, priorApproval })
      assert.equal(gate.blueprintId, 'bp-1')
    })

    test('THE REGRESSION: preflight survives a revision round', () => {
      // The snapshot carried preflight and the approvalNeeded event did not, so
      // the renderer's copy of the gate lost its environment checks the moment
      // a revision landed — and the Approve button lost the block that guards it.
      const gate = buildRevisedApproval({ blueprintId: 'bp-1', round: 1, revision, priorApproval })
      assert.deepEqual(gate.preflight, priorApproval.preflight)
    })

    test('omits completion — it measured the plan that just changed', () => {
      const gate = buildRevisedApproval({ blueprintId: 'bp-1', round: 1, revision, priorApproval })
      assert.equal(gate.completion, undefined)
    })

    test('carries reviewMarkdown — the gate relabels it rather than dropping it', () => {
      const gate = buildRevisedApproval({ blueprintId: 'bp-1', round: 1, revision, priorApproval })
      assert.equal(gate.reviewMarkdown, '# Review\nfindings')
    })

    test('the revised plan is the plan on the gate', () => {
      const gate = buildRevisedApproval({ blueprintId: 'bp-1', round: 3, revision, priorApproval })
      assert.equal(gate.revisedPlanMarkdown, '# Plan\nREVISED-BODY')
      assert.match(gate.planSummary, /^Revision round 3: Split the migration/)
      assert.ok(gate.planSummary.includes('Added step 3a'))
      assert.ok(gate.planSummary.includes('Backfill may be slow'))
    })

    test('a first round with no prior gate omits the optional fields entirely', () => {
      // `preflight: undefined` and no `preflight` key differ once the payload is
      // spread into an IPC event — the first overwrites, the second does not.
      const gate = buildRevisedApproval({
        blueprintId: 'bp-1',
        round: 1,
        revision,
        priorApproval: null
      })
      assert.equal('preflight' in gate, false)
      assert.equal('reviewMarkdown' in gate, false)
    })
  })

  describe('approvalGateBlock', () => {
    test('THE REGRESSION: the gate identity is checked, not just the machine state', () => {
      // The machine only says *a* gate is up for the workspace. Without the
      // identity check, a revision aimed at blueprint B while the gate stands
      // for A ran against A's review conversation and re-raised A's gate over
      // B's summary — which is exactly what carrying blueprintId on the gate
      // was for.
      assert.equal(
        approvalGateBlock({
          blueprintId: 'bp-b',
          machineState: 'awaiting-approval',
          gate: { blueprintId: 'bp-a', planSummary: 's' }
        }),
        'wrong-blueprint'
      )
    })

    test('a gate for this blueprint at the gate state is allowed through', () => {
      assert.equal(
        approvalGateBlock({
          blueprintId: 'bp-a',
          machineState: 'awaiting-approval',
          gate: { blueprintId: 'bp-a', planSummary: 's' }
        }),
        null
      )
    })

    test('the machine check still fires when the pipeline has moved on', () => {
      // Neither check subsumes the other: a stale pendingApproval left behind
      // after the pipeline moved on is caught here, not by the identity check.
      assert.equal(
        approvalGateBlock({
          blueprintId: 'bp-a',
          machineState: 'phase-running',
          gate: { blueprintId: 'bp-a', planSummary: 's' }
        }),
        'not-at-gate'
      )
    })

    test('no gate at all is refused, not treated as a match', () => {
      assert.equal(
        approvalGateBlock({ blueprintId: 'bp-a', machineState: 'awaiting-approval', gate: null }),
        'wrong-blueprint'
      )
    })
  })
}

if (!env) {
  describe('revision ledger (skipped — no DB)', () => {
    test('ledger round trip', () => {}, { skipReason: 'no DB' })
  })
} else {
  const wsId = env.wsId

  function seedBlueprint(): string {
    const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Revision test' })
    blueprintPhaseRepository.createAllPhases(bp.id)
    return bp.id
  }

  describe('revision ledger', () => {
    test('a new blueprint has no requests', () => {
      assert.deepEqual(blueprintService.getRevisionRequests(seedBlueprint()), [])
    })

    test('requests accumulate with increasing round numbers', () => {
      const id = seedBlueprint()
      blueprintService.appendRevisionRequest(id, {
        phase: 'review',
        feedback: 'first',
        disposition: 'revised'
      })
      blueprintService.appendRevisionRequest(id, {
        phase: 'review',
        feedback: 'second',
        disposition: 'revised'
      })
      const all = blueprintService.getRevisionRequests(id)
      assert.equal(all.length, 2)
      assert.equal(all[0].round, 1)
      assert.equal(all[0].feedback, 'first')
      assert.equal(all[1].round, 2)
      assert.equal(all[1].feedback, 'second')
    })

    test('THE REGRESSION: the ledger survives rewindToPhase', () => {
      // rewindToPhase() nulls every phase context_snapshot from the target
      // forward. Storing the request there would have it erased by the very
      // rewind it exists to inform — which is the original bug, relocated.
      const id = seedBlueprint()
      blueprintService.appendRevisionRequest(id, {
        phase: 'review',
        feedback: 'must survive the rewind',
        disposition: 'rewound'
      })

      blueprintService.rewindToPhase(id, 'plan')

      const after = blueprintService.getRevisionRequests(id)
      assert.equal(after.length, 1)
      assert.equal(after[0].feedback, 'must survive the rewind')
    })

    test('empty or whitespace feedback is not recorded', () => {
      const id = seedBlueprint()
      assert.equal(
        blueprintService.appendRevisionRequest(id, {
          phase: 'review',
          feedback: '   ',
          disposition: 'revised'
        }),
        null
      )
      assert.deepEqual(blueprintService.getRevisionRequests(id), [])
    })

    test('setLatestRevisionDisposition downgrades only the newest entry', () => {
      // Used when a revision turn fails: the request stays, but it is now
      // queued for a full run rather than already applied.
      const id = seedBlueprint()
      blueprintService.appendRevisionRequest(id, {
        phase: 'review',
        feedback: 'one',
        disposition: 'revised'
      })
      blueprintService.appendRevisionRequest(id, {
        phase: 'review',
        feedback: 'two',
        disposition: 'revised'
      })
      blueprintService.setLatestRevisionDisposition(id, 'rewound')

      const all = blueprintService.getRevisionRequests(id)
      assert.equal(all[0].disposition, 'revised', 'earlier entry untouched')
      assert.equal(all[1].disposition, 'rewound', 'newest entry downgraded')
    })

    test('the ledger reaches assemblePhaseContext', async () => {
      const id = seedBlueprint()
      blueprintService.appendRevisionRequest(id, {
        phase: 'review',
        feedback: 'CONTEXT-MARKER',
        disposition: 'revised'
      })
      const ctx = await blueprintService.assemblePhaseContext(id, 'plan')
      assert.equal(ctx.revisionRequests.length, 1)
      assert.equal(ctx.revisionRequests[0].feedback, 'CONTEXT-MARKER')
    })

    test('round numbers keep climbing past the ledger cap', () => {
      // The cap keeps the newest 20. Deriving the round from list length meant
      // every request after the 20th was numbered 21 — so the transcript showed
      // four "Round 21"s and no way to tell which came first.
      const id = seedBlueprint()
      for (let i = 0; i < 23; i++) {
        blueprintService.appendRevisionRequest(id, {
          phase: 'review',
          feedback: `request ${i + 1}`,
          disposition: 'revised'
        })
      }
      const all = blueprintService.getRevisionRequests(id)
      assert.equal(all.length, 20, 'ledger stays capped')
      assert.equal(all[all.length - 1].round, 23, 'the newest request is round 23, not 21')
      const rounds = all.map((r: { round: number }) => r.round)
      assert.equal(new Set(rounds).size, rounds.length, 'no duplicate round numbers')
    })

    test('over-long feedback is flagged as truncated, not silently cut', () => {
      const id = seedBlueprint()
      const entry = blueprintService.appendRevisionRequest(id, {
        phase: 'review',
        feedback: 'x'.repeat(2500),
        disposition: 'revised'
      })
      assert.equal(entry.truncated, true)
      assert.equal(entry.feedback.length, 2000)

      const short = blueprintService.appendRevisionRequest(id, {
        phase: 'review',
        feedback: 'short',
        disposition: 'revised'
      })
      assert.equal(short.truncated, undefined, 'no flag when nothing was cut')
    })

    test('garbage in settingsJson does not crash the reader', () => {
      // settingsJson is a free-form bag and this value feeds a prompt.
      const id = seedBlueprint()
      const bp = blueprintRepository.findById(id)
      blueprintRepository.update(id, {
        settingsJson: {
          ...bp.settingsJson,
          revisionRequests: ['a string', null, 42, { feedback: 'the real one' }]
        }
      })
      const all = blueprintService.getRevisionRequests(id)
      assert.equal(all.length, 1)
      assert.equal(all[0].feedback, 'the real one')
    })
  })

  // ══════════════════════════════════════════════════════════════════════
  // One authoritative plan; history lives on plan-revision
  // ══════════════════════════════════════════════════════════════════════

  describe('plan artifact after a revision', () => {
    test('a revised plan replaces the previous one rather than duplicating it', () => {
      const id = seedBlueprint()
      const planPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'plan')
      blueprintPhaseRepository.appendArtifact(planPhase.id, {
        type: 'plan',
        contentMd: '# Plan\nv1'
      })
      // What requestChanges() does on each round.
      blueprintPhaseRepository.replaceArtifactOfType(planPhase.id, 'plan', {
        type: 'plan',
        contentMd: '# Plan\nv2'
      })
      blueprintPhaseRepository.replaceArtifactOfType(planPhase.id, 'plan', {
        type: 'plan',
        contentMd: '# Plan\nv3'
      })

      const plans = blueprintPhaseRepository
        .findById(planPhase.id)
        .artifactsJson.filter((a: { type: string }) => a.type === 'plan')
      assert.equal(plans.length, 1, 'exactly one authoritative plan')
      assert.equal(plans[0].contentMd, '# Plan\nv3')
      assert.equal(
        plans[0].contentJson,
        undefined,
        'no contentJson — the loader would render it instead of the markdown'
      )
    })

    test('plan-revision artifacts retain every round, planMarkdown included', () => {
      const id = seedBlueprint()
      const reviewPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'review')
      for (const round of [1, 2, 3]) {
        blueprintPhaseRepository.appendArtifact(reviewPhase.id, {
          type: 'plan-revision',
          contentMd: `## Revision round ${round}`,
          contentJson: {
            round,
            feedback: `ask ${round}`,
            summary: `s${round}`,
            changes: [],
            concerns: [],
            planMarkdown: `# Plan\nv${round}`
          }
        })
      }

      const revisions = blueprintPhaseRepository
        .findById(reviewPhase.id)
        .artifactsJson.filter((a: { type: string }) => a.type === 'plan-revision')
      assert.equal(revisions.length, 3, 'history is append-only')
      assert.equal(revisions[0].contentJson.planMarkdown, '# Plan\nv1')
      assert.equal(revisions[2].contentJson.planMarkdown, '# Plan\nv3')
    })

    test('a re-derived tasks artifact replaces the previous one', () => {
      // acceptRevision() rewinds to TASKS and re-runs it. Appending there would
      // regenerate the duplication the plan path just stopped producing, and
      // REVIEW would receive two contradictory task lists.
      const id = seedBlueprint()
      const tasksPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'tasks')
      blueprintPhaseRepository.replaceArtifactOfType(tasksPhase.id, 'tasks', {
        type: 'tasks',
        contentMd: '# Tasks\nv1'
      })
      blueprintPhaseRepository.replaceArtifactOfType(tasksPhase.id, 'tasks', {
        type: 'tasks',
        contentMd: '# Tasks\nv2'
      })

      const tasks = blueprintPhaseRepository
        .findById(tasksPhase.id)
        .artifactsJson.filter((a: { type: string }) => a.type === 'tasks')
      assert.equal(tasks.length, 1, 'exactly one authoritative task list')
      assert.equal(tasks[0].contentMd, '# Tasks\nv2')
    })

    test('THE REGRESSION: the NEWEST duplicate owns the canonical <type>.md', async () => {
      // Paths are keyed by type, so two artifacts of one type used to write to
      // the same file. Numbering them is only half the fix: review-phase.md
      // tells the agent to Read `plan.md` by name, so numbering the newest one
      // aimed that instruction at the plan the human had already superseded.
      const { mkdtempSync, readFileSync } = require('node:fs')
      const { tmpdir } = require('node:os')
      const { join, resolve: resolvePath } = require('node:path')

      const id = seedBlueprint()
      const planPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'plan')
      blueprintPhaseRepository.appendArtifact(planPhase.id, { type: 'plan', contentMd: 'FIRST' })
      blueprintPhaseRepository.appendArtifact(planPhase.id, { type: 'plan', contentMd: 'SECOND' })

      const wsPath = mkdtempSync(join(tmpdir(), 'bp-artifact-paths-'))
      const ctx = await blueprintService.assemblePhaseContext(id, 'tasks', wsPath)
      const plans = ctx.previousArtifacts.filter((a: { type: string }) => a.type === 'plan')

      // A9: only the newest plan reaches CONTEXT. The superseded copy used to
      // render first and eat the artifact budget, which could push the current
      // plan out with the "artifact(s) truncated" marker.
      assert.equal(plans.length, 1, 'context carries one plan — the current one')
      assert.equal(plans[0].contentMd, 'SECOND')
      assert.ok(plans[0].filePath.endsWith('/plan.md'), 'the newest one is canonical')

      // Both versions still reach DISK, older one numbered, so the truncation
      // marker's "full text on disk" promise holds for every version.
      const dir = plans[0].filePath.slice(0, plans[0].filePath.lastIndexOf('/'))
      assert.equal(readFileSync(resolvePath(wsPath, `${dir}/plan-1.md`), 'utf-8'), 'FIRST')
      assert.equal(readFileSync(resolvePath(wsPath, `${dir}/plan.md`), 'utf-8'), 'SECOND')
    })

    test('three duplicates number the two older ones and leave <type>.md current', async () => {
      const { mkdtempSync, readFileSync } = require('node:fs')
      const { tmpdir } = require('node:os')
      const { join, resolve: resolvePath } = require('node:path')

      const id = seedBlueprint()
      const tasksPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'tasks')
      for (const body of ['T1', 'T2', 'T3']) {
        blueprintPhaseRepository.appendArtifact(tasksPhase.id, { type: 'tasks', contentMd: body })
      }

      const wsPath = mkdtempSync(join(tmpdir(), 'bp-artifact-paths3-'))
      const ctx = await blueprintService.assemblePhaseContext(id, 'review', wsPath)
      const tasks = ctx.previousArtifacts.filter((a: { type: string }) => a.type === 'tasks')

      // A9: one task list in context — the newest.
      assert.equal(tasks.length, 1)
      assert.equal(tasks[0].contentMd, 'T3')
      assert.ok(tasks[0].filePath.endsWith('/tasks.md'))

      // All three still on disk, the two older ones numbered.
      const dir = tasks[0].filePath.slice(0, tasks[0].filePath.lastIndexOf('/'))
      const onDisk = ['tasks-1.md', 'tasks-2.md', 'tasks.md'].map((f) =>
        readFileSync(resolvePath(wsPath, `${dir}/${f}`), 'utf-8')
      )
      assert.deepEqual(onDisk, ['T1', 'T2', 'T3'], 'each path holds its own version')
    })
  })

  // ══════════════════════════════════════════════════════════════════════
  // The gate has to know which blueprint it belongs to
  // ══════════════════════════════════════════════════════════════════════

  describe('gate identity', () => {
    test('THE REGRESSION: pendingApproval keeps its blueprintId after markPipelineStopped', () => {
      // REVIEW's finally calls markPipelineStopped(), which nulls
      // state.blueprintId while the gate is still up. Any snapshot published
      // afterwards — a preflight re-run, say — used to broadcast a gate with
      // blueprintId '' and every gate action silently addressed nothing.
      const id = seedBlueprint()
      const ws = `ws-gate-${id}`
      blueprintService.setPendingApproval(ws, { blueprintId: id, planSummary: 'summary' })
      blueprintService.markPipelineStopped(ws)

      const snap = blueprintService.getSnapshot(ws)
      assert.equal(snap.blueprintId, null, 'the pipeline identity is cleared — that is the trap')
      assert.equal(snap.pendingApproval.blueprintId, id, 'the gate carries its own id')
    })
  })

  // ══════════════════════════════════════════════════════════════════════
  // Guards — a stray call must not raise a gate over running work
  // ══════════════════════════════════════════════════════════════════════

  if (blueprintPlanRevisionService) {
    describe('approval-gate guards', () => {
      test('requestChanges refuses when the machine is not at the gate', async () => {
        const id = seedBlueprint()
        const res = await blueprintPlanRevisionService.requestChanges({
          blueprintId: id,
          workspaceId: `ws-idle-${id}`,
          workspacePath: '/tmp',
          feedback: 'change the schema'
        })
        assert.equal(res.ok, false)
        assert.match(res.error, /approval gate/)
        assert.deepEqual(
          blueprintService.getRevisionRequests(id),
          [],
          'an illegitimate call records nothing'
        )
      })

      test('acceptRevision leaves the gate standing when the machine is not at it', async () => {
        const id = seedBlueprint()
        const ws = `ws-accept-${id}`
        blueprintService.setPendingApproval(ws, { blueprintId: id, planSummary: 'summary' })

        await blueprintPlanRevisionService.acceptRevision({
          blueprintId: id,
          workspaceId: ws,
          workspacePath: '/tmp'
        })

        assert.ok(
          blueprintService.getPendingApproval(ws),
          'the gate is not dismissed and TASKS is not re-derived'
        )
      })
    })
  }
}

// summaryAsync() calls process.exit() — only run it as the entry point.
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
