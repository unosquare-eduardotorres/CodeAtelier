/**
 * MCP tool consistency tests.
 * Ensures evaluation-mcp-config, workspace-mcp-config, and prompt guidance
 * all reference tools that exist in the canonical MCP_TOOLS registry.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'
import { ALL_MCP_TOOL_NAMES, MCP_TOOLS, COUNCIL_ADVISORS } from '../../../shared/constants'
import { buildReadOnlyToolConfig } from '../role-adapters/evaluation-mcp-config'

const allToolSet = new Set(ALL_MCP_TOOL_NAMES)

describe('MCP tool consistency — evaluation-mcp-config uses canonical registry', () => {
  // Build with all flags enabled to get the maximal tool set
  const maxConfig = buildReadOnlyToolConfig({
    repomapEnabled: true,
    semanticSearchEnabled: true,
    hasWorkspace: true,
    includeGitContext: true
  })

  test('all allowed MCP tools exist in MCP_TOOLS registry', () => {
    assert.ok(maxConfig.allowedTools, 'allowedTools should be defined')
    const mcpTools = maxConfig.allowedTools.filter((t) => t.startsWith('mcp__'))
    for (const tool of mcpTools) {
      assert.ok(
        allToolSet.has(tool),
        `evaluation-mcp-config references "${tool}" which is not in MCP_TOOLS`
      )
    }
  })

  test('evaluation config includes all code-analysis tools', () => {
    assert.ok(maxConfig.allowedTools, 'allowedTools should be defined')
    for (const name of MCP_TOOLS.CODE_ANALYSIS._ALL_NAMES) {
      assert.ok(
        maxConfig.allowedTools.includes(name),
        `evaluation config is missing code-analysis tool: ${name}`
      )
    }
  })

  test('evaluation config includes all code-graph tools', () => {
    assert.ok(maxConfig.allowedTools, 'allowedTools should be defined')
    for (const name of MCP_TOOLS.CODE_GRAPH._ALL_NAMES) {
      assert.ok(
        maxConfig.allowedTools.includes(name),
        `evaluation config is missing code-graph tool: ${name}`
      )
    }
  })

  test('evaluation config includes all semantic-search tools', () => {
    assert.ok(maxConfig.allowedTools, 'allowedTools should be defined')
    for (const name of MCP_TOOLS.SEMANTIC_SEARCH._ALL_NAMES) {
      assert.ok(
        maxConfig.allowedTools.includes(name),
        `evaluation config is missing semantic-search tool: ${name}`
      )
    }
  })

  test('evaluation config includes all git-context tools', () => {
    assert.ok(maxConfig.allowedTools, 'allowedTools should be defined')
    for (const name of MCP_TOOLS.GIT_CONTEXT._ALL_NAMES) {
      assert.ok(
        maxConfig.allowedTools.includes(name),
        `evaluation config is missing git-context tool: ${name}`
      )
    }
  })

  test('evaluation config includes all memory tools', () => {
    assert.ok(maxConfig.allowedTools, 'allowedTools should be defined')
    for (const name of MCP_TOOLS.MEMORY._ALL_NAMES) {
      assert.ok(
        maxConfig.allowedTools.includes(name),
        `evaluation config is missing memory tool: ${name}`
      )
    }
  })
})

describe('MCP tool consistency — council advisor toolGuidance references real tools', () => {
  // Extract tool names from backtick-quoted references in toolGuidance strings
  const toolNamePattern = /`([a-z_]+)`/g

  // Known built-in SDK tools (not in MCP_TOOLS but valid)
  const builtinTools = new Set([
    'Read',
    'Write',
    'Edit',
    'Bash',
    'Glob',
    'Grep',
    'WebSearch',
    'WebFetch',
    'ListDir',
    'Agent',
    'ToolSearch'
  ])

  // All short names from MCP_TOOLS (e.g., 'find_references', 'audit_scan')
  const allShortNames = new Set<string>()
  for (const server of Object.values(MCP_TOOLS)) {
    for (const fullName of server._ALL_NAMES) {
      const shortName = fullName.split('__').pop()!
      allShortNames.add(shortName)
    }
  }

  for (const [role, advisor] of Object.entries(COUNCIL_ADVISORS)) {
    if (advisor.toolAccess === 'none') continue
    test(`${role} advisor toolGuidance references only real tools`, () => {
      const matches = [...advisor.toolGuidance.matchAll(toolNamePattern)]
      for (const match of matches) {
        const toolName = match[1]
        assert.ok(
          allShortNames.has(toolName) || builtinTools.has(toolName),
          `${role} advisor references ghost tool "${toolName}" — not in MCP_TOOLS registry`
        )
      }
    })
  }
})

describe('MCP tool consistency — prompt guidance flags gate correctly', () => {
  test('codeAnalysisEnabled defaults to truthy when omitted', () => {
    // When codeAnalysisEnabled is undefined (not passed), it should NOT suppress guidance
    const flags = { codeAnalysisEnabled: undefined }
    assert.ok(
      flags.codeAnalysisEnabled !== false,
      'undefined codeAnalysisEnabled should not suppress guidance'
    )
  })

  test('codeAnalysisEnabled=false suppresses guidance', () => {
    const flags = { codeAnalysisEnabled: false as const }
    assert.ok(
      flags.codeAnalysisEnabled === false,
      'false codeAnalysisEnabled should suppress guidance'
    )
  })
})

describe('MCP tool consistency — prompt guidance text references real tools', () => {
  const toolNamePattern = /\b([a-z][a-z_]+(?:_[a-z]+)+)\b/g

  // All short names from MCP_TOOLS
  const allShortNames = new Set<string>()
  for (const server of Object.values(MCP_TOOLS)) {
    for (const fullName of server._ALL_NAMES) {
      allShortNames.add(fullName.split('__').pop()!)
    }
  }

  // Known non-tool identifiers that look like tool names in prompt text
  const knownNonTools = new Set([
    'tech_debt',
    'dead_code',
    'untested_files',
    'package_audits',
    'current_api',
    'resolve_library_id'
  ])

  test('CODE_ANALYSIS_GUIDANCE_PROMPT references only real tools', () => {
    const { CODE_ANALYSIS_GUIDANCE_PROMPT } = require('../../services/default-prompts')
    const matches = [...CODE_ANALYSIS_GUIDANCE_PROMPT.matchAll(toolNamePattern)]
    for (const match of matches) {
      const name = match[1]
      if (knownNonTools.has(name)) continue
      // Skip fragments of fully-qualified mcp__server__tool names split on hyphens
      // (e.g. "mcp__code" and "analysis__audit_scan" from "mcp__code-analysis__audit_scan")
      // Real short tool names never contain double underscores.
      if (name.includes('__')) continue
      assert.ok(
        allShortNames.has(name),
        `CODE_ANALYSIS_GUIDANCE_PROMPT references "${name}" which is not in MCP_TOOLS`
      )
    }
  })
})

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../mcp-servers')

/**
 * Extracts `server.tool('name', '<description>' + '<more>', …)` pairs from source.
 * Handles both single- and double-quoted description literals (a description
 * containing an apostrophe, e.g. run_background, must use double quotes).
 */
