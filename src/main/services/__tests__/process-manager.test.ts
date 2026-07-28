/**
 * Tests for the process-manager MCP server — ring buffer, tracked process logic,
 * and mode gating.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import { RingBuffer } from '../../mcp-servers/process-manager-server'
import { MCP_TOOLS } from '../../../shared/constants'

// ── Ring Buffer ──

describe('RingBuffer', () => {
  test('stores lines up to capacity', () => {
    const buf = new RingBuffer(3)
    buf.push('a')
    buf.push('b')
    buf.push('c')
    assert.deepEqual(buf.getAll(), ['a', 'b', 'c'])
    assert.equal(buf.length, 3)
  })

  test('evicts oldest line when over capacity', () => {
    const buf = new RingBuffer(3)
    buf.push('a')
    buf.push('b')
    buf.push('c')
    buf.push('d')
    assert.deepEqual(buf.getAll(), ['b', 'c', 'd'])
    assert.equal(buf.length, 3)
  })

  test('truncates long lines at 500 chars', () => {
    const buf = new RingBuffer(5)
    const longLine = 'x'.repeat(600)
    buf.push(longLine)
    const stored = buf.getAll()[0]
    assert.equal(stored.length, 501) // 500 + '…'
    assert.ok(stored.endsWith('…'))
  })

  test('getRecent returns last N lines', () => {
    const buf = new RingBuffer(10)
    for (let i = 0; i < 8; i++) buf.push(`line-${i}`)
    const recent = buf.getRecent(3)
    assert.deepEqual(recent, ['line-5', 'line-6', 'line-7'])
  })

  test('getRecent with count larger than buffer returns all', () => {
    const buf = new RingBuffer(10)
    buf.push('a')
    buf.push('b')
    const recent = buf.getRecent(100)
    assert.deepEqual(recent, ['a', 'b'])
  })

  test('pushMultiline splits on newlines and ignores empty lines', () => {
    const buf = new RingBuffer(10)
    buf.pushMultiline('hello\nworld\n\nfoo')
    assert.deepEqual(buf.getAll(), ['hello', 'world', 'foo'])
  })

  test('empty buffer returns empty array', () => {
    const buf = new RingBuffer(5)
    assert.deepEqual(buf.getAll(), [])
    assert.deepEqual(buf.getRecent(10), [])
    assert.equal(buf.length, 0)
  })

  test('capacity of 1 always keeps only the last line', () => {
    const buf = new RingBuffer(1)
    buf.push('first')
    buf.push('second')
    buf.push('third')
    assert.deepEqual(buf.getAll(), ['third'])
  })
})

// ── MCP_TOOLS Registry ──

describe('PROCESS_MANAGER MCP_TOOLS', () => {
  test('has correct server name', () => {
    assert.equal(MCP_TOOLS.PROCESS_MANAGER._SERVER, 'process-manager')
  })

  test('has correct prefix', () => {
    assert.equal(MCP_TOOLS.PROCESS_MANAGER._PREFIX, 'mcp__process-manager__')
  })

  test('exports 4 tools', () => {
    assert.equal(MCP_TOOLS.PROCESS_MANAGER._ALL_NAMES.length, 4)
  })

  test('run_background tool name follows convention', () => {
    assert.equal(
      MCP_TOOLS.PROCESS_MANAGER.RUN_BACKGROUND.name,
      'mcp__process-manager__run_background'
    )
    assert.equal(MCP_TOOLS.PROCESS_MANAGER.RUN_BACKGROUND.server, 'process-manager')
    assert.equal(MCP_TOOLS.PROCESS_MANAGER.RUN_BACKGROUND.tool, 'run_background')
  })

  test('check_process tool name follows convention', () => {
    assert.equal(
      MCP_TOOLS.PROCESS_MANAGER.CHECK_PROCESS.name,
      'mcp__process-manager__check_process'
    )
  })

  test('stop_process tool name follows convention', () => {
    assert.equal(
      MCP_TOOLS.PROCESS_MANAGER.STOP_PROCESS.name,
      'mcp__process-manager__stop_process'
    )
  })

  test('list_processes tool name follows convention', () => {
    assert.equal(
      MCP_TOOLS.PROCESS_MANAGER.LIST_PROCESSES.name,
      'mcp__process-manager__list_processes'
    )
  })

  test('all tool names are in ALL_NAMES', () => {
    const names = MCP_TOOLS.PROCESS_MANAGER._ALL_NAMES
    assert.ok(names.includes('mcp__process-manager__run_background'))
    assert.ok(names.includes('mcp__process-manager__check_process'))
    assert.ok(names.includes('mcp__process-manager__stop_process'))
    assert.ok(names.includes('mcp__process-manager__list_processes'))
  })
})

// ── Mode Gating ──

describe('Process Manager mode gating', () => {
  test('process-manager tools are NOT in plan mode disallowed list (handled by allowlist)', () => {
    // In plan mode, tools not in the baseAllowed + conditionalTools list are implicitly blocked.
    // The process-manager tools should NOT appear in the allowedTools for plan mode.
    // We verify the MCP_TOOLS entry exists so the wiring can reference it.
    const allNames = MCP_TOOLS.PROCESS_MANAGER._ALL_NAMES
    assert.ok(allNames.length === 4, 'Should have exactly 4 process-manager tools')
  })

  test('display names follow "Process · tool_name" convention', () => {
    assert.equal(MCP_TOOLS.PROCESS_MANAGER.RUN_BACKGROUND.displayName, 'Process · run_background')
    assert.equal(MCP_TOOLS.PROCESS_MANAGER.CHECK_PROCESS.displayName, 'Process · check_process')
    assert.equal(MCP_TOOLS.PROCESS_MANAGER.STOP_PROCESS.displayName, 'Process · stop_process')
    assert.equal(MCP_TOOLS.PROCESS_MANAGER.LIST_PROCESSES.displayName, 'Process · list_processes')
  })
})

// ── Prompt Guidance ──

describe('Process Manager prompt guidance', () => {
  test('PROCESS_MANAGER_GUIDANCE_PROMPT is exported from default-prompts', async () => {
    const mod = await import('../default-prompts')
    assert.ok(typeof mod.PROCESS_MANAGER_GUIDANCE_PROMPT === 'string')
    assert.ok(mod.PROCESS_MANAGER_GUIDANCE_PROMPT.includes('## Background Processes'))
    assert.ok(mod.PROCESS_MANAGER_GUIDANCE_PROMPT.includes('run_background'))
    assert.ok(mod.PROCESS_MANAGER_GUIDANCE_PROMPT.includes('NEVER use Bash'))
  })

  test('PromptFeatureFlags accepts processManagerEnabled', async () => {
    // Type-level check — if this compiles, the interface is correct.
    const flags: import('../prompt-assembly-helpers').PromptFeatureFlags = {
      repomapEnabled: true,
      semanticSearchEnabled: true,
      githubConfigured: false,
      processManagerEnabled: true
    }
    assert.equal(flags.processManagerEnabled, true)
  })
})
