/**
 * Tests for the ask_user request registry used by the control-actions MCP server.
 *
 * Covers the no-timeout behavior: a pending request resolves ONLY on a real
 * response or on socket teardown (resolveAll). There is no setTimeout, so these
 * tests must complete synchronously with no lingering timers.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import { createAskUserRegistry } from '../ask-user-registry'

describe('createAskUserRegistry', () => {
  test('resolve() fires the matching pending request and removes it', () => {
    const registry = createAskUserRegistry()
    let received: string | null = null
    registry.register('req-1', (response) => {
      received = response
    })
    assert.equal(registry.size, 1)

    const handled = registry.resolve('req-1', 'Use Postgres')
    assert.equal(handled, true)
    assert.equal(received, 'Use Postgres')
    assert.equal(registry.size, 0, 'resolved request should be removed')
  })

  test('resolve() returns false for an unknown requestId', () => {
    const registry = createAskUserRegistry()
    registry.register('req-1', () => {})
    const handled = registry.resolve('does-not-exist', 'ignored')
    assert.equal(handled, false)
    assert.equal(registry.size, 1, 'unrelated pending request is untouched')
  })

  test('resolveAll() resolves every pending request and clears the map (socket close)', () => {
    const registry = createAskUserRegistry()
    const responses: string[] = []
    registry.register('a', (r) => responses.push(r))
    registry.register('b', (r) => responses.push(r))
    registry.register('c', (r) => responses.push(r))
    assert.equal(registry.size, 3)

    registry.resolveAll('connection closed')

    assert.equal(responses.length, 3)
    assert.deepEqual(new Set(responses), new Set(['connection closed']))
    assert.equal(registry.size, 0, 'registry must be empty after resolveAll')
  })

  test('resolveAll() on an empty registry is a no-op', () => {
    const registry = createAskUserRegistry()
    registry.resolveAll('nothing pending')
    assert.equal(registry.size, 0)
  })

  test('each ask_user promise resolves exactly once (no auto-timeout)', async () => {
    const registry = createAskUserRegistry()
    const promise = new Promise<string>((resolve) => registry.register('req-x', resolve))

    // Simulate the user answering.
    registry.resolve('req-x', 'answer')
    assert.equal(await promise, 'answer')

    // A later teardown must not throw or double-resolve (request already gone).
    registry.resolveAll('late close')
    assert.equal(registry.size, 0)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
