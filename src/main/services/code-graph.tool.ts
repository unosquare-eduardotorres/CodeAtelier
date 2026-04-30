import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import log from 'electron-log/main'
import { MCP_TOOLS } from '../../shared/constants'
import { codeGraphService } from './code-graph.service'
import { codeGraphTagRepository } from '../db/repositories/code-graph-tag.repository'
import { codeGraphEdgeRepository } from '../db/repositories/code-graph-edge.repository'

/**
 * Manages per-workspace MCP servers that expose `graph_map` and `search_identifiers`
 * tools to the Claude Agent SDK. Reads from the persisted SQLite code graph —
 * no filesystem walk or PageRank recomputation on each tool call.
 *
 * Replaces the `repomap-mcp` createServer() with our DB-backed implementation.
 */
class CodeGraphMcpService {
  private servers = new Map<string, McpServerConfig>()

  /**
   * Get or create an MCP server config for the given workspace.
   * Exposes `graph_map` and `search_identifiers` tools backed by SQLite.
   */
  getMcpServersConfig(workspaceId: string, workspacePath: string): Record<string, McpServerConfig> {
    let config = this.servers.get(workspaceId)
    if (config) {
      return { 'code-graph': config }
    }

    config = createSdkMcpServer({
      name: MCP_TOOLS.CODE_GRAPH._SERVER,
      version: '1.0.0',
      tools: [
        {
          name: MCP_TOOLS.CODE_GRAPH.GRAPH_MAP.tool,
          description:
            'Generate a ranked repository map of code definitions ' +
            'via PageRank over cross-file reference graphs. ' +
            'Useful for understanding codebase structure, discovering entry points, ' +
            'or finding code related to specific files or identifiers.',
          inputSchema: {
            projectRoot: z.string().describe('Absolute path to the repository root'),
            focusFiles: z
              .array(z.string())
              .optional()
              .describe('Already-known files used as ranking anchor (x20 boost)'),
            tokenLimit: z
              .number()
              .optional()
              .default(8192)
              .describe('Maximum token count for the output map'),
            excludeUnranked: z.boolean().optional().default(false),
            priorityFiles: z.array(z.string()).optional(),
            priorityIdentifiers: z.array(z.string()).optional()
          },
          handler: async (args) => {
            log.info(`[CodeGraph] MCP graph_map query (workspace: ${workspaceId})`)
            const result = await codeGraphService.getRepoMap(workspaceId, workspacePath, {
              focusFiles: args.focusFiles as string[] | undefined,
              mapTokens: args.tokenLimit as number | undefined,
              excludeUnranked: args.excludeUnranked as boolean | undefined,
              priorityFiles: args.priorityFiles as string[] | undefined,
              priorityIdentifiers: args.priorityIdentifiers as string[] | undefined
            })
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }]
            }
          }
        },
        {
          name: MCP_TOOLS.CODE_GRAPH.SEARCH_IDENTIFIERS.tool,
          description:
            'Search for code identifiers (functions, classes, variables) across the repository ' +
            'via Tree-sitter AST analysis. Returns matching definitions and references with code context.',
          inputSchema: {
            query: z
              .string()
              .describe('Identifier name to search for (case-insensitive substring match)'),
            maxResults: z.number().optional().default(50),
            includeDefinitions: z.boolean().optional().default(true),
            includeReferences: z.boolean().optional().default(true)
          },
          handler: async (args) => {
            const query = args.query as string
            log.info(`[CodeGraph] MCP search_identifiers: "${query}" (workspace: ${workspaceId})`)
            const results = await codeGraphService.searchIdentifiers(
              workspaceId,
              workspacePath,
              query,
              {
                maxResults: args.maxResults as number | undefined,
                includeDefinitions: args.includeDefinitions as boolean | undefined,
                includeReferences: args.includeReferences as boolean | undefined
              }
            )
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ results }, null, 2) }]
            }
          }
        },
        {
          name: MCP_TOOLS.CODE_GRAPH.FIND_DEAD_CODE.tool,
          description:
            'Find potentially unused code definitions (functions, classes, variables) ' +
            'that have no cross-file references in the codebase. ' +
            'Useful for cleanup, identifying orphaned symbols, or finding dead code after refactoring. ' +
            'Scope results with pathPrefix for targeted analysis.',
          inputSchema: {
            pathPrefix: z
              .string()
              .optional()
              .describe(
                'Filter results to files under this path prefix (e.g. "src/main/services")'
              ),
            maxResults: z
              .number()
              .optional()
              .default(50)
              .describe('Maximum number of dead code entries to return')
          },
          handler: async (args) => {
            log.info(
              `[CodeGraph] MCP find_dead_code (workspace: ${workspaceId}, prefix: ${args.pathPrefix ?? 'all'})`
            )
            const results = await codeGraphService.findDeadCode(workspaceId, workspacePath, {
              pathPrefix: args.pathPrefix as string | undefined,
              maxResults: args.maxResults as number | undefined
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
        },
        // ── Phase 2: Navigation Tools ──
        {
          name: MCP_TOOLS.CODE_GRAPH.FILE_OUTLINE.tool,
          description:
            'List all code definitions in a file (functions, classes, variables) with line numbers. ' +
            'Gives a structural overview without reading the full file content.',
          inputSchema: {
            filePath: z
              .string()
              .describe('Relative file path within the workspace (e.g. "src/main/index.ts")')
          },
          handler: async (args) => {
            const filePath = args.filePath as string
            log.info(`[CodeGraph] MCP file_outline: "${filePath}" (workspace: ${workspaceId})`)
            const tags = codeGraphTagRepository
              .findByFile(workspaceId, filePath)
              .filter((t) => t.kind === 'def')
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    {
                      file: filePath,
                      definitions: tags.map((t) => ({
                        name: t.name,
                        line: t.line
                      })),
                      count: tags.length
                    },
                    null,
                    2
                  )
                }
              ]
            }
          }
        },
        {
          name: MCP_TOOLS.CODE_GRAPH.FIND_CALLERS.tool,
          description:
            'Find all call-sites and references to a symbol — who calls/imports/references it. ' +
            'Useful for impact analysis and validating whether code is truly dead.',
          inputSchema: {
            symbolName: z.string().describe('Symbol name to find callers of'),
            maxResults: z.number().optional().default(50)
          },
          handler: async (args) => {
            const symbolName = args.symbolName as string
            const maxResults = args.maxResults as number
            log.info(`[CodeGraph] MCP find_callers: "${symbolName}" (workspace: ${workspaceId})`)
            const edges = codeGraphEdgeRepository
              .findCallersOf(workspaceId, symbolName)
              .slice(0, maxResults)
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    {
                      symbol: symbolName,
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
        },
        {
          name: MCP_TOOLS.CODE_GRAPH.FIND_CALLEES.tool,
          description:
            'Find what a symbol depends on — what does it call, import, or reference. ' +
            'Useful for dependency chain analysis and identifying tightly coupled components.',
          inputSchema: {
            symbolName: z.string().describe('Symbol name to find callees of'),
            maxResults: z.number().optional().default(50)
          },
          handler: async (args) => {
            const symbolName = args.symbolName as string
            const maxResults = args.maxResults as number
            log.info(`[CodeGraph] MCP find_callees: "${symbolName}" (workspace: ${workspaceId})`)
            const edges = codeGraphEdgeRepository
              .findCalleesOf(workspaceId, symbolName)
              .slice(0, maxResults)
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    {
                      symbol: symbolName,
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
        },
        {
          name: MCP_TOOLS.CODE_GRAPH.FIND_REFERENCES.tool,
          description:
            'Find all cross-file reference sites for a symbol (excluding definitions). ' +
            'Useful for usage analysis and understanding adoption of patterns.',
          inputSchema: {
            symbolName: z.string().describe('Symbol name to find references for'),
            maxResults: z.number().optional().default(50)
          },
          handler: async (args) => {
            const symbolName = args.symbolName as string
            const maxResults = args.maxResults as number
            log.info(`[CodeGraph] MCP find_references: "${symbolName}" (workspace: ${workspaceId})`)
            const refs = codeGraphTagRepository.searchByName(workspaceId, symbolName, {
              maxResults,
              includeDefinitions: false,
              includeReferences: true
            })
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    {
                      symbol: symbolName,
                      references: refs.map((r) => ({
                        file: r.relFname,
                        line: r.line,
                        name: r.name
                      })),
                      count: refs.length
                    },
                    null,
                    2
                  )
                }
              ]
            }
          }
        },
        {
          name: MCP_TOOLS.CODE_GRAPH.FILE_DEPENDENCIES.tool,
          description:
            'Find files that a given file depends on (imports, calls, references), grouped by edge type. ' +
            'Useful for architecture auditing and understanding module boundaries.',
          inputSchema: {
            filePath: z
              .string()
              .describe('Relative file path to analyze dependencies for')
          },
          handler: async (args) => {
            const filePath = args.filePath as string
            log.info(
              `[CodeGraph] MCP file_dependencies: "${filePath}" (workspace: ${workspaceId})`
            )
            const deps = codeGraphEdgeRepository.findDependenciesOf(workspaceId, filePath)
            // Group by edge type
            const grouped: Record<string, string[]> = {}
            for (const d of deps) {
              ;(grouped[d.edgeType] ??= []).push(d.targetFile)
            }
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    {
                      file: filePath,
                      dependencies: grouped,
                      totalCount: deps.length
                    },
                    null,
                    2
                  )
                }
              ]
            }
          }
        },
        {
          name: MCP_TOOLS.CODE_GRAPH.FILE_DEPENDENTS.tool,
          description:
            'Find files that depend on a given file (blast radius) — who imports or references it. ' +
            'Useful for change impact analysis — "if I modify this file, what breaks?"',
          inputSchema: {
            filePath: z
              .string()
              .describe('Relative file path to find dependents of')
          },
          handler: async (args) => {
            const filePath = args.filePath as string
            log.info(
              `[CodeGraph] MCP file_dependents: "${filePath}" (workspace: ${workspaceId})`
            )
            const deps = codeGraphEdgeRepository.findDependentsOf(workspaceId, filePath)
            // Group by edge type
            const grouped: Record<string, string[]> = {}
            for (const d of deps) {
              ;(grouped[d.edgeType] ??= []).push(d.sourceFile)
            }
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    {
                      file: filePath,
                      dependents: grouped,
                      totalCount: deps.length
                    },
                    null,
                    2
                  )
                }
              ]
            }
          }
        },
        // ── Phase 3: Analysis Tools ──
        {
          name: MCP_TOOLS.CODE_GRAPH.SYMBOL_HOTSPOTS.tool,
          description:
            'Find the most-referenced symbols in the codebase — the "load-bearing" abstractions. ' +
            'High reference counts indicate high-risk change points and core APIs.',
          inputSchema: {
            maxResults: z.number().optional().default(30),
            pathPrefix: z
              .string()
              .optional()
              .describe('Filter to symbols referenced in files under this path prefix')
          },
          handler: async (args) => {
            const maxResults = args.maxResults as number
            const pathPrefix = args.pathPrefix as string | undefined
            log.info(
              `[CodeGraph] MCP symbol_hotspots (workspace: ${workspaceId}, prefix: ${pathPrefix ?? 'all'})`
            )
            const hotspots = codeGraphTagRepository.findSymbolHotspots(workspaceId, {
              maxResults,
              pathPrefix
            })
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ hotspots, count: hotspots.length }, null, 2)
                }
              ]
            }
          }
        },
        {
          name: MCP_TOOLS.CODE_GRAPH.COUPLING_ANALYSIS.tool,
          description:
            'Find tightly coupled file pairs ranked by number of cross-references. ' +
            'Identifies candidates for refactoring and module boundary violations.',
          inputSchema: {
            minCoupling: z
              .number()
              .optional()
              .default(2)
              .describe('Minimum edge count between file pairs to include'),
            pathPrefix: z.string().optional().describe('Filter to files under this path prefix'),
            maxResults: z.number().optional().default(50)
          },
          handler: async (args) => {
            log.info(
              `[CodeGraph] MCP coupling_analysis (workspace: ${workspaceId}, prefix: ${(args.pathPrefix as string | undefined) ?? 'all'})`
            )
            const coupled = codeGraphEdgeRepository.findCoupledFiles(workspaceId, {
              minCoupling: args.minCoupling as number,
              pathPrefix: args.pathPrefix as string | undefined,
              maxResults: args.maxResults as number
            })
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ couples: coupled, count: coupled.length }, null, 2)
                }
              ]
            }
          }
        },
        {
          name: MCP_TOOLS.CODE_GRAPH.CIRCULAR_DEPENDENCIES.tool,
          description:
            'Detect circular file-level dependencies in the codebase. ' +
            'Circular deps are a top architecture smell — breaks clean layering.',
          inputSchema: {
            pathPrefix: z.string().optional().describe('Limit detection to files under this prefix')
          },
          handler: async (args) => {
            const pathPrefix = args.pathPrefix as string | undefined
            log.info(
              `[CodeGraph] MCP circular_dependencies (workspace: ${workspaceId}, prefix: ${pathPrefix ?? 'all'})`
            )
            const cycles = codeGraphService.findCircularDependencies(workspaceId, {
              pathPrefix
            })
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ cycles, count: cycles.length }, null, 2)
                }
              ]
            }
          }
        },
        {
          name: MCP_TOOLS.CODE_GRAPH.MODULE_BOUNDARY_HEALTH.tool,
          description:
            'Quantify separation of concerns by measuring intra-module vs cross-module edges. ' +
            'Low cohesion ratio indicates poor encapsulation and scattered responsibilities.',
          inputSchema: {
            depth: z
              .number()
              .optional()
              .default(2)
              .describe(
                'Directory depth for module boundaries (default 2 — e.g. "src/main", "src/renderer")'
              )
          },
          handler: async (args) => {
            const depth = args.depth as number
            log.info(`[CodeGraph] MCP module_boundary_health (workspace: ${workspaceId}, depth: ${depth})`)
            const metrics = codeGraphEdgeRepository.getModuleBoundaryMetrics(workspaceId, depth)
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ modules: metrics, count: metrics.length }, null, 2)
                }
              ]
            }
          }
        }
      ]
    })

    this.servers.set(workspaceId, config)
    return { 'code-graph': config }
  }

  dispose(workspaceId: string): void {
    this.servers.delete(workspaceId)
  }
}

export const codeGraphMcpService = new CodeGraphMcpService()
