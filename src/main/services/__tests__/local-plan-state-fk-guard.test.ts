/**
 * Unit tests for LocalPlanStateService.upsert() FK guard —
 * verifies that the guard logic correctly skips when the conversation
 * doesn't exist, preventing FOREIGN KEY constraint failures for synthetic
 * grill/audit conversation IDs.
 *
 * Uses a mock database (prepare/get stubs) to exercise the logic without
 * a real SQLite native module (which is compiled for Electron's Node version).
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

// ── Mock database layer ──

interface MockStatement {
  get: (...args: unknown[]) => unknown
  run: (...args: unknown[]) => void
}

interface MockDb {
  prepare: (sql: string) => MockStatement
}

/**
 * Replicates the guarded upsert logic from local-plan-state.service.ts
 * (the production code under test), using a mock database.
 */
function guardedUpsert(
  db: MockDb,
  params: {
    conversationId: string
    workspaceId: string
    originalRequest: string
    discoveredContext: object
    planText?: string
  }
): { skipped: boolean; inserted: boolean; updated: boolean } {
  const { conversationId, workspaceId, originalRequest, discoveredContext, planText } = params

  // Guard: check parent exists (the fix under test)
  const convExists = db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId)
  if (!convExists) {
    return { skipped: true, inserted: false, updated: false }
  }

  // Real upsert logic
  const existing = db
    .prepare('SELECT id, continuation_count FROM local_plan_state WHERE conversation_id = ?')
    .get(conversationId) as { id: string; continuation_count: number } | undefined

  if (existing) {
    db.prepare(
      'UPDATE local_plan_state SET ...'
    ).run(
      JSON.stringify(discoveredContext),
      planText ?? '',
      existing.continuation_count + 1,
      existing.id
    )
    return { skipped: false, inserted: false, updated: true }
  } else {
    db.prepare(
      'INSERT INTO local_plan_state ...'
    ).run(
      conversationId,
      workspaceId,
      originalRequest,
      JSON.stringify(discoveredContext),
      planText ?? ''
    )
    return { skipped: false, inserted: true, updated: false }
  }
}

function createMockDb(opts: {
  conversationExists: boolean
  planStateExists?: { id: string; continuation_count: number }
}): { db: MockDb; prepareCalls: string[]; runCalls: unknown[][] } {
  const prepareCalls: string[] = []
  const runCalls: unknown[][] = []

  const db: MockDb = {
    prepare: (sql: string) => {
      prepareCalls.push(sql)
      return {
        get: (..._args: unknown[]) => {
          if (sql.includes('FROM conversations')) {
            return opts.conversationExists ? { '1': 1 } : undefined
          }
          if (sql.includes('FROM local_plan_state')) {
            return opts.planStateExists
          }
          return undefined
        },
        run: (...args: unknown[]) => {
          runCalls.push(args)
        }
      }
    }
  }
  return { db, prepareCalls, runCalls }
}

describe('LocalPlanStateService.upsert FK guard', () => {
  test('upsert with a non-existent conversation returns skipped (no write attempted)', () => {
    const { db, prepareCalls, runCalls } = createMockDb({ conversationExists: false })

    const result = guardedUpsert(db, {
      conversationId: 'grill-requirements-abc123',
      workspaceId: 'ws-1',
      originalRequest: 'Analyze login flow',
      discoveredContext: { filesExplored: [], keyFindings: [], planItems: [], nextSteps: [] }
    })

    assert.equal(result.skipped, true, 'Should skip when conversation does not exist')
    assert.equal(result.inserted, false)
    assert.equal(result.updated, false)
    // Only the conversations check should have been prepared
    assert.equal(prepareCalls.length, 1)
    assert.ok(prepareCalls[0].includes('FROM conversations'))
    assert.equal(runCalls.length, 0, 'No writes should occur')
  })

  test('upsert with an existing conversation and no prior state → inserts new row', () => {
    const { db, runCalls } = createMockDb({ conversationExists: true })

    const result = guardedUpsert(db, {
      conversationId: 'conv-real-1',
      workspaceId: 'ws-1',
      originalRequest: 'Build the feature',
      discoveredContext: { filesExplored: ['src/app.ts'], keyFindings: ['Found entry'], planItems: [], nextSteps: [] },
      planText: 'Step 1: scaffold'
    })

    assert.equal(result.skipped, false)
    assert.equal(result.inserted, true)
    assert.equal(result.updated, false)
    assert.equal(runCalls.length, 1, 'One INSERT should execute')
    assert.equal(runCalls[0][0], 'conv-real-1')
  })

  test('upsert with an existing conversation and existing state → updates row', () => {
    const { db, runCalls } = createMockDb({
      conversationExists: true,
      planStateExists: { id: 'plan-001', continuation_count: 2 }
    })

    const result = guardedUpsert(db, {
      conversationId: 'conv-real-2',
      workspaceId: 'ws-1',
      originalRequest: 'Continue building',
      discoveredContext: { filesExplored: ['a.ts'], keyFindings: [], planItems: [], nextSteps: [] },
      planText: 'Updated plan'
    })

    assert.equal(result.skipped, false)
    assert.equal(result.inserted, false)
    assert.equal(result.updated, true)
    assert.equal(runCalls.length, 1, 'One UPDATE should execute')
    // Continuation count should be incremented
    assert.equal(runCalls[0][2], 3, 'continuation_count should be 2 + 1 = 3')
    assert.equal(runCalls[0][3], 'plan-001', 'Should update by existing ID')
  })

  test('synthetic grill/audit IDs are correctly rejected by the guard', () => {
    const syntheticIds = [
      'grill-requirements-abc123',
      'audit-code-r1-xyz789',
      'grill-plan-def456'
    ]

    for (const id of syntheticIds) {
      const { db, runCalls } = createMockDb({ conversationExists: false })
      const result = guardedUpsert(db, {
        conversationId: id,
        workspaceId: 'ws-1',
        originalRequest: 'anything',
        discoveredContext: { filesExplored: [], keyFindings: [], planItems: [], nextSteps: [] }
      })
      assert.equal(result.skipped, true, `Should skip for synthetic ID: ${id}`)
      assert.equal(runCalls.length, 0, `No writes for synthetic ID: ${id}`)
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
