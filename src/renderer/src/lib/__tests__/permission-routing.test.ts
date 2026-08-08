/**
 * Where a permission request surfaces.
 *
 * The load-bearing property is the last group: a request must never be routed
 * nowhere. Dropping one leaves the agent blocked on a prompt the user is never
 * shown, which is exactly the silent-stall symptom this card exists to fix.
 *
 * Run: tsx src/renderer/src/lib/__tests__/permission-routing.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../../../main/services/__tests__/test-harness'
import { routePermission } from '../permission-routing'

const ACTIVE = 'conv-active'

describe('routePermission — tool permissions', () => {
  test('matching conversation goes inline', () => {
    assert.equal(
      routePermission({ type: 'toolPermission', conversationId: ACTIVE }, ACTIVE),
      'inline'
    )
  })

  test('a different conversation toasts', () => {
    assert.equal(
      routePermission({ type: 'toolPermission', conversationId: 'conv-other' }, ACTIVE),
      'toast'
    )
  })

  test('missing conversationId toasts rather than being dropped', () => {
    assert.equal(routePermission({ type: 'toolPermission' }, ACTIVE), 'toast')
  })

  test('no active conversation toasts', () => {
    assert.equal(routePermission({ type: 'toolPermission', conversationId: ACTIVE }, null), 'toast')
  })
})

describe('routePermission — every other permission type toasts', () => {
  for (const type of ['elicitation', 'askQuestion', 'mpaApproval']) {
    test(`${type} toasts even when the conversation matches`, () => {
      assert.equal(routePermission({ type, conversationId: ACTIVE }, ACTIVE), 'toast')
    })
  }
})

describe('routePermission — nothing is ever routed nowhere', () => {
  test('every combination returns inline or toast', () => {
    const types = ['toolPermission', 'elicitation', 'askQuestion', 'mpaApproval', 'unknown']
    const convIds = [ACTIVE, 'conv-other', undefined]
    const actives = [ACTIVE, null]
    for (const type of types) {
      for (const conversationId of convIds) {
        for (const active of actives) {
          const route = routePermission({ type, conversationId }, active)
          assert.ok(
            route === 'inline' || route === 'toast',
            `${type}/${conversationId}/${active} produced ${route}`
          )
        }
      }
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
