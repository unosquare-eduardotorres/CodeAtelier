/**
 * Tier 1b (part 4) — idea.runner + specialist.runner behavioural coverage.
 *
 * These runners are deterministic (no LLM), so they run against the REAL
 * repositories on the in-memory test database: the assertions below check both
 * the transcript AND the resulting database state, which is what proves the
 * runner's cleanup is real rather than simulated.
 *
 * e2e-runner-deterministic.test.ts already covers runIdeaCrud and
 * runSpecialistCrud; this file covers the six functions it does not.
 *
 * Run: tsx src/main/services/__tests__/e2e-runners-idea-specialist.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

import { attachTestDb } from '../../db/repositories/__tests__/db-test-helper'
import { serial, tryRequire, makeCtx, statuses, errors, assistantText } from './e2e-runner-harness'

const dbContext = attachTestDb()

if (!dbContext) {
  describe('e2e-runners-idea-specialist (skipped — no DB)', () => {
    test('db_setup_unavailable', () => {
      /* better-sqlite3 unavailable — nothing to assert */
    })
  })
} else {
  const wsId = dbContext.wsId
  const ctx = (o = {}): ReturnType<typeof makeCtx> => makeCtx(wsId, o)

  const ideaMod = tryRequire('../e2e-testing/service-runners/idea.runner')
  const specialistMod = tryRequire('../e2e-testing/service-runners/specialist.runner')
  // Bind the way the RUNNERS bind — via dynamic import. See the note in
  // e2e-service-runners-behavior.test.ts for why `require` alone is not enough
  // in the shared run.
  let repos = tryRequire('../../db/repositories')
  let blueprintSvc = tryRequire('../blueprint.service')?.blueprintService
  void import('../../db/repositories').then((m: any) => {
    repos = m?.ideaRepository ? m : repos
  })
  void import('../blueprint.service').then((m: any) => {
    blueprintSvc = m?.blueprintService ?? blueprintSvc
  })

  const idOf = (status: string): string => status.split(': ')[1]

  /**
   * runSpecialistDispatch writes a conversation_specialists row, so the
   * conversation id in the context must be a REAL row or the insert trips the
   * foreign key. Give each dispatch test its own persisted conversation.
   */
  const convCtx = (o = {}): ReturnType<typeof makeCtx> => {
    const conv = repos.conversationRepository.create(wsId, 'Dispatch Host Conv', 'plan')
    return ctx({ conversationId: conv.id, ...o })
  }

  /**
   * The runners derive agentId from `Date.now()`, so a row left behind by a
   * deliberately-failed run collides with the next one inside the same
   * millisecond. Purge leftovers before each dispatch test.
   */
  const purgeSpecialists = (prefix: string): void => {
    for (const s of repos.specialistRepository.findAll()) {
      if (!s.isCore && typeof s.agentId === 'string' && s.agentId.startsWith(prefix)) {
        try {
          repos.specialistRepository.delete(s.id)
        } catch {
          /* already gone */
        }
      }
    }
  }

  // ── idea.runner — runIdeaStartGrill ────────────────────────────────────────

  describe('idea.runner — runIdeaStartGrill (real repositories)', () => {
    test(
      'links the idea to a new grill conversation and verifies the reverse lookup',
      serial(async () => {
        const t = await ideaMod.runIdeaStartGrill(ctx())
        const s = statuses(t)
        assert.deepEqual(errors(t), [])
        assert.match(s[0], /^idea_created: /)
        assert.match(s[1], /^grill_conv_created: /)
        assert.equal(s[2], 'grill_linked')
      })
    )

    test(
      'the grill conversation is created in plan mode inside the workspace',
      serial(async () => {
        const t = await ideaMod.runIdeaStartGrill(ctx())
        const convId = idOf(statuses(t)[1])
        const conv = repos.conversationRepository.findById(convId)
        assert.ok(conv, 'the conversation must really exist in the database')
        assert.equal(conv.workspaceId, wsId)
        assert.equal(conv.mode, 'plan')
        assert.equal(conv.title, 'E2E Grill Conversation')
      })
    )

    test(
      'the idea is deleted on the way out — cleanup is real',
      serial(async () => {
        const t = await ideaMod.runIdeaStartGrill(ctx())
        const ideaId = idOf(statuses(t)[0])
        assert.equal(repos.ideaRepository.findById(ideaId), undefined)
      })
    )

    test(
      'reports grill_link_failed when the reverse lookup misses',
      serial(async (p) => {
        p.set(repos.ideaRepository, 'findByGrillConversation', () => undefined)
        const t = await ideaMod.runIdeaStartGrill(ctx())
        assert.ok(statuses(t).includes('grill_link_failed'))
      })
    )

    test(
      'reports grill_link_failed when the lookup returns a different idea',
      serial(async (p) => {
        p.set(repos.ideaRepository, 'findByGrillConversation', () => ({ id: 'someone-else' }))
        const t = await ideaMod.runIdeaStartGrill(ctx())
        assert.ok(statuses(t).includes('grill_link_failed'))
      })
    )

    test(
      'an unknown workspace id produces an error entry, not a throw',
      serial(async () => {
        const t = await ideaMod.runIdeaStartGrill(ctx({ workspaceId: 'ws-does-not-exist' }))
        assert.equal(errors(t).length, 1)
        assert.ok(errors(t)[0].length > 0)
      })
    )

    test(
      'the idea status is advanced to grilling before the lookup',
      serial(async (p) => {
        const statusCalls: unknown[][] = []
        const real = repos.ideaRepository.updateStatus.bind(repos.ideaRepository)
        p.set(repos.ideaRepository, 'updateStatus', (...a: unknown[]) => {
          statusCalls.push(a)
          return real(...(a as [string, string]))
        })
        await ideaMod.runIdeaStartGrill(ctx())
        assert.equal(statusCalls.length, 1)
        assert.equal(statusCalls[0][1], 'grilling')
      })
    )
  })

  // ── idea.runner — runIdeaConvert ───────────────────────────────────────────

  describe('idea.runner — runIdeaConvert (real repositories)', () => {
    test(
      'marks the idea completed and points it at the target conversation',
      serial(async () => {
        const t = await ideaMod.runIdeaConvert(ctx())
        assert.deepEqual(errors(t), [])
        const s = statuses(t)
        assert.match(s[0], /^idea_created: /)
        assert.equal(s[1], 'converted')
      })
    )

    test(
      'the target conversation is created in build mode',
      serial(async (p) => {
        const created: unknown[][] = []
        const real = repos.conversationRepository.create.bind(repos.conversationRepository)
        p.set(repos.conversationRepository, 'create', (...a: unknown[]) => {
          created.push(a)
          return real(...(a as [string, string, string]))
        })
        await ideaMod.runIdeaConvert(ctx())
        assert.equal(created.length, 1)
        assert.deepEqual(created[0], [wsId, 'E2E Converted Conversation', 'build'])
      })
    )

    test(
      'reports convert_failed with the observed status when the update did not stick',
      serial(async (p) => {
        p.set(repos.ideaRepository, 'findById', () => ({
          status: 'grilling',
          convertedConversationId: null
        }))
        const t = await ideaMod.runIdeaConvert(ctx())
        assert.ok(
          statuses(t).some((s) => s === 'convert_failed: status=grilling, convId=null'),
          statuses(t).join('|')
        )
      })
    )

    test(
      'reports convert_failed when the idea row vanished',
      serial(async (p) => {
        p.set(repos.ideaRepository, 'findById', () => undefined)
        const t = await ideaMod.runIdeaConvert(ctx())
        assert.ok(statuses(t).some((s) => s.startsWith('convert_failed: status=undefined')))
      })
    )

    test(
      'the idea is deleted on the way out',
      serial(async () => {
        const t = await ideaMod.runIdeaConvert(ctx())
        const ideaId = idOf(statuses(t)[0])
        assert.equal(repos.ideaRepository.findById(ideaId), undefined)
      })
    )

    test(
      'a repository failure becomes an error entry',
      serial(async (p) => {
        p.set(repos.ideaRepository, 'setConvertedConversation', () => {
          throw new Error('fk violation')
        })
        const t = await ideaMod.runIdeaConvert(ctx())
        assert.deepEqual(errors(t), ['fk violation'])
      })
    )
  })

  // ── idea.runner — runIdeaToBlueprint ───────────────────────────────────────

  describe('idea.runner — runIdeaToBlueprint', () => {
    test(
      'reports the phase count when the blueprint service succeeds',
      serial(async (p) => {
        p.set(blueprintSvc, 'createFromIdea', () => ({
          id: 'bp-1',
          phases: [{}, {}, {}, {}, {}, {}, {}]
        }))
        const t = await ideaMod.runIdeaToBlueprint(ctx())
        assert.deepEqual(errors(t), [])
        assert.ok(statuses(t).includes('blueprint_created: phases=7'))
      })
    )

    test(
      'createFromIdea receives the new idea id and the workspace id',
      serial(async (p) => {
        const calls: unknown[][] = []
        p.set(blueprintSvc, 'createFromIdea', (...a: unknown[]) => {
          calls.push(a)
          return { id: 'bp', phases: [] }
        })
        const t = await ideaMod.runIdeaToBlueprint(ctx())
        const ideaId = idOf(statuses(t)[0])
        assert.deepEqual(calls, [[ideaId, wsId]])
      })
    )

    test(
      'a blueprint failure is downgraded to a status, not an error entry',
      serial(async (p) => {
        p.set(blueprintSvc, 'createFromIdea', () => {
          throw new Error('no spec available')
        })
        const t = await ideaMod.runIdeaToBlueprint(ctx())
        assert.deepEqual(errors(t), [], 'the inner catch must absorb blueprint failures')
        assert.ok(statuses(t).includes('blueprint_error: no spec available'))
      })
    )

    test(
      'the idea is still cleaned up after a blueprint failure',
      serial(async (p) => {
        p.set(blueprintSvc, 'createFromIdea', () => {
          throw new Error('boom')
        })
        const t = await ideaMod.runIdeaToBlueprint(ctx())
        const ideaId = idOf(statuses(t)[0])
        assert.equal(repos.ideaRepository.findById(ideaId), undefined)
      })
    )

    test(
      'the seeded idea carries a substantive description for the classifier',
      serial(async (p) => {
        const created: unknown[][] = []
        const real = repos.ideaRepository.create.bind(repos.ideaRepository)
        p.set(repos.ideaRepository, 'create', (...a: unknown[]) => {
          created.push(a)
          return real(...(a as [string, string, string]))
        })
        p.set(blueprintSvc, 'createFromIdea', () => ({ id: 'bp', phases: [] }))
        await ideaMod.runIdeaToBlueprint(ctx())
        assert.equal(created[0][1], 'Build a REST API')
        assert.ok((created[0][2] as string).length > 100, 'description must be substantive')
      })
    )

    test(
      'an idea insert failure becomes an error entry',
      serial(async (p) => {
        p.set(repos.ideaRepository, 'create', () => {
          throw new Error('ideas table missing')
        })
        const t = await ideaMod.runIdeaToBlueprint(ctx())
        assert.deepEqual(errors(t), ['ideas table missing'])
      })
    )
  })

  // ── specialist.runner — runSpecialistSkills ────────────────────────────────

  describe('specialist.runner — runSpecialistSkills (real repositories)', () => {
    test(
      'creates a specialist and a skill, assigns it, and reports the assignment',
      serial(async () => {
        const t = await specialistMod.runSpecialistSkills(ctx())
        assert.deepEqual(errors(t), [])
        const s = statuses(t)
        assert.match(s[0], /^specialist_created: /)
        assert.match(s[1], /^skill_created: /)
        assert.equal(s[2], 'skill_assigned')
      })
    )

    test(
      'both rows are removed again — the runner cleans up after itself',
      serial(async () => {
        const t = await specialistMod.runSpecialistSkills(ctx())
        const s = statuses(t)
        assert.equal(repos.specialistRepository.findById(idOf(s[0])), undefined)
        assert.equal(repos.skillRepository.findById(idOf(s[1])), undefined)
      })
    )

    test(
      'reports skill_assignment_failed when the join row does not come back',
      serial(async (p) => {
        p.set(repos.specialistRepository, 'getSkills', () => [])
        const t = await specialistMod.runSpecialistSkills(ctx())
        assert.ok(statuses(t).includes('skill_assignment_failed'))
      })
    )

    test(
      'reports skill_assignment_failed when a different skill is returned',
      serial(async (p) => {
        p.set(repos.specialistRepository, 'getSkills', () => [{ id: 'some-other-skill' }])
        const t = await specialistMod.runSpecialistSkills(ctx())
        assert.ok(statuses(t).includes('skill_assignment_failed'))
      })
    )

    test(
      'a failing assignment becomes an error entry',
      serial(async (p) => {
        p.set(repos.specialistRepository, 'assignSkill', () => {
          throw new Error('duplicate assignment')
        })
        const t = await specialistMod.runSpecialistSkills(ctx())
        assert.deepEqual(errors(t), ['duplicate assignment'])
      })
    )

    test(
      'the specialist is created active with the documented priority',
      serial(async (p) => {
        const created: any[] = []
        const real = repos.specialistRepository.create.bind(repos.specialistRepository)
        p.set(repos.specialistRepository, 'create', (a: any) => {
          created.push(a)
          return real(a)
        })
        await specialistMod.runSpecialistSkills(ctx())
        assert.equal(created[0].priority, 60)
        assert.equal(created[0].isActive, true)
        assert.match(created[0].agentId, /^e2e-skill-agent-\d+$/)
      })
    )
  })

  // ── specialist.runner — runSpecialistDispatch ──────────────────────────────

  describe('specialist.runner — runSpecialistDispatch', () => {
    test(
      'reports dispatch_ok when the response carries the persona marker',
      serial(async () => {
        purgeSpecialists('e2e-dispatch-agent-')
        const t = await specialistMod.runSpecialistDispatch(
          convCtx({ streamPrompt: async () => [assistantText('SPECIALIST-ACK: 2+2 is 4')] })
        )
        assert.deepEqual(errors(t), [])
        const s = statuses(t)
        assert.match(s[0], /^dispatch_specialist_created: /)
        assert.equal(s[1], 'specialist_assigned_to_conversation')
        assert.equal(s[2], 'dispatch_ok')
      })
    )

    test(
      'the marker match is case-insensitive',
      serial(async () => {
        purgeSpecialists('e2e-dispatch-agent-')
        const t = await specialistMod.runSpecialistDispatch(
          convCtx({ streamPrompt: async () => [assistantText('specialist-ack: hello')] })
        )
        assert.ok(statuses(t).includes('dispatch_ok'), statuses(t).join('|'))
      })
    )

    test(
      'reports dispatch_marker_missing when the persona was ignored',
      serial(async () => {
        purgeSpecialists('e2e-dispatch-agent-')
        const t = await specialistMod.runSpecialistDispatch(
          convCtx({ streamPrompt: async () => [assistantText('Hello! 2 + 2 = 4.')] })
        )
        assert.ok(statuses(t).includes('dispatch_marker_missing'), statuses(t).join('|'))
      })
    )

    test(
      'an empty response also reports the marker as missing',
      serial(async () => {
        purgeSpecialists('e2e-dispatch-agent-')
        const t = await specialistMod.runSpecialistDispatch(convCtx({ streamPrompt: async () => [] }))
        assert.ok(statuses(t).includes('dispatch_marker_missing'), statuses(t).join('|'))
      })
    )

    test(
      'the specialist prompt mandates the marker and is stored on the row',
      serial(async (p) => {
        const created: any[] = []
        const real = repos.specialistRepository.create.bind(repos.specialistRepository)
        p.set(repos.specialistRepository, 'create', (a: any) => {
          created.push(a)
          return real(a)
        })
        purgeSpecialists('e2e-dispatch-agent-')
        await specialistMod.runSpecialistDispatch(convCtx({ streamPrompt: async () => [] }))
        assert.match(created[0].prompt, /SPECIALIST-ACK:/)
        assert.equal(created[0].priority, 10)
      })
    )

    test(
      'the conversation override and the specialist row are both cleaned up',
      serial(async () => {
        purgeSpecialists('e2e-dispatch-agent-')
        const c = convCtx({ streamPrompt: async () => [] })
        const t = await specialistMod.runSpecialistDispatch(c)
        assert.deepEqual(errors(t), [])
        const specialistId = idOf(statuses(t)[0])
        assert.equal(repos.specialistRepository.findById(specialistId), undefined)
        const override = repos.conversationSpecialistRepository.findByConversationAndSpecialist(
          c.conversationId,
          specialistId
        )
        assert.ok(!override, 'the per-conversation override must not survive the run')
      })
    )

    test(
      'a rejecting streamPrompt becomes an error entry',
      serial(async () => {
        purgeSpecialists('e2e-dispatch-agent-')
        const t = await specialistMod.runSpecialistDispatch(
          convCtx({
            streamPrompt: async () => {
              throw new Error('model unavailable')
            }
          })
        )
        assert.deepEqual(errors(t), ['model unavailable'])
        purgeSpecialists('e2e-dispatch-agent-')
      })
    )
  })

  // ── specialist.runner — runSpecialistOverride ──────────────────────────────

  describe('specialist.runner — runSpecialistOverride (real repositories)', () => {
    test(
      'disabling a specialist for one conversation leaves the other active',
      serial(async () => {
        const t = await specialistMod.runSpecialistOverride(ctx())
        assert.deepEqual(errors(t), [])
        const s = statuses(t)
        assert.match(s[0], /^specialist_created: /)
        assert.equal(s[1], 'override_set_inactive_for_conv1')
        assert.equal(s[2], 'override_applied')
      })
    )

    test(
      'two distinct conversations are created for the isolation check',
      serial(async (p) => {
        const created: unknown[][] = []
        const real = repos.conversationRepository.create.bind(repos.conversationRepository)
        p.set(repos.conversationRepository, 'create', (...a: unknown[]) => {
          created.push(a)
          return real(...(a as [string, string, string]))
        })
        await specialistMod.runSpecialistOverride(ctx())
        assert.equal(created.length, 2)
        assert.equal(created[0][1], 'Override Test Conv 1')
        assert.equal(created[1][1], 'Override Test Conv 2')
        assert.equal(created[0][2], 'plan')
      })
    )

    test(
      'upsert is called three times — assign both, then disable the first',
      serial(async (p) => {
        const calls: unknown[][] = []
        const real = repos.conversationSpecialistRepository.upsert.bind(
          repos.conversationSpecialistRepository
        )
        p.set(repos.conversationSpecialistRepository, 'upsert', (...a: unknown[]) => {
          calls.push(a)
          return real(...(a as [string, string, { isActive: boolean }]))
        })
        await specialistMod.runSpecialistOverride(ctx())
        assert.equal(calls.length, 3)
        assert.deepEqual(calls[0][2], { isActive: true })
        assert.deepEqual(calls[1][2], { isActive: true })
        assert.deepEqual(calls[2][2], { isActive: false })
        assert.equal(calls[0][0], calls[2][0], 'the third upsert must target conversation 1')
      })
    )

    test(
      'reports a mismatch when conv1 was not actually disabled',
      serial(async (p) => {
        p.set(repos.conversationSpecialistRepository, 'findByConversationAndSpecialist', () => ({
          isActive: true
        }))
        const t = await specialistMod.runSpecialistOverride(ctx())
        assert.ok(
          statuses(t).some((s) => s === 'override_mismatch: conv1Active=true, conv2Active=true')
        )
      })
    )

    test(
      'reports a mismatch when the override rows are missing entirely',
      serial(async (p) => {
        // `upsert` resolves insert-vs-update through findByConversationAndSpecialist,
        // so the write has to be stubbed out too — otherwise the second upsert for
        // the same pair is treated as an insert and trips the UNIQUE constraint.
        p.set(repos.conversationSpecialistRepository, 'upsert', () => undefined)
        p.set(repos.conversationSpecialistRepository, 'findByConversationAndSpecialist', () => null)
        const t = await specialistMod.runSpecialistOverride(ctx())
        assert.ok(
          statuses(t).some((s) =>
            s.startsWith('override_mismatch: conv1Active=undefined, conv2Active=undefined')
          ),
          `statuses=${statuses(t).join('|')} errors=${errors(t).join('|')}`
        )
      })
    )

    test(
      'the specialist row is deleted and both overrides removed',
      serial(async () => {
        const t = await specialistMod.runSpecialistOverride(ctx())
        const specialistId = idOf(statuses(t)[0])
        assert.equal(repos.specialistRepository.findById(specialistId), undefined)
      })
    )

    test(
      'a repository failure becomes an error entry',
      serial(async (p) => {
        p.set(repos.conversationSpecialistRepository, 'upsert', () => {
          throw new Error('override table locked')
        })
        const t = await specialistMod.runSpecialistOverride(ctx())
        assert.deepEqual(errors(t), ['override table locked'])
      })
    )
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
