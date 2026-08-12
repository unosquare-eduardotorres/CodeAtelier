/**
 * Tests for agentic-claude-runner.ts — shared helper for spawning Claude CLI
 * as an agentic sub-process with MCP config and tool whitelisting.
 *
 * Tests:
 * - buildClaudeArgs: correct flags, permission mode, allowedTools format
 * - buildMinimalMcpConfig: server shape, env keys, server selection
 * - parseSentinelBlock: extraction between markers, missing markers, edge cases
 */

import assert from 'node:assert/strict'
import { setupElectronStub } from './electron-stub'
import { test, describe, summaryAsync } from './test-harness'
import { MCP_TOOLS } from '../../../shared/constants'

// Must run before importing any module that references `electron`
setupElectronStub()

// Dynamic require — setupElectronStub() must be called first because
// agentic-claude-runner imports `app` from `electron`.

const { buildClaudeArgs, buildMinimalMcpConfig, parseSentinelBlock, SENTINELS } =
  require('../agentic-claude-runner') as typeof import('../agentic-claude-runner')

type ClaudeArgsBuildInput = import('../agentic-claude-runner').ClaudeArgsBuildInput

// ── buildClaudeArgs ──────────────────────────────────────────────────────────

describe('buildClaudeArgs', () => {
  const baseInput: ClaudeArgsBuildInput = {
    configPath: '/tmp/mcp-config.json',
    prompt: 'Explore this project',
    allowedTools: [
      'Read',
      'Grep',
      'Glob',
      ...MCP_TOOLS.MEMORY._ALL_NAMES,
      ...MCP_TOOLS.CODE_GRAPH._ALL_NAMES
    ],
    model: 'claude-sonnet-4-6',
    maxTurns: 30
  }

  test('uses bypassPermissions permission mode', () => {
    const args = buildClaudeArgs(baseInput)
    const modeIdx = args.indexOf('--permission-mode')
    assert.ok(modeIdx >= 0, 'should include --permission-mode')
    assert.equal(args[modeIdx + 1], 'bypassPermissions')
  })

  test('includes --mcp-config flag', () => {
    const args = buildClaudeArgs(baseInput)
    const configIdx = args.indexOf('--mcp-config')
    assert.ok(configIdx >= 0, 'should include --mcp-config')
    assert.equal(args[configIdx + 1], '/tmp/mcp-config.json')
  })

  test('includes --allowedTools with comma-separated tool names', () => {
    const args = buildClaudeArgs(baseInput)
    const toolsIdx = args.indexOf('--allowedTools')
    assert.ok(toolsIdx >= 0, 'should include --allowedTools')
    const toolsCsv = args[toolsIdx + 1]
    assert.ok(toolsCsv.includes('Read'), 'should include Read')
    assert.ok(toolsCsv.includes('Grep'), 'should include Grep')
    assert.ok(toolsCsv.includes('Glob'), 'should include Glob')
    assert.ok(toolsCsv.includes('mcp__memory__memory_record'), 'should include memory_record')
    assert.ok(toolsCsv.includes('mcp__code-graph__graph_map'), 'should include graph_map')
  })

  test('excludes Write and Edit from allowedTools', () => {
    const args = buildClaudeArgs(baseInput)
    const toolsIdx = args.indexOf('--allowedTools')
    const toolsCsv = args[toolsIdx + 1]
    assert.ok(!toolsCsv.includes('Write'), 'should NOT include Write')
    assert.ok(!toolsCsv.includes('Edit'), 'should NOT include Edit')
  })

  test('uses correct model and maxTurns', () => {
    const args = buildClaudeArgs(baseInput)
    const modelIdx = args.indexOf('--model')
    assert.equal(args[modelIdx + 1], 'claude-sonnet-4-6')
    const turnsIdx = args.indexOf('--max-turns')
    assert.equal(args[turnsIdx + 1], '30')
  })

  test('uses text output format', () => {
    const args = buildClaudeArgs(baseInput)
    const fmtIdx = args.indexOf('--output-format')
    assert.ok(fmtIdx >= 0, 'should include --output-format')
    assert.equal(args[fmtIdx + 1], 'text')
  })

  test('includes prompt via -p flag', () => {
    const args = buildClaudeArgs(baseInput)
    const pIdx = args.indexOf('-p')
    assert.ok(pIdx >= 0, 'should include -p')
    assert.equal(args[pIdx + 1], 'Explore this project')
  })
})

// ── buildMinimalMcpConfig ────────────────────────────────────────────────────

