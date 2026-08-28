/**
 * Behavioural coverage for the deterministic (no-LLM) E2E service runners in
 * src/main/services/e2e-testing/service-runners/.
 *
 * Replaces the "module exports something" pattern in
 * e2e-service-runners-phase25.test.ts with real assertions on the transcript
 * every runner returns — per the documented service-runner contract:
 *   (ctx: E2EServiceContext) => Promise<E2ETranscriptEntry[]>
 * where runners catch their own errors and push a {role:'system', type:'error'}
 * entry rather than throwing, so the transcript itself is the thing to assert.
 *
 * Only the deterministic runners (no LLM, no child process) are covered here —
 * blueprint.runner, idea.runner, specialist.runner all exercise real repository
 * code against a real in-memory DB (trySetupTestDb). LLM-dependent runners
 * (grill/audit/council/mpa/memory/chat-edge) and the process/filesystem-heavy
 * workspace-ops runners are out of scope for this file.
 *
 * Run: tsx src/main/services/__tests__/e2e-runner-deterministic.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

import { trySetupTestDb } from '../../db/repositories/__tests__/db-test-helper'
import type { E2EServiceContext } from '../e2e-testing/service-runners/index'

const dbContext = trySetupTestDb()

if (!dbContext) {
  describe('e2e-runner-deterministic (skipped — no DB)', () => {
    test('db_setup_unavailable', () => {
      // better-sqlite3 unavailable in this environment — nothing to assert.
    })
  })
} else {
  const { wsId } = dbContext

  function makeCtx(overrides: Partial<E2EServiceContext> = {}): E2EServiceContext {
    return {
      workspaceId: wsId,
      workspacePath: '/tmp/e2e-runner-deterministic-fixture',
      modelId: 'test-model',
      conversationId: `conv-${Math.random().toString(36).slice(2)}`,
      signal: new AbortController().signal,
      streamPrompt: async () => {
        throw new Error('streamPrompt should not be called by a deterministic runner')
      },
      ...overrides
    }
  }

  // ── blueprint.runner — runBlueprintCreate ──

  describe('runBlueprintCreate — behavioural (Phase 25 rewrite)', () => {
    test('emits assistant JSON with id/title/phases, then blueprint_created status', async () => {
      const { runBlueprintCreate } = require('../e2e-testing/service-runners/blueprint.runner')
      const transcript = await runBlueprintCreate(makeCtx())

      const errorEntries = transcript.filter((e: any) => e.type === 'error')
      assert.deepEqual(
        errorEntries,
        [],
        `unexpected error entries: ${JSON.stringify(errorEntries)}`
      )

      const textEntry = transcript.find((e: any) => e.role === 'assistant' && e.type === 'text')
      assert.ok(textEntry, 'expected an assistant text entry carrying the blueprint JSON')
      const parsed = JSON.parse(textEntry!.content!)
      assert.ok(typeof parsed.id === 'string' && parsed.id.length > 0)
      assert.equal(parsed.title, 'E2E Test Blueprint')
      assert.ok(Array.isArray(parsed.phases))
      // One row per BLUEPRINT_PHASE_ORDER entry — 8 since the code-review phase
      // was added between build and verify.
      assert.equal(parsed.phases.length, 8)
      assert.ok(
        parsed.phases.every((p: any) => typeof p.type === 'string' && typeof p.status === 'string')
      )

      const statusEntry = transcript.find(
        (e: any) => e.type === 'status' && e.content === 'blueprint_created'
      )
      assert.ok(statusEntry, 'expected a blueprint_created status entry')
    })

    test('deletes the blueprint it created — cleanup is real behaviour, not a no-op', async () => {
      const { runBlueprintCreate } = require('../e2e-testing/service-runners/blueprint.runner')
      const { blueprintService } = require('../blueprint.service')

      const transcript = await runBlueprintCreate(makeCtx())
      const textEntry = transcript.find((e: any) => e.role === 'assistant' && e.type === 'text')
      const { id } = JSON.parse(textEntry!.content!)

      const afterRun = blueprintService.getBlueprint(id)
      assert.ok(!afterRun, 'runBlueprintCreate should delete the blueprint before returning')
    })

    test('a workspaceId that fails the FK check produces a system/error entry, not a throw', async () => {
      const { runBlueprintCreate } = require('../e2e-testing/service-runners/blueprint.runner')
      const transcript = await runBlueprintCreate(
        makeCtx({ workspaceId: 'nonexistent-workspace-id' })
      )

      assert.equal(transcript.length, 1)
      assert.equal(transcript[0].role, 'system')
      assert.equal(transcript[0].type, 'error')
      assert.match(transcript[0].content, /Workspace not found/)
    })
  })

  // ── blueprint.runner — runBlueprintPhaseManagement ──

  describe('runBlueprintPhaseManagement — behavioural', () => {
    test('advances, skips, and rewinds phases, and cleans up', async () => {
      const {
        runBlueprintPhaseManagement
      } = require('../e2e-testing/service-runners/blueprint.runner')
      const { blueprintRepository } = require('../../db/repositories')

      const before = blueprintRepository.findByWorkspace(wsId).length
      const transcript = await runBlueprintPhaseManagement(makeCtx())

      const errorEntries = transcript.filter((e: any) => e.type === 'error')
      assert.deepEqual(
        errorEntries,
        [],
        `unexpected error entries: ${JSON.stringify(errorEntries)}`
      )

      const advanced = transcript.find((e: any) => String(e.content).startsWith('phase_advanced:'))
      assert.ok(advanced, 'expected a phase_advanced status entry')
      assert.equal(advanced!.content, 'phase_advanced: clarify')

      const rewound = transcript.find((e: any) => String(e.content).startsWith('phase_rewound:'))
      assert.ok(rewound, 'expected a phase_rewound status entry')

      // The runner creates its own blueprint internally and deletes it before returning —
      // the workspace's blueprint count must be unchanged after the run.
      const after = blueprintRepository.findByWorkspace(wsId).length
      assert.equal(
        after,
        before,
        'runBlueprintPhaseManagement should delete the blueprint it created'
      )
    })
  })

  // ── blueprint.runner — runBlueprintProgressTracking ──

  describe('runBlueprintProgressTracking — behavioural', () => {
    test('populates tasks and reports correct wave grouping', async () => {
      const {
        runBlueprintProgressTracking
      } = require('../e2e-testing/service-runners/blueprint.runner')

      const transcript = await runBlueprintProgressTracking(makeCtx())

      const errorEntries = transcript.filter((e: any) => e.type === 'error')
      assert.deepEqual(
        errorEntries,
        [],
        `unexpected error entries: ${JSON.stringify(errorEntries)}`
      )

      const tasksPopulated = transcript.find((e: any) =>
        String(e.content).startsWith('tasks_populated:')
      )
      assert.ok(tasksPopulated)
      assert.equal(tasksPopulated!.content, 'tasks_populated: 5')

      const wavesVerified = transcript.find((e: any) =>
        String(e.content).startsWith('waves_verified:')
      )
      assert.ok(wavesVerified)
      // 5 tasks split across waves 1 (2 tasks), 2 (2 tasks), 3 (1 task) per the runner's fixture.
      assert.match(wavesVerified!.content, /wave1: 2/)
      assert.match(wavesVerified!.content, /wave2: 2/)
      assert.match(wavesVerified!.content, /wave3: 1/)
    })
  })

  // ── idea.runner — runIdeaCrud ──

  describe('runIdeaCrud — behavioural', () => {
    test('creates, updates, reads back, and deletes the idea', async () => {
      const { runIdeaCrud } = require('../e2e-testing/service-runners/idea.runner')
      const transcript = await runIdeaCrud(makeCtx())

      const errorEntries = transcript.filter((e: any) => e.type === 'error')
      assert.deepEqual(
        errorEntries,
        [],
        `unexpected error entries: ${JSON.stringify(errorEntries)}`
      )

      assert.ok(transcript.some((e: any) => String(e.content).startsWith('idea_created:')))
      assert.ok(
        transcript.some((e: any) => e.content === 'idea_updated: E2E Test Idea — Updated'),
        `expected idea_updated status, got: ${JSON.stringify(transcript.map((e: any) => e.content))}`
      )
      assert.ok(transcript.some((e: any) => e.content === 'idea_read_verified'))
      assert.ok(transcript.some((e: any) => e.content === 'idea_deleted'))
      assert.ok(!transcript.some((e: any) => e.content === 'idea_delete_failed'))
    })

    test('the created idea does not survive the run — real cleanup, not simulated', async () => {
      const { runIdeaCrud } = require('../e2e-testing/service-runners/idea.runner')
      const { ideaRepository } = require('../../db/repositories')

      const before = ideaRepository.findByWorkspace(wsId).length
      await runIdeaCrud(makeCtx())
      const after = ideaRepository.findByWorkspace(wsId).length

      assert.equal(after, before, 'runIdeaCrud should leave the idea count unchanged after cleanup')
    })
  })

  // ── specialist.runner — runSpecialistCrud ──

  describe('runSpecialistCrud — behavioural', () => {
    test('creates and updates a custom specialist, and reports core-specialist protection', async () => {
      const { runSpecialistCrud } = require('../e2e-testing/service-runners/specialist.runner')
      const transcript = await runSpecialistCrud(makeCtx())

      const errorEntries = transcript.filter((e: any) => e.type === 'error')
      assert.deepEqual(
        errorEntries,
        [],
        `unexpected error entries: ${JSON.stringify(errorEntries)}`
      )

      assert.ok(transcript.some((e: any) => String(e.content).startsWith('specialist_created:')))
      assert.ok(
        transcript.some(
          (e: any) => e.content === 'specialist_updated: E2E Test Specialist — Updated'
        )
      )
      // Whatever the core-protection outcome, the runner must report SOME verdict —
      // it must never silently skip the assertion. (A fresh in-memory test DB has
      // no seeded core specialist, so 'core_specialist_not_found' is also valid.)
      assert.ok(
        transcript.some((e: any) =>
          ['core_protected', 'core_unexpectedly_deletable', 'core_specialist_not_found'].includes(
            e.content
          )
        ),
        `expected a core-protection verdict, got: ${JSON.stringify(transcript.map((e: any) => e.content))}`
      )

      const deleted = transcript.find((e: any) => e.content === 'specialist_deleted')
      assert.ok(deleted, 'expected the runner to clean up the specialist it created')
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
