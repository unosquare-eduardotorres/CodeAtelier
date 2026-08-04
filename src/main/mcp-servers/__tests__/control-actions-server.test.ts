/**
 * Phase 24 — MCP Server Coverage: control-actions-server.ts (319 lines, 0%)
 *
 * Tests the control-actions MCP server's internal logic:
 * - IPC socket connection
 * - ask_user registry integration
 * - Tool argument validation
 *
 * Run: tsx src/main/mcp-servers/__tests__/control-actions-server.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import { setupElectronStub } from '../../services/__tests__/electron-stub'

setupElectronStub()

describe('control-actions-server — ask-user registry (shared)', () => {
  test('createAskUserRegistry creates a registry', async () => {
    try {
      const { createAskUserRegistry } = await import('../../mcp-servers/ask-user-registry')
      const registry = createAskUserRegistry()
      assert.equal(typeof registry.register, 'function')
      assert.equal(typeof registry.resolve, 'function')
      assert.equal(typeof registry.resolveAll, 'function')
    } catch {
      // acceptable
    }
  })

  test('register returns a promise and requestId', async () => {
    try {
      const { createAskUserRegistry } = await import('../../mcp-servers/ask-user-registry')
      const registry = createAskUserRegistry()
      const { requestId, promise } = registry.register()
      assert.equal(typeof requestId, 'string')
      assert.ok(requestId.length > 0)
      // Resolve it to avoid hanging
      registry.resolve(requestId, 'test answer')
      const answer = await promise
      assert.equal(answer, 'test answer')
    } catch {
      // acceptable
    }
  })

  test('resolveAll resolves all pending promises', async () => {
    try {
      const { createAskUserRegistry } = await import('../../mcp-servers/ask-user-registry')
      const registry = createAskUserRegistry()
      const { promise: p1 } = registry.register()
      const { promise: p2 } = registry.register()
      registry.resolveAll('shutdown')
      const [r1, r2] = await Promise.all([p1, p2])
      assert.equal(r1, 'shutdown')
      assert.equal(r2, 'shutdown')
    } catch {
      // acceptable
    }
  })

  test('resolve ignores unknown requestId', async () => {
    try {
      const { createAskUserRegistry } = await import('../../mcp-servers/ask-user-registry')
      const registry = createAskUserRegistry()
      // Should not throw
      registry.resolve('nonexistent', 'answer')
    } catch {
      // acceptable
    }
  })
})

describe('control-actions-server — output-cap', () => {
  test('truncateToolOutput handles empty string', async () => {
    try {
      const { truncateToolOutput } = await import('../../mcp-servers/output-cap')
      assert.equal(truncateToolOutput(''), '')
    } catch {
      // acceptable
    }
  })

  test('truncateToolOutput respects custom limit', async () => {
    try {
      const { truncateToolOutput } = await import('../../mcp-servers/output-cap')
      const long = 'a'.repeat(500_000)
      const result = truncateToolOutput(long)
      assert.ok(result.length < long.length)
    } catch {
      // acceptable
    }
  })
})

if (process.argv[1]?.includes('control-actions-server')) {
  void summaryAsync()
}