describe('buildMinimalMcpConfig', () => {
  test('includes both memory and code-graph servers by default', () => {
    const config = buildMinimalMcpConfig('ws-123', '/workspace/path')
    assert.ok(config.mcpServers['memory'], 'should have memory server')
    assert.ok(config.mcpServers['code-graph'], 'should have code-graph server')
    assert.equal(Object.keys(config.mcpServers).length, 2)
  })

  test('memory server has correct env keys', () => {
    const config = buildMinimalMcpConfig('ws-123', '/workspace/path')
    const mem = config.mcpServers['memory']
    assert.equal(mem.env.WORKSPACE_ID, 'ws-123')
    assert.ok(mem.env.DB_PATH, 'should have DB_PATH')
    assert.equal(mem.command, 'node')
    assert.ok(
      mem.args[0].endsWith('memory-server.js'),
      `expected memory-server.js, got ${mem.args[0]}`
    )
  })

  test('code-graph server has correct env keys', () => {
    const config = buildMinimalMcpConfig('ws-123', '/workspace/path')
    const cg = config.mcpServers['code-graph']
    assert.equal(cg.env.WORKSPACE_ID, 'ws-123')
    assert.equal(cg.env.WORKSPACE_PATH, '/workspace/path')
    assert.ok(cg.env.DB_PATH, 'should have DB_PATH')
    assert.equal(cg.command, 'node')
    assert.ok(
      cg.args[0].endsWith('code-graph-server.js'),
      `expected code-graph-server.js, got ${cg.args[0]}`
    )
  })

  test('can include only code-graph server', () => {
    const config = buildMinimalMcpConfig('ws-123', '/workspace/path', ['code-graph'])
    assert.ok(config.mcpServers['code-graph'], 'should have code-graph')
    assert.ok(!config.mcpServers['memory'], 'should NOT have memory')
    assert.equal(Object.keys(config.mcpServers).length, 1)
  })

  test('can include only memory server', () => {
    const config = buildMinimalMcpConfig('ws-123', '/workspace/path', ['memory'])
    assert.ok(config.mcpServers['memory'], 'should have memory')
    assert.ok(!config.mcpServers['code-graph'], 'should NOT have code-graph')
    assert.equal(Object.keys(config.mcpServers).length, 1)
  })
})

// ── parseSentinelBlock ───────────────────────────────────────────────────────

describe('parseSentinelBlock', () => {
  test('extracts content between sentinel markers', () => {
    const stdout = `Some preamble text\n${SENTINELS.BEGIN}\n# My Project\n\nThis is the content.\n${SENTINELS.END}\nSome trailing text`
    const result = parseSentinelBlock(stdout)
    assert.ok(result, 'should extract content')
    assert.ok(result.startsWith('# My Project'), 'should start with the content')
    assert.ok(result.includes('This is the content.'), 'should include inner content')
    assert.ok(!result.includes(SENTINELS.BEGIN), 'should NOT include BEGIN sentinel')
    assert.ok(!result.includes(SENTINELS.END), 'should NOT include END sentinel')
  })

  test('returns null when BEGIN sentinel is missing', () => {
    const stdout = `Some content\n${SENTINELS.END}\nMore content`
    assert.equal(parseSentinelBlock(stdout), null)
  })

  test('returns null when END sentinel is missing', () => {
    const stdout = `${SENTINELS.BEGIN}\nSome content\nMore content`
    assert.equal(parseSentinelBlock(stdout), null)
  })

  test('returns null when both sentinels are missing', () => {
    assert.equal(parseSentinelBlock('Just regular output'), null)
  })

  test('returns null when END comes before BEGIN', () => {
    const stdout = `${SENTINELS.END}\n# Content\n${SENTINELS.BEGIN}`
    assert.equal(parseSentinelBlock(stdout), null)
  })

  test('handles empty content between sentinels', () => {
    const stdout = `${SENTINELS.BEGIN}\n${SENTINELS.END}`
    const result = parseSentinelBlock(stdout)
    assert.equal(result, '', 'should return empty string')
  })

  test('trims whitespace from extracted content', () => {
    const stdout = `${SENTINELS.BEGIN}\n\n  # Project  \n\n${SENTINELS.END}`
    const result = parseSentinelBlock(stdout)
    assert.ok(result, 'should extract content')
    assert.ok(result.startsWith('#'), 'should be trimmed')
  })
})

// ── MCP_TOOLS consistency ────────────────────────────────────────────────────

describe('MCP_TOOLS tool name format', () => {
  test('memory tool names use mcp__memory__ prefix', () => {
    for (const name of MCP_TOOLS.MEMORY._ALL_NAMES) {
      assert.ok(name.startsWith('mcp__memory__'), `${name} should start with mcp__memory__`)
    }
  })

  test('code-graph tool names use mcp__code-graph__ prefix', () => {
    for (const name of MCP_TOOLS.CODE_GRAPH._ALL_NAMES) {
      assert.ok(name.startsWith('mcp__code-graph__'), `${name} should start with mcp__code-graph__`)
    }
  })

  test('memory tools include memory_record', () => {
    assert.ok(
      MCP_TOOLS.MEMORY._ALL_NAMES.includes('mcp__memory__memory_record'),
      'should include memory_record'
    )
  })

  test('code-graph tools include graph_map', () => {
    assert.ok(
      MCP_TOOLS.CODE_GRAPH._ALL_NAMES.includes('mcp__code-graph__graph_map'),
      'should include graph_map'
    )
  })
})

// ── Run guard ────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
