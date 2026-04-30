import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import log from 'electron-log/main'
import { MCP_TOOLS } from '../../shared/constants'
import { vectorSearchService } from './vector-search.service'

/**
 * Manages per-workspace MCP servers that expose a `semantic_search` tool
 * to the Claude Agent SDK. Uses the SDK's built-in `createSdkMcpServer`
 * helper so the tool is discoverable by agents.
 */
class SemanticSearchMcpService {
  private servers = new Map<string, McpServerConfig>()

  /**
   * Get or create an MCP server config for the given workspace.
   * The server exposes a `semantic_search` tool that queries the vector index.
   */
  getMcpServersConfig(workspaceId: string): Record<string, McpServerConfig> {
    let config = this.servers.get(workspaceId)
    if (config) {
      return { 'semantic-search': config }
    }

    config = createSdkMcpServer({
      name: MCP_TOOLS.SEMANTIC_SEARCH._SERVER,
      version: '1.0.0',
      tools: [
        {
          name: MCP_TOOLS.SEMANTIC_SEARCH.SEMANTIC_SEARCH.tool,
          description:
            'Search the codebase using natural language queries. Returns relevant code ' +
            'chunks with file paths, symbol names, code bodies, and relevance scores. ' +
            'Use this to find code related to a concept, pattern, or functionality.',
          inputSchema: {
            query: z
              .string()
              .describe('Natural language search query (e.g. "JWT token validation")'),
            language: z
              .string()
              .optional()
              .describe('Filter by programming language (e.g. "typescript", "csharp")'),
            directory: z
              .string()
              .optional()
              .describe('Filter by directory path prefix (e.g. "src/auth")'),
            nResults: z
              .number()
              .optional()
              .describe('Maximum number of results to return (default: 5, max: 20)')
          },
          handler: async (args) => {
            const { query, language, directory, nResults } = args as {
              query: string
              language?: string
              directory?: string
              nResults?: number
            }
            log.info(`[SemanticSearch] MCP query: "${query}" (workspace: ${workspaceId})`)

            const where: Record<string, unknown> = {}
            if (language) where.language = language
            if (directory) where.directory = directory

            const results = await vectorSearchService.search(workspaceId, query, {
              nResults: Math.min(nResults ?? 5, 20),
              where: Object.keys(where).length > 0 ? where : undefined
            })

            log.info(`[SemanticSearch] Returned ${results.length} results for "${query}"`)

            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(results, null, 2)
                }
              ]
            }
          }
        },
        // ── Phase 4: Expanded Semantic Tools ──
        {
          name: MCP_TOOLS.SEMANTIC_SEARCH.SIMILAR_CODE.tool,
          description:
            'Find code similar to a given snippet using vector embeddings. ' +
            'Useful for detecting duplicates, enforcing pattern consistency, and auditing copy-paste code.',
          inputSchema: {
            code: z.string().describe('Code snippet to find similar implementations for'),
            maxResults: z
              .number()
              .optional()
              .default(10)
              .describe('Maximum number of similar code results'),
            language: z
              .string()
              .optional()
              .describe('Filter by programming language (e.g. "typescript")')
          },
          handler: async (args) => {
            const code = args.code as string
            const maxResults = args.maxResults as number
            const language = args.language as string | undefined
            log.info(
              `[SemanticSearch] MCP similar_code (workspace: ${workspaceId}, lang: ${language ?? 'all'})`
            )
            const results = await vectorSearchService.searchByCode(workspaceId, code, {
              nResults: Math.min(maxResults, 20),
              language
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
        {
          name: MCP_TOOLS.SEMANTIC_SEARCH.CODEBASE_CONCEPTS.tool,
          description:
            'Cluster codebase embeddings into conceptual groupings. ' +
            'Shows how the codebase organizes around concepts, with representative files per cluster.',
          inputSchema: {
            maxClusters: z
              .number()
              .optional()
              .default(10)
              .describe('Maximum number of concept clusters to return')
          },
          handler: async (args) => {
            const maxClusters = args.maxClusters as number
            log.info(`[SemanticSearch] MCP codebase_concepts (workspace: ${workspaceId})`)
            const clusters = vectorSearchService.getConceptClusters(workspaceId, {
              maxClusters
            })
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ clusters, count: clusters.length }, null, 2)
                }
              ]
            }
          }
        }
      ]
    })

    this.servers.set(workspaceId, config)
    return { 'semantic-search': config }
  }

  dispose(workspaceId: string): void {
    this.servers.delete(workspaceId)
  }
}

export const semanticSearchMcpService = new SemanticSearchMcpService()
