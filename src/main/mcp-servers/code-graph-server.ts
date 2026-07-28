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
import { withErrorBoundary } from './tool-error-handler'

// ── Environment ──
const WORKSPACE_ID = process.env.WORKSPACE_ID ?? ''
const WORKSPACE_PATH = process.env.WORKSPACE_PATH ?? process.cwd()
const CONTEXT_TIER = process.env.CONTEXT_TIER as 'small' | 'medium' | 'large' | undefined

if (!WORKSPACE_ID) {
  console.error('[code-graph-server] ERROR: WORKSPACE_ID is required')
  process.exit(1)
}

// ── Lazy service initialization ─────────────────────────────────────────

type CodeGraphServices = {
  codeGraphService: typeof import('../services/code-graph.service').codeGraphService
  codeGraphTagRepository: typeof import('../db/repositories/code-graph-tag.repository').codeGraphTagRepository
  codeGraphEdgeRepository: typeof import('../db/repositories/code-graph-edge.repository').codeGraphEdgeRepository
}

let readyPromise: Promise<CodeGraphServices> | null = null
let retryCount = 0
const MAX_RETRIES = 3

/**
 * Memoized lazy init — imports code graph service and repositories.
 *
 * These modules depend on better-sqlite3 and the database singleton.
 * In the externalized server, we import them dynamically to allow the
 * DB connection to be initialized with the correct path.
 */
function ensureReady(): Promise<CodeGraphServices> {
  if (!readyPromise) {
    readyPromise = (async (): Promise<CodeGraphServices> => {
      // Pre-flight: verify native module compatibility before importing DB-backed services
      const { checkNativeModuleCompat } = await import('./native-module-check')
      const compat = checkNativeModuleCompat()
      if (!compat.ok) {
        throw new Error(compat.error ?? 'Native module check failed')
      }
      const { codeGraphService } = await import('../services/code-graph.service')
      const { codeGraphTagRepository } = await import('../db/repositories/code-graph-tag.repository')
      const { codeGraphEdgeRepository } = await import('../db/repositories/code-graph-edge.repository')
      console.error('[code-graph-server] Services initialized')
      return { codeGraphService, codeGraphTagRepository, codeGraphEdgeRepository }
    })()

    // Clear cached promise on rejection so next call can retry
    readyPromise.catch((err) => {
      if (retryCount < MAX_RETRIES) {
        retryCount++
        console.error(`[code-graph-server] Init failed (attempt ${retryCount}/${MAX_RETRIES}), will retry on next call:`, err)
        readyPromise = null // Allow next invocation to retry
      } else {
        console.error(`[code-graph-server] Init failed after ${MAX_RETRIES} retries — giving up:`, err)
      }
    })
  }
  return readyPromise
}

// ── MCP Server ──