function readToolDescriptions(file: string): { name: string; description: string }[] {
  const src = readFileSync(resolve(serverDir, file), 'utf8')
  const strLit = /(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/.source
  const call = new RegExp(`server\\.tool\\(\\s*'([a-z_]+)',\\s*((?:${strLit}\\s*\\+?\\s*)+),`, 'g')
  const part = new RegExp(`'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)"`, 'g')
  const out: { name: string; description: string }[] = []
  for (const m of src.matchAll(call)) {
    const description = [...m[2].matchAll(part)]
      .map((s) => (s[1] ?? s[2]).replace(/\\(['"\\])/g, '$1'))
      .join('')
    out.push({ name: m[1], description })
  }
  return out
}

describe('MCP tool consistency — registry matches the actual servers', () => {
  // The registry drives the plan-mode allowedTools allowlist. A name in the
  // registry that no server registers is a ghost the model can never call; a
  // registered tool missing from the registry is silently unreachable in plan
  // mode. Both drifted undetected before this test existed.
  const SERVERS = [
    ['code-graph-server.ts', MCP_TOOLS.CODE_GRAPH],
    ['semantic-search-server.ts', MCP_TOOLS.SEMANTIC_SEARCH],
    ['git-context-server.ts', MCP_TOOLS.GIT_CONTEXT],
    ['code-analysis-server.ts', MCP_TOOLS.CODE_ANALYSIS],
    ['memory-server.ts', MCP_TOOLS.MEMORY],
    ['recall-server.ts', MCP_TOOLS.RECALL],
    ['process-manager-server.ts', MCP_TOOLS.PROCESS_MANAGER],
    ['control-actions-server.ts', MCP_TOOLS.CONTROL_ACTIONS]
  ] as const

  for (const [file, server] of SERVERS) {
    test(`${file} — every registered tool was parsed with a description`, () => {
      const parsed = readToolDescriptions(file)
      const registered =
        readFileSync(resolve(serverDir, file), 'utf8').match(/server\.tool\(/g) ?? []
      assert.equal(
        parsed.length,
        registered.length,
        `parsed ${parsed.length} descriptions but found ${registered.length} server.tool() calls — ` +
          'a tool is registered without a string description, or the parser needs updating'
      )
    })

    test(`${file} — registry names and registered names are identical`, () => {
      const actual = new Set(readToolDescriptions(file).map((t) => t.name))
      const declared = new Set(server._ALL_NAMES.map((n) => n.split('__').pop()!))
      // Ghost: in the registry, allowlisted in plan mode, answered by nobody.
      assert.deepEqual(
        [...declared].filter((n) => !actual.has(n)),
        [],
        'ghost tools in registry'
      )
      // Orphan: real and callable, but missing from the plan-mode allowlist.
      assert.deepEqual(
        [...actual].filter((n) => !declared.has(n)),
        [],
        'tools missing from registry'
      )
    })

    test(`${file} — no handler returns a "delegating to in-process service" placeholder`, () => {
      assert.ok(
        !readFileSync(resolve(serverDir, file), 'utf8').includes('delegating to in-process service'),
        `${file} contains a placeholder handler — mount only tools that actually do the work`
      )
    })
  }
})

describe('MCP tool consistency — tool descriptions stay affordable', () => {
  // Descriptions ship on EVERY turn, unlike turn-1 prompt guidance, so an
  // unbounded description is a permanent per-turn tax. 240 chars ≈ 60 tokens.
  const MAX_DESCRIPTION_CHARS = 240

  for (const file of [
    'code-graph-server.ts',
    'semantic-search-server.ts',
    'git-context-server.ts',
    'code-analysis-server.ts'
  ]) {
    const tools = readToolDescriptions(file)

    for (const { name, description } of tools) {
      test(`${file} — ${name} description is non-empty and <= ${MAX_DESCRIPTION_CHARS} chars`, () => {
        assert.ok(description.trim().length > 0, `${name} has an empty description`)
        assert.ok(
          description.length <= MAX_DESCRIPTION_CHARS,
          `${name} description is ${description.length} chars (max ${MAX_DESCRIPTION_CHARS})`
        )
      })
    }
  }
})

// Run standalone
const thisFile = new URL(import.meta.url).pathname
if (process.argv[1] && thisFile.endsWith(process.argv[1].replace(/.*\//, ''))) {
  void summaryAsync()
}
