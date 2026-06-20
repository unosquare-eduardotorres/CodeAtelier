#!/usr/bin/env node
/**
 * Code Graph MCP Server — externalized for CLI interactive mode.
 *
 * Exposes 13 tools for codebase navigation via the persisted SQLite code graph:
 *   graph_map, search_identifiers, find_dead_code, file_outline,
 *   find_callers, find_callees, find_references, file_dependencies,
 *   file_dependents, symbol_hotspots, coupling_analysis,
 *   circular_dependencies, module_boundary_health
 *
 * Environment variables:
 *   WORKSPACE_ID   — Workspace UUID for DB queries
 *   WORKSPACE_PATH — Absolute path to the workspace root
 *   CONTEXT_TIER   — Optional: 'small' | 'medium' | 'large' for tool gating
 *   DB_PATH        — Optional: path to the SQLite database file
 *
 * Architecture:
 *   This server opens a read-only connection to the same SQLite database that
 *   the Electron main process writes to. All queries go through the repository
 *   layer (shared code). Since the DB uses WAL mode, reads from this process
 *   don't block the main process's writes.
 *
 * Uses @modelcontextprotocol/sdk (the standard MCP SDK, NOT the Agent SDK).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { truncateToolOutput } from './output-cap'

// ── Environment ──
const WORKSPACE_ID = process.env.WORKSPACE_ID ?? ''
const WORKSPACE_PATH = process.env.WORKSPACE_PATH ?? process.cwd()
const CONTEXT_TIER = process.env.CONTEXT_TIER as 'small' | 'medium' | 'large' | undefined

if (!WORKSPACE_ID) {
  console.error('[code-graph-server] ERROR: WORKSPACE_ID is required')
  process.exit(1)
}

/**
 * Lazy-load the code graph service and repositories.
 *
 * These modules depend on better-sqlite3 and the database singleton.
 * In the externalized server, we import them dynamically to allow the
 * DB connection to be initialized with the correct path.
 *
 * NOTE: In the initial implementation, this server is designed to be
 * spawned from the same Electron app bundle, so it shares the same
 * node_modules and can import the service layer directly. For true
 * standalone deployment, the service layer would need to be extracted
 * into a shared package.
 */
async function loadServices(): Promise<{
  codeGraphService: typeof import('../services/code-graph.service').codeGraphService
  codeGraphTagRepository: typeof import('../db/repositories/code-graph-tag.repository').codeGraphTagRepository
  codeGraphEdgeRepository: typeof import('../db/repositories/code-graph-edge.repository').codeGraphEdgeRepository
}> {
  const { codeGraphService } = await import('../services/code-graph.service')
  const { codeGraphTagRepository } = await import('../db/repositories/code-graph-tag.repository')
  const { codeGraphEdgeRepository } = await import('../db/repositories/code-graph-edge.repository')
  return { codeGraphService, codeGraphTagRepository, codeGraphEdgeRepository }
}

// ── MCP Server ──

