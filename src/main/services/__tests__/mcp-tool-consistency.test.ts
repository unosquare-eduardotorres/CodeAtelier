/**
 * MCP tool consistency tests.
 * Ensures evaluation-mcp-config, workspace-mcp-config, and prompt guidance
 * all reference tools that exist in the canonical MCP_TOOLS registry.
 */
import assert from 'node:assert/strict'
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
    'tech_debt', 'dead_code', 'untested_files', 'package_audits',
    'current_api', 'resolve_library_id',
  ])

  test('CODE_ANALYSIS_GUIDANCE_PROMPT references only real tools', () => {
    const { CODE_ANALYSIS_GUIDANCE_PROMPT } = require('../../services/default-prompts')
    const matches = [...CODE_ANALYSIS_GUIDANCE_PROMPT.matchAll(toolNamePattern)]
    for (const match of matches) {
      const name = match[1]
      if (knownNonTools.has(name)) continue
      assert.ok(
        allShortNames.has(name),
        `CODE_ANALYSIS_GUIDANCE_PROMPT references "${name}" which is not in MCP_TOOLS`
      )
    }
  })
})

// Run standalone
const thisFile = new URL(import.meta.url).pathname
if (process.argv[1] && thisFile.endsWith(process.argv[1].replace(/.*\//, ''))) {
  void summaryAsync()
}
