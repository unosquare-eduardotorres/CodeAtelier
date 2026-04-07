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
            query: z.string().describe('Natural language search query (e.g. "JWT token validation")'),
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
            const { query, language, directory, nResults } = args
            log.info(
              `[SemanticSearch] MCP query: "${query}" (workspace: ${workspaceId})`
            )

            const where: Record<string, unknown> = {}
            if (language) where.language = language
            if (directory) where.directory = directory

            const results = await vectorSearchService.search(workspaceId, query, {
              nResults: Math.min(nResults ?? 5, 20),
              where: Object.keys(where).length > 0 ? where : undefined
            })

            log.info(
              `[SemanticSearch] Returned ${results.length} results for "${query}"`
            )

            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(results, null, 2)
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
