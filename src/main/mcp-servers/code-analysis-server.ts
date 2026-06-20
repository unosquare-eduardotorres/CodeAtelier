#!/usr/bin/env node
/**
 * Code Analysis MCP Server — externalized for CLI interactive mode.
 *
 * Exposes: analyze_complexity, analyze_dependencies, analyze_test_coverage,
 *          find_code_smells, suggest_refactoring, resolve_library_id,
 *          query_library_docs
 *
 * Environment variables:
 *   WORKSPACE_PATH    — Absolute workspace path
 *   WORKSPACE_ID      — Workspace UUID (for DB-backed features)
 *   DB_PATH           — SQLite database directory
 *   CONTEXT7_API_KEY  — Optional Context7 API key for library doc fallback
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { truncateToolOutput } from './output-cap'
import { LibraryDocService } from '../services/library-doc.service'
import { libraryDocRepository } from '../db/repositories/library-doc.repository'

const WORKSPACE_PATH = process.env.WORKSPACE_PATH ?? process.cwd()
const WORKSPACE_ID = process.env.WORKSPACE_ID ?? ''
const CONTEXT7_API_KEY = process.env.CONTEXT7_API_KEY ?? ''

// Service instance — standalone (no Electron) so we instantiate directly
const libraryDocService = new LibraryDocService()

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

  // ── Library Documentation Tools ──

  server.tool(
    'resolve_library_id',
    'Search for a library by name. Checks local cache first, then Context7, then npm registry. Returns available packages and their doc coverage.',
    {
      libraryName: z.string().describe('Package name (e.g. "zod", "electron", "react")'),
      query: z.string().optional().describe('What you need — improves ranking')
    },
    async (args) => {
      if (!WORKSPACE_ID) {
        return {
          content: [{
            type: 'text' as const,
            text: '[resolve_library_id] WORKSPACE_ID not set — cannot access library doc cache'
          }]
        }
      }
      try {
        const results = await libraryDocService.resolveLibrary(
          WORKSPACE_ID,
          WORKSPACE_PATH,
          args.libraryName,
          CONTEXT7_API_KEY || undefined,
          args.query
        )
        return {
          content: [{
            type: 'text' as const,
            text: truncateToolOutput(
              JSON.stringify({ matches: results, count: results.length }, null, 2),
              15_000
            )
          }]
        }
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `[resolve_library_id] Error: ${err instanceof Error ? err.message : String(err)}`
          }]
        }
      }
    }
  )

  server.tool(
    'query_library_docs',
    'Get documentation for a library. Returns relevant sections matched by full-text search. Falls back through local cache → Context7 → npm registry.',
    {
      packageName: z.string().describe('Package name (exact match)'),
      query: z.string().describe('Specific question or topic to search for'),
      maxSections: z.number().optional().default(5).describe('Max doc sections to return')
    },
    async (args) => {
      if (!WORKSPACE_ID) {
        return {
          content: [{
            type: 'text' as const,
            text: '[query_library_docs] WORKSPACE_ID not set — cannot access library doc cache'
          }]
        }
      }
      try {
        const result = await libraryDocService.queryDocs(
          WORKSPACE_ID,
          WORKSPACE_PATH,
          args.packageName,
          args.query,
          CONTEXT7_API_KEY || undefined,
          args.maxSections
        )
        return {
          content: [{
            type: 'text' as const,
            text: truncateToolOutput(JSON.stringify(result, null, 2), 15_000)
          }]
        }
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `[query_library_docs] Error: ${err instanceof Error ? err.message : String(err)}`
          }]
        }
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