const server = new McpServer(
  { name: 'code-graph', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

function registerToolSchemas(): void {
  // ── graph_map ──
  server.tool(
    'graph_map',
    'Ranked repository map via PageRank.',
    {
      projectRoot: z.string().describe('Absolute path to the repository root'),
      focusFiles: z.array(z.string()).optional(),
      tokenLimit: z.number().int().min(1000).max(100000).optional().default(8192),
      excludeUnranked: z.boolean().optional().default(false),
      priorityFiles: z.array(z.string()).optional(),
      priorityIdentifiers: z.array(z.string()).optional()
    },
    withErrorBoundary('graph_map', async (args) => {
      const { codeGraphService } = await ensureReady()
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
            text: truncateToolOutput(JSON.stringify(result), 20_000)
          }
        ]
      }
    })
  )

  // ── search_identifiers ──
  server.tool(
    'search_identifiers',
    'Search code identifiers by name (substring match).',
    {
      query: z.string().describe('Identifier name (case-insensitive substring match)'),
      maxResults: z.number().int().min(1).max(500).optional().default(50),
      includeDefinitions: z.boolean().optional().default(true),
      includeReferences: z.boolean().optional().default(true)
    },
    withErrorBoundary('search_identifiers', async (args) => {
      const { codeGraphService } = await ensureReady()
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
          { type: 'text' as const, text: truncateToolOutput(JSON.stringify({ results })) }
        ]
      }
    })
  )

  // ── find_dead_code ──
  server.tool(
    'find_dead_code',
    'Find potentially unused code definitions with no cross-file references.',
    {
      path: z.string().optional().describe('Filter to files under this directory'),
      maxResults: z.number().int().min(1).max(500).optional().default(50),
      format: z.enum(['json', 'markdown']).optional().default('json').describe('Output format')
    },
    withErrorBoundary('find_dead_code', async (args) => {
      const { codeGraphService } = await ensureReady()
      const results = await codeGraphService.findDeadCode(WORKSPACE_ID, WORKSPACE_PATH, {
        path: args.path,
        maxResults: args.maxResults
      })
      if (args.format === 'markdown') {
        const lines = [`### Dead Code (${results.length} unreferenced symbols)\n`]
        if (results.length === 0) {
          lines.push('✅ No unreferenced symbols found.')
        } else {
          lines.push('| Symbol | File | Line |')
          lines.push('|--------|------|------|')
          for (const r of results) {
            lines.push(`| ${r.name} | ${r.file} | ${r.line} |`)
          }
        }
        return { content: [{ type: 'text' as const, text: truncateToolOutput(lines.join('\n'), 10_000) }] }
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: truncateToolOutput(JSON.stringify({ results, count: results.length }), 10_000)
          }
        ]
      }
    })
  )

  // ── file_outline ──
  server.tool(
    'file_outline',
    'List all code definitions in a file with line numbers.',
    {
      filePath: z.string().describe('Relative file path within the workspace')
    },
    withErrorBoundary('file_outline', async (args) => {
      const { codeGraphTagRepository } = await ensureReady()
      const tags = codeGraphTagRepository
        .findByFile(WORKSPACE_ID, args.filePath)
        .filter((t) => t.kind === 'def')
      return {
        content: [
          {
            type: 'text' as const,
            text: truncateToolOutput(
              JSON.stringify({
                file: args.filePath,
                definitions: tags.map((t) => ({ name: t.name, line: t.line })),
                count: tags.length
              }),
              10_000
            )
          }
        ]
      }
    })
  )

  // ── find_callers ──
  server.tool(
    'find_callers',
    'Find callers of a symbol.',
    {
      symbolName: z.string().describe('Symbol name to find callers of'),
      maxResults: z.number().int().min(1).max(500).optional().default(50),
      deduplicate: z.boolean().optional().default(true).describe('Remove duplicate results (default: true)'),
      format: z.enum(['json', 'markdown']).optional().default('json').describe('Output format')
    },
    withErrorBoundary('find_callers', async (args) => {
      const { codeGraphEdgeRepository } = await ensureReady()
      let callers = codeGraphEdgeRepository
        .findCallersOf(WORKSPACE_ID, args.symbolName)
        .slice(0, args.maxResults)
      if (args.deduplicate) {
        const seen = new Set<string>()
        callers = callers.filter((e) => {
          const key = `${e.sourceFile}::${e.sourceSymbol}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
      }
      const mapped = callers.map((e) => ({
        sourceFile: e.sourceFile,
        sourceSymbol: e.sourceSymbol,
        edgeType: e.edgeType
      }))
      if (args.format === 'markdown') {
        const lines = [`### Callers of \`${args.symbolName}\` (${mapped.length})\n`]
        if (mapped.length === 0) {
          lines.push('No callers found.')
        } else {
          lines.push('| Source File | Source Symbol | Edge Type |')
          lines.push('|-------------|---------------|-----------|')
          for (const c of mapped) {
            lines.push(`| ${c.sourceFile} | ${c.sourceSymbol} | ${c.edgeType} |`)
          }
        }
        return { content: [{ type: 'text' as const, text: truncateToolOutput(lines.join('\n'), 10_000) }] }
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: truncateToolOutput(
              JSON.stringify({ symbol: args.symbolName, callers: mapped, count: mapped.length }),
              10_000
            )
          }
        ]
      }
    })
  )

  // ── find_callees ──
  server.tool(
    'find_callees',
    'Find callees of a symbol.',
    {
      symbolName: z.string().describe('Symbol name to find callees of'),
      maxResults: z.number().int().min(1).max(500).optional().default(50),
      format: z.enum(['json', 'markdown']).optional().default('json').describe('Output format')
    },
    withErrorBoundary('find_callees', async (args) => {
      const { codeGraphEdgeRepository } = await ensureReady()
      const callees = codeGraphEdgeRepository
        .findCalleesOf(WORKSPACE_ID, args.symbolName)
        .slice(0, args.maxResults)
      const mapped = callees.map((e) => ({
        targetFile: e.targetFile,
        targetSymbol: e.targetSymbol,
        edgeType: e.edgeType
      }))
      if (args.format === 'markdown') {
        const lines = [`### Callees of \`${args.symbolName}\` (${mapped.length})\n`]
        if (mapped.length === 0) {
          lines.push('No callees found.')
        } else {
          lines.push('| Target File | Target Symbol | Edge Type |')
          lines.push('|-------------|---------------|-----------|')
          for (const c of mapped) {
            lines.push(`| ${c.targetFile} | ${c.targetSymbol} | ${c.edgeType} |`)
          }
        }
        return { content: [{ type: 'text' as const, text: truncateToolOutput(lines.join('\n'), 10_000) }] }
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: truncateToolOutput(
              JSON.stringify({ symbol: args.symbolName, callees: mapped, count: mapped.length }),
              10_000
            )
          }
        ]
      }
    })
  )

  // ── find_references ──
  server.tool(
    'find_references',
    'Find cross-file references to a symbol.',
    {
      symbolName: z.string().describe('Symbol name to find references for'),
      maxResults: z.number().int().min(1).max(500).optional().default(50),
      deduplicate: z.boolean().optional().default(true).describe('Remove duplicate results (default: true)'),
      format: z.enum(['json', 'markdown']).optional().default('json').describe('Output format')
    },
    withErrorBoundary('find_references', async (args) => {
      const { codeGraphTagRepository } = await ensureReady()
      let refs = codeGraphTagRepository.searchByName(WORKSPACE_ID, args.symbolName, {
        maxResults: args.maxResults,
        includeDefinitions: false,
        includeReferences: true
      })
      if (args.deduplicate) {
        const seen = new Set<string>()
        refs = refs.filter((r) => {
          const key = `${r.relFname}::${r.line}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
      }
      const mapped = refs.map((r) => ({ file: r.relFname, line: r.line, name: r.name }))
      if (args.format === 'markdown') {
        const lines = [`### References to \`${args.symbolName}\` (${mapped.length})\n`]
        if (mapped.length === 0) {
          lines.push('No references found.')
        } else {
          lines.push('| File | Line | Name |')
          lines.push('|------|------|------|')
          for (const r of mapped) {
            lines.push(`| ${r.file} | ${r.line} | ${r.name} |`)
          }
        }
        return { content: [{ type: 'text' as const, text: truncateToolOutput(lines.join('\n'), 10_000) }] }
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: truncateToolOutput(
              JSON.stringify({ symbol: args.symbolName, references: mapped, count: mapped.length }),
              10_000
            )
          }
        ]
      }
    })
  )

  // ── file_dependencies ──
  server.tool(
    'file_dependencies',
    'Find files a file depends on.',
    {
      filePath: z.string().describe('Relative file path to analyze')
    },
    withErrorBoundary('file_dependencies', async (args) => {
      const { codeGraphEdgeRepository } = await ensureReady()
      const deps = codeGraphEdgeRepository.findDependenciesOf(WORKSPACE_ID, args.filePath)
      const grouped: Record<string, string[]> = {}
      for (const d of deps) {
        ;(grouped[d.edgeType] ??= []).push(d.targetFile)
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: truncateToolOutput(
              JSON.stringify({ file: args.filePath, dependencies: grouped, totalCount: deps.length }),
              10_000
            )
          }
        ]
      }
    })
  )

  // ── file_dependents ──
  server.tool(
    'file_dependents',
    'Find files that depend on a given file (blast radius).',
    {
      filePath: z.string().describe('Relative file path to find dependents of'),
      deduplicate: z.boolean().optional().default(true).describe('Remove duplicate file entries per edge type (default: true)')
    },
    withErrorBoundary('file_dependents', async (args) => {
      const { codeGraphEdgeRepository } = await ensureReady()
      const deps = codeGraphEdgeRepository.findDependentsOf(WORKSPACE_ID, args.filePath)
      const grouped: Record<string, string[]> = {}
      for (const d of deps) {
        ;(grouped[d.edgeType] ??= []).push(d.sourceFile)
      }
      if (args.deduplicate) {
        for (const type of Object.keys(grouped)) {
          grouped[type] = [...new Set(grouped[type])]
        }
      }
      const totalCount = Object.values(grouped).reduce((s, arr) => s + arr.length, 0)
      return {
        content: [
          {
            type: 'text' as const,
            text: truncateToolOutput(
              JSON.stringify({ file: args.filePath, dependents: grouped, totalCount }),
              10_000
            )
          }
        ]
      }
    })
  )

  // ── symbol_hotspots ──
  server.tool(
    'symbol_hotspots',
    'Find most-referenced symbols.',
    {
      maxResults: z.number().int().min(1).max(500).optional().default(30),
      path: z.string().optional().describe('Filter to symbols in files under this directory')
    },
    withErrorBoundary('symbol_hotspots', async (args) => {
      const { codeGraphTagRepository } = await ensureReady()
      const hotspots = codeGraphTagRepository.findSymbolHotspots(WORKSPACE_ID, {
        maxResults: args.maxResults,
        path: args.path
      })
      return {
        content: [
          {
            type: 'text' as const,
            text: truncateToolOutput(JSON.stringify({ hotspots, count: hotspots.length }))
          }
        ]
      }
    })
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
    withErrorBoundary('coupling_analysis', async (args) => {
      const { codeGraphEdgeRepository } = await ensureReady()
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
              JSON.stringify({ couples: coupled, count: coupled.length })
            )
          }
        ]
      }
    })
  )

  // ── circular_dependencies ──
  server.tool(
    'circular_dependencies',
    'Detect circular file-level dependencies in the codebase.',
    {
      path: z.string().optional().describe('Limit detection to files under this directory')
    },
    withErrorBoundary('circular_dependencies', async (args) => {
      const { codeGraphService } = await ensureReady()
      const cycles = codeGraphService.findCircularDependencies(WORKSPACE_ID, { path: args.path })
      return {
        content: [
          { type: 'text' as const, text: truncateToolOutput(JSON.stringify({ cycles, count: cycles.length }), 10_000) }
        ]
      }
    })
  )

  // ── module_boundary_health ──
  server.tool(
    'module_boundary_health',
    'Measure module boundary health (intra vs cross-module edges).',
    {
      depth: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .default(2)
        .describe('Directory depth for module boundaries')
    },
    withErrorBoundary('module_boundary_health', async (args) => {
      const { codeGraphEdgeRepository } = await ensureReady()
      const metrics = codeGraphEdgeRepository.getModuleBoundaryMetrics(WORKSPACE_ID, args.depth)
      return {
        content: [
          {
            type: 'text' as const,
            text: truncateToolOutput(JSON.stringify({ modules: metrics, count: metrics.length }), 10_000)
          }
        ]
      }
    })
  )

  // ── wiring_check ──
  server.tool(
    'wiring_check',
    'Check wiring for multiple files: verifies exports have importers and new symbols are referenced. Use instead of calling file_dependents + find_references separately per file.',
    {
      filePaths: z.array(z.string()).min(1).max(20).describe('Files to check wiring for'),
      symbolNames: z.array(z.string()).optional().describe('Key symbols to verify references for')
    },
    withErrorBoundary('wiring_check', async (args) => {
      const { codeGraphTagRepository, codeGraphEdgeRepository } = await ensureReady()
      const fileResults: Array<{ file: string; dependentCount: number; status: string }> = []
      for (const filePath of args.filePaths) {
        const deps = codeGraphEdgeRepository.findDependentsOf(WORKSPACE_ID, filePath)
        // Deduplicate by source file
        const uniqueFiles = new Set(deps.map((d) => d.sourceFile))
        fileResults.push({
          file: filePath,
          dependentCount: uniqueFiles.size,
          status: uniqueFiles.size > 0 ? '✅ Wired' : '❌ No importers'
        })
      }

      const symbolResults: Array<{ symbol: string; refCount: number; status: string }> = []
      if (args.symbolNames) {
        for (const sym of args.symbolNames) {
          const refs = codeGraphTagRepository.searchByName(WORKSPACE_ID, sym, {
            maxResults: 50,
            includeDefinitions: false,
            includeReferences: true
          })
          // Deduplicate by file+line
          const seen = new Set<string>()
          const uniqueRefs = refs.filter((r) => {
            const key = `${r.relFname}::${r.line}`
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })
          symbolResults.push({
            symbol: sym,
            refCount: uniqueRefs.length,
            status: uniqueRefs.length > 0 ? '✅ Used' : '❌ Unreferenced'
          })
        }
      }

      // Build markdown report
      const lines: string[] = [
        `### Wiring Check (${fileResults.length} files${symbolResults.length > 0 ? `, ${symbolResults.length} symbols` : ''})\n`
      ]

      lines.push('| File | Dependents | Status |')
      lines.push('|------|-----------|--------|')
      for (const f of fileResults) {
        lines.push(`| ${f.file} | ${f.dependentCount} | ${f.status} |`)
      }

      if (symbolResults.length > 0) {
        lines.push('')
        lines.push('| Symbol | References | Status |')
        lines.push('|--------|-----------|--------|')
        for (const s of symbolResults) {
          lines.push(`| ${s.symbol} | ${s.refCount} | ${s.status} |`)
        }
      }

      return {
        content: [{ type: 'text' as const, text: truncateToolOutput(lines.join('\n'), 10_000) }]
      }
    })
  )
}

// ── Bootstrap ──

async function main(): Promise<void> {
  registerToolSchemas()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(
    `[code-graph-server] Started (workspace=${WORKSPACE_ID}, tier=${CONTEXT_TIER ?? 'default'})`
  )
  // Warm up services in the background — non-blocking
  void ensureReady().catch((err) =>
    console.error('[code-graph-server] Background warm-up failed:', err)
  )
}

main().catch((err) => {
  console.error('[code-graph-server] Fatal:', err)
  process.exit(1)
})
