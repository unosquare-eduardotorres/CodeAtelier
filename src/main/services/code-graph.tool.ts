import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import log from 'electron-log/main'
import { MCP_TOOLS } from '../../shared/constants'
import { codeGraphService } from './code-graph.service'

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
