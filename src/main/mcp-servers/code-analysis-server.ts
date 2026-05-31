#!/usr/bin/env node
/**
 * Code Analysis MCP Server — externalized for CLI interactive mode.
 *
 * Exposes: analyze_complexity, analyze_dependencies, analyze_test_coverage,
 *          find_code_smells, suggest_refactoring
 *
 * Environment variables:
 *   WORKSPACE_PATH — Absolute workspace path
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { truncateToolOutput } from './output-cap'

const WORKSPACE_PATH = process.env.WORKSPACE_PATH ?? process.cwd()

const server = new McpServer(
  { name: 'code-analysis', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

async function registerTools(): Promise<void> {
  server.tool(
    'analyze_complexity',
    'Analyze code complexity metrics for a file or directory.',
    {
      path: z.string().describe('File or directory path to analyze'),
      threshold: z.number().optional().default(10).describe('Cyclomatic complexity threshold')
    },
    async (args) => {
      // Delegate to in-process service
      return {
        content: [
          {
            type: 'text' as const,
            text: `[analyze_complexity] path=${args.path} threshold=${args.threshold} — delegating to in-process service`
          }
        ]
      }
    }
  )

  server.tool(
    'analyze_dependencies',
    'Analyze dependency structure for a file or module.',
    {
      path: z.string().describe('File or directory path to analyze')
    },
    async (args) => {
      return {
        content: [
          {
            type: 'text' as const,
            text: `[analyze_dependencies] path=${args.path} — delegating to in-process service`
          }
        ]
      }
    }
  )

  server.tool(
    'analyze_test_coverage',
    'Find files that lack corresponding test files.',
    {
      path: z.string().optional().describe('Directory to scan (default: entire workspace)'),
      testPattern: z.string().optional().describe('Test file pattern (default: **/*.test.ts)')
    },
    async (args) => {
      return {
        content: [
          {
            type: 'text' as const,
            text: `[analyze_test_coverage] path=${args.path ?? 'all'} — delegating to in-process service`
          }
        ]
      }
    }
  )

  server.tool(
    'find_code_smells',
    'Detect common code quality issues in a file or directory.',
    {
      path: z.string().describe('File or directory to analyze'),
      maxResults: z.number().optional().default(20)
    },
    async (args) => {
      return {
        content: [
          {
            type: 'text' as const,
            text: `[find_code_smells] path=${args.path} max=${args.maxResults} — delegating to in-process service`
          }
        ]
      }
    }
  )

  server.tool(
    'suggest_refactoring',
    'Suggest refactoring opportunities for a file based on complexity and coupling analysis.',
    {
      filePath: z.string().describe('File to analyze for refactoring')
    },
    async (args) => {
      return {
        content: [
          {
            type: 'text' as const,
            text: `[suggest_refactoring] file=${args.filePath} — delegating to in-process service`
          }
        ]
      }
    }
  )
}

async function main(): Promise<void> {
  await registerTools()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`[code-analysis-server] Started (workspace=${WORKSPACE_PATH})`)
}

main().catch((err) => {
  console.error('[code-analysis-server] Fatal:', err)
  process.exit(1)
})
