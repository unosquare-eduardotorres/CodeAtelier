/**
 * recall-server.ts — real tool-handler coverage.
 *
 * The old recall-server.test never imported this module (0% lines). These
 * tests capture the actual McpServer.tool registrations and invoke the real
 * handlers, covering the filter chains, ref resolution, lineage lookup and
 * conversation windowing in the handler bodies themselves.
 *
 * Repository plumbing: recall-server loads its repositories via dynamic
 * `import()`, which under tsx goes through the ESM loader and bypasses
 * setupFullMock's Module._load interception. So instead of the full mock, this
 * file imports the SAME modules the same way (ESM cache → same singletons)
 * and patches the repository methods directly.
 *
 * Run: tsx src/main/mcp-servers/__tests__/recall-server-tools.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync, runExclusive } from '../../services/__tests__/test-harness'
import { setupElectronStub } from '../../services/__tests__/electron-stub'
import { patchToolCapture, invokeTool } from './mcp-tool-capture'

setupElectronStub()

const WS = 'ws-recall-tools'
process.env.WORKSPACE_ID = WS

// Fresh module load with the capture patch active — an earlier file in the
// unified run may have loaded this module without WORKSPACE_ID set.
const recallPath = require.resolve('../recall-server')
delete require.cache[recallPath]

const capture = patchToolCapture()
let recallMod: any = null
let registrationError: unknown
try {
  recallMod = require('../recall-server')
  recallMod.registerToolSchemas()
} catch (err) {
  registrationError = err
} finally {
  capture.restore()
}

// ── Repository patching ─────────────────────────────────────────────────────
//
// recall-server loads its repositories via dynamic `import()`. Under tsx that
// resolves through the CJS cache once the module is loaded, but the circular
// db module graph (conversation.repository ⇄ base-repository) throws a TDZ
// ReferenceError if a repository is the cycle's ENTRY point. Requiring
// base-repository first breaks the cycle the same way the repository test
// files do. The singletons below are the exact objects recall-server's
// ensureReady resolves — their methods are patched per test.

let planRepo: any
let msgRepo: any
let convoRepo: any

const prelude: Promise<void> = (async () => {
  // Cycle-safe load order (same as the repository test files): db/index first,
  // so conversation.repository's `extends BaseRepository` runs after
  // base-repository finished initializing.
  require('../../db/index')
  planRepo = require('../../db/repositories/plan.repository').planRepository
  msgRepo = require('../../db/repositories/message.repository').messageRepository
  convoRepo = require('../../db/repositories/conversation.repository').conversationRepository
})()

function planRecord(over: Record<string, unknown> = {}): any {
  return {
    id: 'p1',
    workspaceId: WS,
    source: 'chat',
    sourceId: 'src-1',
    title: 'Refactor auth',
    summary: 'Rotate refresh tokens on a schedule',
    planType: null,
    structuredPlan: { summary: 'Rotate refresh tokens on a schedule' },
    sourcePlanJson: null,
    requirementDocument: null,
    status: 'active',
    linkedConversationId: 'conv-1',
    linkedMpaRunId: null,
    linkedCouncilSessionId: null,
    fileCount: 2,
    phaseCount: 1,
    riskCount: 0,
    createdAt: '2026-09-01 10:00:00',
    updatedAt: '2026-09-01 10:00:00',
    completedAt: null,
    previousPlanId: null,
    ...over
  }
}

function textOf(result: any): string {
  assert.ok(result?.content?.[0]?.type === 'text', 'tool result must carry text content')
  return result.content[0].text as string
}

describe('recall-server — tool registration', () => {
  test('three tools register without error', async () => {
  // Tests patch the shared repository singletons — serialize so they
  // don't race each other's fixtures (harness runs async tests concurrently).
  await runExclusive(async () => {
      await prelude
      assert.equal(registrationError, undefined, `registration threw: ${registrationError}`)
      assert.deepEqual(capture.names, ['recall_plans', 'recall_plan', 'recall_conversation'])
  })
  })
})

describe('recall-server — recall_plans', () => {
  test('empty workspace lists the no-plans message', async () => {
  // Tests patch the shared repository singletons — serialize so they
  // don't race each other's fixtures (harness runs async tests concurrently).
  await runExclusive(async () => {
      await prelude
      planRepo.getForWorkspace = () => []
      msgRepo.findPlanBlockMessages = () => []
      const out = textOf(await invokeTool(capture, 'recall_plans', {}))
      assert.ok(out.includes('No past plans recorded'), out)
  })
  })

  test('registry entries render with refs, and message entries merge in', async () => {
  // Tests patch the shared repository singletons — serialize so they
  // don't race each other's fixtures (harness runs async tests concurrently).
  await runExclusive(async () => {
      await prelude
      planRepo.getForWorkspace = () => [planRecord({ id: 'p1', title: 'Refactor auth' })]
      msgRepo.findPlanBlockMessages = () => [
        {
          id: 'm9',
          conversationId: 'conv-2',
          conversationTitle: 'Grill: billing',
          createdAt: '2026-09-02 11:00:00',
          contentMd: 'prose\n```plan\n# Migrate billing\nSwitch to metered billing\n```\n'
        }
      ]
      const out = textOf(await invokeTool(capture, 'recall_plans', {}))
      assert.ok(out.includes('[plan:p1] Refactor auth'), out)
      assert.ok(out.includes('[msg:m9] Migrate billing'), out)
      assert.ok(out.includes('conversation: "Grill: billing"'), out)
  })
  })

  test('query and source filters apply, limit slices', async () => {
  // Tests patch the shared repository singletons — serialize so they
  // don't race each other's fixtures (harness runs async tests concurrently).
  await runExclusive(async () => {
      await prelude
      planRepo.getForWorkspace = () => [
        planRecord({ id: 'p1', title: 'Refactor auth' }),
        planRecord({ id: 'p2', title: 'Harden billing', source: 'grill' }),
        planRecord({ id: 'p3', title: 'Refactor tests' })
      ]
      msgRepo.findPlanBlockMessages = () => []
      const tools = capture.tools.get('recall_plans')!

      const queried = textOf(await invokeTool(capture, 'recall_plans', { query: 'refactor' }))
      assert.ok(queried.includes('Refactor auth') && queried.includes('Refactor tests'), queried)
      assert.ok(!queried.includes('Harden billing'), queried)

      const bySource = textOf(await invokeTool(capture, 'recall_plans', { source: 'grill' }))
      assert.ok(bySource.includes('Harden billing') && !bySource.includes('Refactor auth'), bySource)

      const limited = textOf(await invokeTool(capture, 'recall_plans', { limit: 1 }))
      assert.ok(limited.includes('1 plan(s)'), limited)
  })
  })

  test('includeSuperseded=false hides archived rows', async () => {
  // Tests patch the shared repository singletons — serialize so they
  // don't race each other's fixtures (harness runs async tests concurrently).
  await runExclusive(async () => {
      await prelude
      planRepo.getForWorkspace = () => [
        planRecord({ id: 'p1', title: 'Current plan', status: 'active' }),
        planRecord({ id: 'p0', title: 'Old revision', status: 'archived' })
      ]
      msgRepo.findPlanBlockMessages = () => []
      const out = textOf(
        await invokeTool(capture, 'recall_plans', { includeSuperseded: false })
      )
      assert.ok(out.includes('Current plan'), out)
      assert.ok(!out.includes('Old revision'), out)
  })
  })
})

describe('recall-server — recall_plan', () => {
  test('plan: ref returns full detail with lineage', async () => {
  // Tests patch the shared repository singletons — serialize so they
  // don't race each other's fixtures (harness runs async tests concurrently).
  await runExclusive(async () => {
      await prelude
      planRepo.getById = () => planRecord({ id: 'p1', previousPlanId: 'p0' })
      planRepo.getPreviousPlan = () => planRecord({ id: 'p0', title: 'Old revision' })
      planRepo.getSupersedingPlan = () => null
      const out = textOf(await invokeTool(capture, 'recall_plan', { ref: 'plan:p1' }))
      assert.ok(out.includes('Refactor auth'), out)
      assert.ok(out.includes('plan:p0'), out) // lineage names the previous revision
  })
  })

  test('unknown ref yields actionable guidance', async () => {
  // Tests patch the shared repository singletons — serialize so they
  // don't race each other's fixtures (harness runs async tests concurrently).
  await runExclusive(async () => {
      await prelude
      planRepo.getById = () => null
      msgRepo.findById = () => null
      const out = textOf(await invokeTool(capture, 'recall_plan', { ref: 'plan:nope' }))
      assert.ok(out.includes('No plan found for ref "plan:nope"'), out)
  })
  })

  test('plan from another workspace is not served (workspace scoping)', async () => {
  // Tests patch the shared repository singletons — serialize so they
  // don't race each other's fixtures (harness runs async tests concurrently).
  await runExclusive(async () => {
      await prelude
      planRepo.getById = () => planRecord({ id: 'px', workspaceId: 'ws-other' })
      msgRepo.findById = () => null
      const out = textOf(await invokeTool(capture, 'recall_plan', { ref: 'plan:px' }))
      assert.ok(out.includes('No plan found'), out)
  })
  })

  test('msg: ref resolves through message + conversation', async () => {
  // Tests patch the shared repository singletons — serialize so they
  // don't race each other's fixtures (harness runs async tests concurrently).
  await runExclusive(async () => {
      await prelude
      planRepo.getById = () => null
      msgRepo.findById = () => ({
        id: 'm9',
        conversationId: 'conv-2',
        createdAt: '2026-09-02 11:00:00',
        contentMd: '```plan\n# Migrate billing\nSwitch to metered billing\n```'
      })
      convoRepo.findById = () => ({ id: 'conv-2', workspaceId: WS, title: 'Grill: billing' })
      const out = textOf(await invokeTool(capture, 'recall_plan', { ref: 'msg:m9' }))
      assert.ok(out.includes('Migrate billing'), out)
  })
  })
})

describe('recall-server — recall_conversation', () => {
  test('no conversation link explains the source instead', async () => {
  // Tests patch the shared repository singletons — serialize so they
  // don't race each other's fixtures (harness runs async tests concurrently).
  await runExclusive(async () => {
      await prelude
      planRepo.getById = () => planRecord({ id: 'p1', linkedConversationId: null, source: 'grill' })
      const out = textOf(await invokeTool(capture, 'recall_conversation', { ref: 'plan:p1' }))
      assert.ok(out.includes('not linked to a chat conversation'), out)
      assert.ok(out.includes('grill'), out)
  })
  })

  test('conversation gone from the workspace is reported unavailable', async () => {
  // Tests patch the shared repository singletons — serialize so they
  // don't race each other's fixtures (harness runs async tests concurrently).
  await runExclusive(async () => {
      await prelude
      planRepo.getById = () => planRecord({ id: 'p1' })
      convoRepo.findById = () => null
      const out = textOf(await invokeTool(capture, 'recall_conversation', { ref: 'plan:p1' }))
      assert.ok(out.includes('no longer available'), out)
  })
  })

  test('window is anchored and rendered around the plan message', async () => {
  // Tests patch the shared repository singletons — serialize so they
  // don't race each other's fixtures (harness runs async tests concurrently).
  await runExclusive(async () => {
      await prelude
      planRepo.getById = () => null
      msgRepo.findById = () => ({
        id: 'm5',
        conversationId: 'conv-2',
        createdAt: '2026-09-02 11:00:03',
        contentMd: '```plan\n# Migrate billing\n```'
      })
      convoRepo.findById = () => ({ id: 'conv-2', workspaceId: WS, title: 'Grill: billing' })
      msgRepo.findByConversation = () =>
        ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'].map((id, i) => ({
          id,
          role: i % 2 === 0 ? 'user' : 'assistant',
          createdAt: `2026-09-02 11:00:0${i}`,
          hidden: false,
          contentMd: `message ${id}`
        }))
      const out = textOf(
        await invokeTool(capture, 'recall_conversation', { ref: 'msg:m5', before: 2, after: 1 })
      )
      assert.ok(out.includes('Grill: billing'), out)
      assert.ok(out.includes('m3') && out.includes('m6'), out) // window spans the anchor
  })
  })

  test('hidden messages are excluded from the window', async () => {
  // Tests patch the shared repository singletons — serialize so they
  // don't race each other's fixtures (harness runs async tests concurrently).
  await runExclusive(async () => {
      await prelude
      planRepo.getById = () => null
      msgRepo.findById = () => ({
        id: 'm5',
        conversationId: 'conv-2',
        createdAt: '2026-09-02 11:00:03',
        contentMd: '```plan\n# Migrate billing\n```'
      })
      convoRepo.findById = () => ({ id: 'conv-2', workspaceId: WS, title: 'Grill: billing' })
      msgRepo.findByConversation = () => [
        {
          id: 'm4',
          role: 'user',
          createdAt: '2026-09-02 11:00:02',
          hidden: true,
          contentMd: 'secret'
        },
        {
          id: 'm5',
          role: 'assistant',
          createdAt: '2026-09-02 11:00:03',
          hidden: false,
          contentMd: '```plan\n# Migrate billing\n```'
        },
        { id: 'm6', role: 'user', createdAt: '2026-09-02 11:00:04', hidden: false, contentMd: 'visible' }
      ]
      const out = textOf(await invokeTool(capture, 'recall_conversation', { ref: 'msg:m5' }))
      assert.ok(!out.includes('secret'), out)
      assert.ok(out.includes('visible'), out)
  })
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
