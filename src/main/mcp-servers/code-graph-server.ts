#!/usr/bin/env node
/**
 * Code Graph MCP Server — externalized for CLI interactive mode.
 *
 * Exposes 15 tools for codebase navigation via the persisted SQLite code graph:
 *   graph_map, search_identifiers, find_dead_code, file_outline,
 *   find_callers, find_callees, find_references, file_dependencies,
 *   file_dependents, symbol_hotspots, coupling_analysis,
 *   circular_dependencies, module_boundary_health, wiring_check, shortest_path
 *
 * Edge provenance (schema v130): every edge carries `resolution` — 'extracted'
 * (exactly one definition matched the name), 'inferred' (several candidates) or
 * 'ambiguous' (high fan-out). Results are ordered most-trustworthy first and the
 * value is surfaced so the model can discount weak matches instead of trusting
 * every edge equally.
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
import type { EdgeType } from '../db/repositories/code-graph-edge.repository'

/** Edge types an agent can filter on — mirrors the EdgeType union. */
const EDGE_TYPE_ENUM = z.enum(['calls', 'imports', 'extends', 'implements', 'references'])

/**
 * Structural declarations are referenced by shape rather than by call, so
 * "no cross-file reference" is a poor dead-code signal for them.
 */
const STRUCTURAL_SYMBOL_KINDS = ['interface', 'type']

/**
 * Provenance defaults, stated once per response instead of on every row.
 * The overwhelming majority of edges are `references` / `extracted`, so
 * repeating those values per row costs tokens without carrying signal — a
 * blank cell means "the default", a filled one means "pay attention".
 */
const DEFAULT_EDGE_TYPE = 'references'
const DEFAULT_RESOLUTION = 'extracted'
const PROVENANCE_DEFAULTS = { edgeType: DEFAULT_EDGE_TYPE, resolution: DEFAULT_RESOLUTION }

/**
 * Emit edgeType/resolution only when they deviate from the stated defaults.
 * A missing resolution is reported as 'inferred', never silently defaulted to
 * 'extracted' — omitting it would overstate how much the edge can be trusted.
 */
function deviatingProvenance(
  edgeType: string | undefined,
  resolution: string | undefined
): { edgeType?: string; resolution?: string } {
  const resolved = resolution ?? 'inferred'
  return {
    ...(edgeType === undefined || edgeType === DEFAULT_EDGE_TYPE ? {} : { edgeType }),
    ...(resolved === DEFAULT_RESOLUTION ? {} : { resolution: resolved })
  }
}

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
      const { codeGraphTagRepository } =
        await import('../db/repositories/code-graph-tag.repository')
      const { codeGraphEdgeRepository } =
        await import('../db/repositories/code-graph-edge.repository')
      console.error('[code-graph-server] Services initialized')
      return { codeGraphService, codeGraphTagRepository, codeGraphEdgeRepository }
    })()

    // Clear cached promise on rejection so next call can retry
    readyPromise.catch((err) => {
      if (retryCount < MAX_RETRIES) {
        retryCount++
        console.error(
          `[code-graph-server] Init failed (attempt ${retryCount}/${MAX_RETRIES}), will retry on next call:`,
          err
        )
        readyPromise = null // Allow next invocation to retry
      } else {
        console.error(
          `[code-graph-server] Init failed after ${MAX_RETRIES} retries — giving up:`,
          err
        )
      }
    })
  }
  return readyPromise
}

// ── Index-state awareness ──

/**
 * An empty result from an unindexed workspace is indistinguishable from a genuine
 * miss, so the model retries or wrongly concludes the code does not exist. These
 * helpers turn that silent dead-end into an explicit signal.
 */
const NOT_INDEXED_HINT =
  'This workspace has no code-graph index — code-graph tools cannot answer. Use Grep/Glob instead, and do not retry code-graph tools.'

/**
 * Only the positive answer is cached: indexing can complete while this server is
 * running, so a `false` must stay re-probeable. Caching `true` is safe — an index
 * is never un-built mid-session.
 */
let indexConfirmed = false

async function isIndexed(): Promise<boolean> {
  if (indexConfirmed) return true
  try {
    const { codeGraphService } = await ensureReady()
    indexConfirmed = codeGraphService.hasPersistedIndex(WORKSPACE_ID)
    return indexConfirmed
  } catch {
    // Fail open — a probe failure must not fabricate a "not indexed" claim.
    return true
  }
}

/** JSON tool result that self-describes a missing index when the result set is empty. */
async function graphPayload(
  isEmpty: boolean,
  payload: Record<string, unknown>,
  cap = 10_000
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const body =
    isEmpty && !(await isIndexed())
      ? { ...payload, indexed: false, hint: NOT_INDEXED_HINT }
      : payload
  return {
    content: [{ type: 'text' as const, text: truncateToolOutput(JSON.stringify(body), cap) }]
  }
}