const server = new McpServer(
  { name: 'code-graph', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

async function registerTools(): Promise<void> {
  const { codeGraphService, codeGraphTagRepository, codeGraphEdgeRepository } = await loadServices()

  // ── graph_map ──
  server.tool(
    'graph_map',
    'Generate a ranked repository map of code definitions via PageRank.',
    {
      projectRoot: z.string().describe('Absolute path to the repository root'),
      focusFiles: z.array(z.string()).optional(),
      tokenLimit: z.number().int().min(1000).max(100000).optional().default(8192),
      excludeUnranked: z.boolean().optional().default(false),
      priorityFiles: z.array(z.string()).optional(),
      priorityIdentifiers: z.array(z.string()).optional()
    },
    async (args) => {
      const result = await codeGraphService.getRepoMap(WORKSPACE_ID, WORKSPACE_PATH, {
        focusFiles: args.focusFiles,
        mapTokens: args.tokenLimit,
        excludeUnranked: args.excludeUnranked,
        priorityFiles: args.priorityFiles,
        priorityIdentifiers: args.priorityIdentifiers
      })
      // 6A-2: Cap graph_map at 20,000 chars (large repos produce massive output)
      return {
        content: [
          {
            type: 'text' as const,
            text: truncateToolOutput(JSON.stringify(result, null, 2), 20_000)
          }
        ]
      }
    }
  )

  // ── search_identifiers ──
  server.tool(
    'search_identifiers',
    'Search for code identifiers across the repository via Tree-sitter AST analysis.',
    {
      query: z.string().describe('Identifier name (case-insensitive substring match)'),
      maxResults: z.number().int().min(1).max(500).optional().default(50),
      includeDefinitions: z.boolean().optional().default(true),
      includeReferences: z.boolean().optional().default(true)
    },
    async (args) => {
      const results = await codeGraphService.searchIdentifiers(
        WORKSPACE_ID,
        WORKSPACE_PATH,
        args.query,
        {
          maxResults: args.maxResults,
          includeDefinitions: args.includeDefinitions,
          includeReferences: args.includeReferences
        }
      )
      return {
        content: [
          { type: 'text' as const, text: truncateToolOutput(JSON.stringify({ results }, null, 2)) }
        ]
      }
    }
  )

  // ── find_dead_code ──
  server.tool(
    'find_dead_code',
    'Find potentially unused code definitions with no cross-file references.',
    {
      path: z.string().optional().describe('Filter to files under this directory'),
      maxResults: z.number().int().min(1).max(500).optional().default(50)
    },
    async (args) => {
      const results = await codeGraphService.findDeadCode(WORKSPACE_ID, WORKSPACE_PATH, {
        path: args.path,
        maxResults: args.maxResults
      })
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ results, count: results.length }, null, 2)
          }
        ]
      }
    }
  )

  // ── file_outline ──
  server.tool(
    'file_outline',
    'List all code definitions in a file with line numbers.',
    {
      filePath: z.string().describe('Relative file path within the workspace')
    },
    async (args) => {
      const tags = codeGraphTagRepository
        .findByFile(WORKSPACE_ID, args.filePath)
        .filter((t) => t.kind === 'def')
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                file: args.filePath,
                definitions: tags.map((t) => ({ name: t.name, line: t.line })),
                count: tags.length
              },
              null,
              2
            )
          }
        ]
      }
    }
  )

  // ── find_callers ──
  server.tool(
    'find_callers',
    'Find all call-sites and references to a symbol — who calls/imports/references it.',
    {
      symbolName: z.string().describe('Symbol name to find callers of'),
      maxResults: z.number().int().min(1).max(500).optional().default(50)
    },
    async (args) => {
      const edges = codeGraphEdgeRepository
        .findCallersOf(WORKSPACE_ID, args.symbolName)
        .slice(0, args.maxResults)
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                symbol: args.symbolName,
                callers: edges.map((e) => ({
                  sourceFile: e.sourceFile,
                  sourceSymbol: e.sourceSymbol,
                  edgeType: e.edgeType
                })),
                count: edges.length
              },
              null,
              2
            )
          }
        ]
      }
    }
  )

  // ── find_callees ──
  server.tool(
    'find_callees',
    'Find what a symbol depends on — what does it call, import, or reference.',
    {
      symbolName: z.string().describe('Symbol name to find callees of'),
      maxResults: z.number().int().min(1).max(500).optional().default(50)
    },
    async (args) => {
      const edges = codeGraphEdgeRepository
        .findCalleesOf(WORKSPACE_ID, args.symbolName)
        .slice(0, args.maxResults)
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                symbol: args.symbolName,
                callees: edges.map((e) => ({
                  targetFile: e.targetFile,
                  targetSymbol: e.targetSymbol,
                  edgeType: e.edgeType
                })),
                count: edges.length
              },
              null,
              2
            )
          }
        ]
      }
    }
  )

  // ── find_references ──
  server.tool(
    'find_references',
    'Find all cross-file reference sites for a symbol (excluding definitions).',
    {
      symbolName: z.string().describe('Symbol name to find references for'),
      maxResults: z.number().int().min(1).max(500).optional().default(50)
    },
    async (args) => {
      const refs = codeGraphTagRepository.searchByName(WORKSPACE_ID, args.symbolName, {
        maxResults: args.maxResults,
        includeDefinitions: false,
        includeReferences: true
      })
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                symbol: args.symbolName,
                references: refs.map((r) => ({ file: r.relFname, line: r.line, name: r.name })),
                count: refs.length
              },
              null,
              2
            )
          }
        ]
      }
    }
  )

  // ── file_dependencies ──
  server.tool(
    'file_dependencies',
    'Find files that a given file depends on (imports, calls, references).',
    {
      filePath: z.string().describe('Relative file path to analyze')
    },
    async (args) => {
      const deps = codeGraphEdgeRepository.findDependenciesOf(WORKSPACE_ID, args.filePath)
      const grouped: Record<string, string[]> = {}
      for (const d of deps) {
        ;(grouped[d.edgeType] ??= []).push(d.targetFile)
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { file: args.filePath, dependencies: grouped, totalCount: deps.length },
              null,
              2
            )
          }
        ]
      }
    }
  )

  // ── file_dependents ──
  server.tool(
    'file_dependents',
    'Find files that depend on a given file (blast radius).',
    {
      filePath: z.string().describe('Relative file path to find dependents of')
    },
    async (args) => {
      const deps = codeGraphEdgeRepository.findDependentsOf(WORKSPACE_ID, args.filePath)
      const grouped: Record<string, string[]> = {}
      for (const d of deps) {
        ;(grouped[d.edgeType] ??= []).push(d.sourceFile)
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { file: args.filePath, dependents: grouped, totalCount: deps.length },
              null,
              2
            )
          }
        ]
      }
    }
  )

  // ── symbol_hotspots ──
  server.tool(
    'symbol_hotspots',
    'Find the most-referenced symbols in the codebase (load-bearing abstractions).',
    {
      maxResults: z.number().int().min(1).max(500).optional().default(30),
      path: z.string().optional().describe('Filter to symbols in files under this directory')
    },
    async (args) => {
      const hotspots = codeGraphTagRepository.findSymbolHotspots(WORKSPACE_ID, {
        maxResults: args.maxResults,
        path: args.path
      })
      return {
        content: [
          {
            type: 'text' as const,
            text: truncateToolOutput(JSON.stringify({ hotspots, count: hotspots.length }, null, 2))
          }
        ]
      }
    }
  )

  // ── coupling_analysis ──
  server.tool(
    'coupling_analysis',
    'Find tightly coupled file pairs ranked by cross-references.',
    {
      minCoupling: z.number().int().min(1).max(100).optional().default(2),
      path: z.string().optional().describe('Filter to files under this directory'),
      maxResults: z.number().int().min(1).max(500).optional().default(50)
    },
    async (args) => {
      const coupled = codeGraphEdgeRepository.findCoupledFiles(WORKSPACE_ID, {
        minCoupling: args.minCoupling,
        path: args.path,
        maxResults: args.maxResults
      })
      return {
        content: [
          {
            type: 'text' as const,
            text: truncateToolOutput(
              JSON.stringify({ couples: coupled, count: coupled.length }, null, 2)
            )
          }
        ]
      }
    }
  )

  // ── circular_dependencies ──
  server.tool(
    'circular_dependencies',
    'Detect circular file-level dependencies in the codebase.',
    {
      path: z.string().optional().describe('Limit detection to files under this directory')
    },
    async (args) => {
      const cycles = codeGraphService.findCircularDependencies(WORKSPACE_ID, { path: args.path })
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ cycles, count: cycles.length }, null, 2) }
        ]
      }
    }
  )

  // ── module_boundary_health ──
  server.tool(
    'module_boundary_health',
    'Quantify separation of concerns by measuring intra-module vs cross-module edges.',
    {
      depth: z.number().int().min(1).max(10).optional().default(2).describe('Directory depth for module boundaries')
    },
    async (args) => {
      const metrics = codeGraphEdgeRepository.getModuleBoundaryMetrics(WORKSPACE_ID, args.depth)
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ modules: metrics, count: metrics.length }, null, 2)
          }
        ]
      }
    }
  )
}

// ── Bootstrap ──

async function main(): Promise<void> {
  await registerTools()

  const transport = new StdioServerTransport()
  await server.connect(transport)

  console.error(
    `[code-graph-server] Started (workspace=${WORKSPACE_ID}, tier=${CONTEXT_TIER ?? 'default'})`
  )
}

main().catch((err) => {
  console.error('[code-graph-server] Fatal:', err)
  process.exit(1)
})
