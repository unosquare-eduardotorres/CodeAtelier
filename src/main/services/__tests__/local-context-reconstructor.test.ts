/**
 * Unit tests for local-context-reconstructor.ts — message/plan section builders.
 *
 * Phase 6A Coverage Improvement — lines 128-130 (planText branch), 141-166 (buildMessageSection).
 * Tests access private methods via (instance as any) — pure string logic, no DB.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { localContextReconstructor } from '../local-context-reconstructor'

const recon = localContextReconstructor as any

// ── buildPlanStateSection ──

describe('LocalContextReconstructor.buildPlanStateSection', () => {
  function makePlanState(overrides: Record<string, unknown> = {}) {
    return {
      originalRequest: 'Build a login page',
      discoveredContext: {
        filesExplored: [],
        keyFindings: [],
        planItems: [],
        nextSteps: []
      },
      planText: '',
      continuationCount: 1,
      ...overrides
    }
  }

  test('originalRequest only → includes Original Request heading', () => {
    const result = recon.buildPlanStateSection(makePlanState())
    assert.ok(result, 'should return a string')
    assert.ok(result.includes('### Original Request'))
    assert.ok(result.includes('Build a login page'))
  })

  test('planText > 50 chars → includes Partial Plan section', () => {
    const longPlan =
      'Step 1: Create schema migration\nStep 2: Build API endpoints\nStep 3: Add unit tests'
    assert.ok(longPlan.length > 50, 'fixture must be > 50 chars')
    const result = recon.buildPlanStateSection(makePlanState({ planText: longPlan }))
    assert.ok(result.includes('### Partial Plan'), 'should include Partial Plan heading')
    assert.ok(result.includes('Step 1'))
  })

  test('planText ≤ 50 chars → excludes Partial Plan section', () => {
    const shortPlan = 'Short plan'
    assert.ok(shortPlan.length <= 50)
    const result = recon.buildPlanStateSection(makePlanState({ planText: shortPlan }))
    assert.ok(!result.includes('### Partial Plan'))
  })

  test('planText > 1000 chars → truncated at 1000', () => {
    const longPlan = 'X'.repeat(1500)
    const result = recon.buildPlanStateSection(makePlanState({ planText: longPlan }))
    assert.ok(result.includes('### Partial Plan'))
    // The plan text in the output should be capped at 1000 chars
    const planSection = result.split('### Partial Plan\n')[1]
    assert.ok(planSection.length <= 1000 + 50, 'plan text should be truncated to ~1000 chars')
  })

  test('discoveredContext with items → all sections included', () => {
    const result = recon.buildPlanStateSection(
      makePlanState({
        discoveredContext: {
          filesExplored: ['src/app.ts', 'src/index.ts'],
          keyFindings: ['Uses Express 5', 'TypeScript strict mode'],
          planItems: ['Create route', 'Add middleware'],
          nextSteps: ['Test locally']
        }
      })
    )
    assert.ok(result.includes('### Files Explored'))
    assert.ok(result.includes('src/app.ts'))
    assert.ok(result.includes('### Key Findings'))
    assert.ok(result.includes('Uses Express 5'))
    assert.ok(result.includes('### Plan Items'))
    assert.ok(result.includes('Create route'))
  })

  test('empty everything → returns null', () => {
    const result = recon.buildPlanStateSection({
      originalRequest: '',
      discoveredContext: { filesExplored: [], keyFindings: [], planItems: [], nextSteps: [] },
      planText: '',
      continuationCount: 1
    })
    assert.equal(result, null)
  })

  test('continuation count included in heading', () => {
    const result = recon.buildPlanStateSection(makePlanState({ continuationCount: 3 }))
    assert.ok(result.includes('continuation #3'))
  })
})

// ── buildMessageSection ──

describe('LocalContextReconstructor.buildMessageSection', () => {
  test('empty messages → returns null', () => {
    const result = recon.buildMessageSection([], 5000)
    assert.equal(result, null)
  })

  test('single user message → formatted with User role', () => {
    const result = recon.buildMessageSection(
      [{ role: 'user', contentMd: 'Hello world' }],
      5000
    )
    assert.ok(result)
    assert.ok(result.includes('**User:**'))
    assert.ok(result.includes('Hello world'))
    assert.ok(result.includes('## Recent Messages'))
  })

  test('assistant/specialist role → formatted as Assistant', () => {
    const result = recon.buildMessageSection(
      [{ role: 'specialist', contentMd: 'Analysis done' }],
      5000
    )
    assert.ok(result.includes('**Assistant:**'))
    assert.ok(result.includes('Analysis done'))
  })

  test('user message > 500 chars → truncated with ellipsis', () => {
    const longContent = 'A'.repeat(600)
    const result = recon.buildMessageSection(
      [{ role: 'user', contentMd: longContent }],
      5000
    )
    assert.ok(result.includes('...'))
    assert.ok(!result.includes(longContent), 'full content should not appear')
  })

  test('assistant message > 300 chars → truncated with ellipsis', () => {
    const longContent = 'B'.repeat(400)
    const result = recon.buildMessageSection(
      [{ role: 'specialist', contentMd: longContent }],
      5000
    )
    assert.ok(result.includes('...'))
    assert.ok(!result.includes(longContent), 'full content should not appear')
  })

  test('user message ≤ 500 chars → no ellipsis', () => {
    const content = 'Short user message'
    const result = recon.buildMessageSection(
      [{ role: 'user', contentMd: content }],
      5000
    )
    assert.ok(result.includes(content))
    assert.ok(!result.includes('...'))
  })

  test('budget exhaustion → stops adding messages', () => {
    const messages = Array.from({ length: 5 }, (_, i) => ({
      role: 'user',
      contentMd: `Message number ${i}: ${'X'.repeat(50)}`
    }))
    // Very tight budget — should only fit 1-2 messages
    const result = recon.buildMessageSection(messages, 100)
    const userCount = (result?.match(/\*\*User:\*\*/g) || []).length
    assert.ok(userCount < 5, `expected fewer than 5 messages, got ${userCount}`)
  })

  test('more than 10 messages → takes only last 10', () => {
    const messages = Array.from({ length: 15 }, (_, i) => ({
      role: 'user',
      contentMd: `Msg-${i.toString().padStart(2, '0')}`
    }))
    const result = recon.buildMessageSection(messages, 50000)
    // First 5 messages (indices 0-4) should not appear
    assert.ok(!result.includes('Msg-00'), 'message 0 should be excluded')
    assert.ok(!result.includes('Msg-04'), 'message 4 should be excluded')
    // Last messages should appear
    assert.ok(result.includes('Msg-14'), 'message 14 should be included')
    assert.ok(result.includes('Msg-05'), 'message 5 should be included')
  })

  test('mixed roles → both User and Assistant labels', () => {
    const messages = [
      { role: 'user', contentMd: 'What is this?' },
      { role: 'specialist', contentMd: 'It is a test file' }
    ]
    const result = recon.buildMessageSection(messages, 5000)
    assert.ok(result.includes('**User:**'))
    assert.ok(result.includes('**Assistant:**'))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