/** Markdown tool result variant — appends the same hint as a trailing line. */
async function graphMarkdown(
  isEmpty: boolean,
  lines: string[],
  cap = 10_000
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const out = isEmpty && !(await isIndexed()) ? [...lines, `\n${NOT_INDEXED_HINT}`] : lines
  return {
    content: [{ type: 'text' as const, text: truncateToolOutput(out.join('\n'), cap) }]
  }
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
    'Ranked repository map (PageRank) plus subsystems and god nodes. Use for orientation in an ' +
      'unfamiliar repo — not to answer a specific question.',
    {
      projectRoot: z.string().describe('Absolute path to the repository root'),
      focusFiles: z.array(z.string()).optional(),
      tokenLimit: z.number().int().min(1000).max(100000).optional().default(8192),
      excludeUnranked: z.boolean().optional().default(false),
      priorityFiles: z.array(z.string()).optional(),
      priorityIdentifiers: z.array(z.string()).optional(),
      includeSubsystems: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Include detected subsystems (clusters of files that belong together) and ' +
            'god nodes. Off by default — costs ~30 lines; turn on when orienting in ' +
            'an unfamiliar repo rather than for routine lookups.'
        )
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

      // Subsystems answer "what belongs together?", which PageRank alone cannot.
      // Only names and sizes are emitted — member lists would dwarf the map itself.
      let subsystems: object | undefined
      if (args.includeSubsystems) {
        const { communities, godNodes } = codeGraphService.getSubsystems(WORKSPACE_ID)
        subsystems = {
          communities: communities.map((c) => ({
            name: c.name,
            hubFile: c.hubFile,
            fileCount: c.files.length,
            internalEdges: c.internalEdges
          })),
          godNodes
        }
      }

      // 6A-2: Cap graph_map at 20,000 chars (large repos produce massive output)
      return {
        content: [
          {
            type: 'text' as const,
            text: truncateToolOutput(JSON.stringify({ ...result, subsystems }), 20_000)
          }
        ]
      }
    })
  )

  // ── search_identifiers ──
  server.tool(
    'search_identifiers',
    'Find a symbol by name (case-insensitive substring) — fastest first step when you know or ' +
      'can guess the identifier. Prefer over Grep for symbols; Grep wins for string literals.',
    {
      query: z.string().describe('Identifier name (case-insensitive substring match)'),
      maxResults: z.number().int().min(1).max(500).optional().default(50),
      includeDefinitions: z.boolean().optional().default(true),
      includeReferences: z.boolean().optional().default(true),
      symbolKinds: z
        .array(z.string())
        .optional()
        .describe(
          "Restrict to capture subtypes, e.g. ['function','method'] or ['interface','type']"
        )
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
          includeReferences: args.includeReferences,
          symbolKinds: args.symbolKinds
        }
      )
      return graphPayload(results.length === 0, { results })
    })
  )

  // ── find_dead_code ──
  server.tool(
    'find_dead_code',
    'Find potentially unused code definitions with no cross-file references.',
    {
      path: z.string().optional().describe('Filter to files under this directory'),
      maxResults: z.number().int().min(1).max(500).optional().default(50),
      includeTypeDeclarations: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Include interfaces and type aliases. Off by default: they are referenced ' +
            'structurally rather than by call, so unreferenced ≠ dead.'
        ),
      format: z.enum(['json', 'markdown']).optional().default('json').describe('Output format')
    },
    withErrorBoundary('find_dead_code', async (args) => {
      const { codeGraphService } = await ensureReady()
      const results = await codeGraphService.findDeadCode(WORKSPACE_ID, WORKSPACE_PATH, {
        path: args.path,
        maxResults: args.maxResults,
        excludeSymbolKinds: args.includeTypeDeclarations ? undefined : STRUCTURAL_SYMBOL_KINDS
      })
      if (args.format === 'markdown') {
        const lines = [`### Dead Code (${results.length} unreferenced symbols)\n`]
        if (results.length === 0) {
          lines.push('✅ No unreferenced symbols found.')
        } else {
          lines.push('| Symbol | Kind | File | Line |')
          lines.push('|--------|------|------|------|')
          for (const r of results) {
            lines.push(`| ${r.name} | ${r.symbolKind ?? '?'} | ${r.file} | ${r.line} |`)
          }
        }
        return {
          content: [{ type: 'text' as const, text: truncateToolOutput(lines.join('\n'), 10_000) }]
        }
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
    'List every definition in a file with line numbers. Call before Read on files over ~300 ' +
      'lines — a fraction of the tokens.',
    {
      filePath: z.string().describe('Relative file path within the workspace')
    },
    withErrorBoundary('file_outline', async (args) => {
      const { codeGraphTagRepository } = await ensureReady()
      const tags = codeGraphTagRepository
        .findByFile(WORKSPACE_ID, args.filePath)
        .filter((t) => t.kind === 'def')
      return graphPayload(tags.length === 0, {
        file: args.filePath,
        definitions: tags.map((t) => ({
          name: t.name,
          line: t.line,
          // 'class' | 'method' | 'function' | 'interface' | … (null pre-v130 index)
          kind: t.symbolKind ?? null
        })),
        count: tags.length
      })
    })
  )

  // ── find_callers ──
  server.tool(
    'find_callers',
    'Who calls this symbol — use before changing or deleting it. Results ordered most-trustworthy ' +
      'first; resolution=inferred/ambiguous are name-matches with several candidates, so treat ' +
      'them as leads.',
    {
      symbolName: z.string().describe('Symbol name to find callers of'),
      maxResults: z.number().int().min(1).max(500).optional().default(50),
      edgeTypes: z
        .array(EDGE_TYPE_ENUM)
        .optional()
        .describe(
          "Restrict to these edge types, e.g. ['calls'] to skip type-only mentions. " +
            'Note: some grammars (TypeScript) do not emit call captures, so filtering ' +
            'on calls can return nothing there — omit to see everything.'
        ),
      deduplicate: z
        .boolean()
        .optional()
        .default(true)
        .describe('Remove duplicate results (default: true)'),
      format: z.enum(['json', 'markdown']).optional().default('json').describe('Output format')
    },
    withErrorBoundary('find_callers', async (args) => {
      const { codeGraphEdgeRepository } = await ensureReady()
      const { sortByResolution } = await import('../db/repositories/code-graph-edge.repository')
      let callers = sortByResolution(
        codeGraphEdgeRepository.findCallersOf(WORKSPACE_ID, args.symbolName, {
          edgeTypes: args.edgeTypes as EdgeType[] | undefined
        })
      ).slice(0, args.maxResults)
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
        ...deviatingProvenance(e.edgeType, e.resolution)
      }))
      if (args.format === 'markdown') {
        const lines = [
          `### Callers of \`${args.symbolName}\` (${mapped.length}) — blank = defaults: ` +
            `edgeType=${DEFAULT_EDGE_TYPE}, resolution=${DEFAULT_RESOLUTION}\n`
        ]
        if (mapped.length === 0) {
          lines.push('No callers found.')
        } else {
          lines.push('| Source File | Source Symbol | Edge Type | Resolution |')
          lines.push('|-------------|---------------|-----------|------------|')
          for (const c of mapped) {
            lines.push(
              `| ${c.sourceFile} | ${c.sourceSymbol} | ${c.edgeType ?? ''} | ${c.resolution ?? ''} |`
            )
          }
        }
        return graphMarkdown(mapped.length === 0, lines)
      }
      return graphPayload(mapped.length === 0, {
        symbol: args.symbolName,
        defaults: PROVENANCE_DEFAULTS,
        callers: mapped,
        count: mapped.length
      })
    })
  )

  // ── find_callees ──
  server.tool(
    'find_callees',
    'Find callees of a symbol.',
    {
      symbolName: z.string().describe('Symbol name to find callees of'),
      maxResults: z.number().int().min(1).max(500).optional().default(50),
      edgeTypes: z
        .array(EDGE_TYPE_ENUM)
        .optional()
        .describe("Restrict to these edge types, e.g. ['calls']"),
      format: z.enum(['json', 'markdown']).optional().default('json').describe('Output format')
    },
    withErrorBoundary('find_callees', async (args) => {
      const { codeGraphEdgeRepository } = await ensureReady()
      const { sortByResolution } = await import('../db/repositories/code-graph-edge.repository')
      const callees = sortByResolution(
        codeGraphEdgeRepository.findCalleesOf(WORKSPACE_ID, args.symbolName, {
          edgeTypes: args.edgeTypes as EdgeType[] | undefined
        })
      ).slice(0, args.maxResults)
      const mapped = callees.map((e) => ({
        targetFile: e.targetFile,
        targetSymbol: e.targetSymbol,
        ...deviatingProvenance(e.edgeType, e.resolution)
      }))
      if (args.format === 'markdown') {
        const lines = [
          `### Callees of \`${args.symbolName}\` (${mapped.length}) — blank = defaults: ` +
            `edgeType=${DEFAULT_EDGE_TYPE}, resolution=${DEFAULT_RESOLUTION}\n`
        ]
        if (mapped.length === 0) {
          lines.push('No callees found.')
        } else {
          lines.push('| Target File | Target Symbol | Edge Type | Resolution |')
          lines.push('|-------------|---------------|-----------|------------|')
          for (const c of mapped) {
            lines.push(
              `| ${c.targetFile} | ${c.targetSymbol} | ${c.edgeType ?? ''} | ${c.resolution ?? ''} |`
            )
          }
        }
        return graphMarkdown(mapped.length === 0, lines)
      }
      return graphPayload(mapped.length === 0, {
        symbol: args.symbolName,
        defaults: PROVENANCE_DEFAULTS,
        callees: mapped,
        count: mapped.length
      })
    })
  )

  // ── find_references ──
  server.tool(
    'find_references',
    'Find cross-file references to a symbol.',
    {
      symbolName: z.string().describe('Symbol name to find references for'),
      maxResults: z.number().int().min(1).max(500).optional().default(50),
      deduplicate: z
        .boolean()
        .optional()
        .default(true)
        .describe('Remove duplicate results (default: true)'),
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
      const mapped = refs.map((r) => ({
        file: r.relFname,
        line: r.line,
        name: r.name,
        kind: r.symbolKind ?? null
      }))
      if (args.format === 'markdown') {
        const lines = [`### References to \`${args.symbolName}\` (${mapped.length})\n`]
        if (mapped.length === 0) {
          lines.push('No references found.')
        } else {
          lines.push('| File | Line | Name | Kind |')
          lines.push('|------|------|------|------|')
          for (const r of mapped) {
            lines.push(`| ${r.file} | ${r.line} | ${r.name} | ${r.kind ?? '?'} |`)
          }
        }
        return graphMarkdown(mapped.length === 0, lines)
      }
      return graphPayload(mapped.length === 0, {
        symbol: args.symbolName,
        references: mapped,
        count: mapped.length
      })
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
              JSON.stringify({
                file: args.filePath,
                dependencies: grouped,
                totalCount: deps.length
              }),
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
      deduplicate: z
        .boolean()
        .optional()
        .default(true)
        .describe('Remove duplicate file entries per edge type (default: true)')
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
            text: truncateToolOutput(JSON.stringify({ couples: coupled, count: coupled.length }))
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
          {
            type: 'text' as const,
            text: truncateToolOutput(JSON.stringify({ cycles, count: cycles.length }), 10_000)
          }
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
            text: truncateToolOutput(
              JSON.stringify({ modules: metrics, count: metrics.length }),
              10_000
            )
          }
        ]
      }
    })
  )

  // ── shortest_path ──
  server.tool(
    'shortest_path',
    'Dependency path from file A to file B. The tool for "how does A reach B" / "is X used by Y" — ' +
      'one call instead of walking file_dependencies repeatedly.',
    {
      fromFile: z.string().describe('Relative path of the starting file'),
      toFile: z.string().describe('Relative path of the destination file'),
      maxDepth: z
        .number()
        .int()
        .min(1)
        .max(12)
        .optional()
        .default(6)
        .describe('Maximum hops to search before giving up'),
      format: z.enum(['json', 'markdown']).optional().default('markdown').describe('Output format')
    },
    withErrorBoundary('shortest_path', async (args) => {
      const { codeGraphEdgeRepository } = await ensureReady()
      const result = codeGraphEdgeRepository.findShortestPath(
        WORKSPACE_ID,
        args.fromFile,
        args.toFile,
        args.maxDepth
      )

      if (!result) {
        const msg =
          `No dependency path from ${args.fromFile} to ${args.toFile} ` +
          `within ${args.maxDepth} hops.`
        return {
          content: [
            {
              type: 'text' as const,
              text: args.format === 'markdown' ? msg : JSON.stringify({ path: null, reason: msg })
            }
          ]
        }
      }

      if (args.format === 'markdown') {
        const lines = [
          `### Path: ${args.fromFile} → ${args.toFile} (${result.hops.length} hops)\n`,
          '| # | From | To | Via Symbol | Edge Type | Resolution |',
          '|---|------|----|-----------|-----------|------------|'
        ]
        result.hops.forEach((h, i) => {
          lines.push(
            `| ${i + 1} | ${h.from} | ${h.to} | ${h.symbol} | ${h.edgeType} | ${h.resolution} |`
          )
        })
        return {
          content: [{ type: 'text' as const, text: truncateToolOutput(lines.join('\n'), 10_000) }]
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: truncateToolOutput(
              JSON.stringify({ path: result.path, hops: result.hops, length: result.hops.length }),
              10_000
            )
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
