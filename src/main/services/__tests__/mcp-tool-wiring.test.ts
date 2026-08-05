/**
 * MCP tool name convention tests.
 * Verifies structural contracts of the MCP tool registry.
 *
 * NOTE: The git-context and checkpoint-context wiring tests were removed
 * when those .tool.ts files were externalized to src/main/mcp-servers/.
 */
import assert from 'node:assert/strict'
import { ALL_MCP_TOOL_NAMES, MCP_TOOLS } from '../../../shared/constants'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${(err as Error).message}`)
    failed++
  }
}

function describe(name: string, fn: () => void): void {
  console.log(`\n${name}`)
  fn()
}

// ── MCP tool name convention ──

describe('MCP tool name convention (from MCP_TOOLS registry)', () => {
  // Exclude control-actions from the "expected tools" list — they're internal-only.
  // ALL_MCP_TOOL_NAMES includes all tools from the registry.
  const EXPECTED_MCP_TOOLS = ALL_MCP_TOOL_NAMES.filter(
    (name) => !name.startsWith(MCP_TOOLS.CONTROL_ACTIONS._PREFIX)
  )

  test('all MCP tool names follow mcp__{server}__{tool} convention', () => {
    for (const name of ALL_MCP_TOOL_NAMES) {
      assert.match(name, /^mcp__[a-z-]+__[a-z_]+$/, `Invalid MCP tool name: ${name}`)
    }
  })

  test('no duplicate tool names', () => {
    const unique = new Set(ALL_MCP_TOOL_NAMES)
    assert.equal(unique.size, ALL_MCP_TOOL_NAMES.length, 'Duplicate tool names detected')
  })

  test('each server has at least one tool', () => {
    const servers = new Map<string, string[]>()
    for (const name of EXPECTED_MCP_TOOLS) {
      const parts = name.split('__')
      const server = parts[1]
      if (!servers.has(server)) servers.set(server, [])
      servers.get(server)!.push(name)
    }

    for (const [server, tools] of servers) {
      assert.ok(tools.length >= 1, `Server ${server} has no tools`)
    }
  })

  test('expected server count is correct', () => {
    const servers = new Set(EXPECTED_MCP_TOOLS.map((n) => n.split('__')[1]))
    // code-graph, semantic-search, git-context, checkpoint-context, github-context,
    // code-analysis, memory, recall, process-manager
    assert.equal(servers.size, 9, `Expected 9 MCP servers, got ${servers.size}`)
  })

  test('registry includes all 9 MCP servers (including control-actions)', () => {
    const allServers = new Set(ALL_MCP_TOOL_NAMES.map((n) => n.split('__')[1]))
    assert.equal(allServers.size, 10, `Expected 10 MCP servers, got ${allServers.size}`)
  })
})

// ── Summary ──

console.log(`\n${'─'.repeat(40)}`)
console.log(`mcp-tool-wiring: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
