#!/usr/bin/env node
/**
 * Semantic Search MCP Server — externalized for CLI interactive mode.
 *
 * Exposes: semantic_search, similar_code, codebase_concepts
 *
 * Environment variables:
 *   WORKSPACE_ID — Workspace UUID for vector index queries
 *   DB_PATH      — Electron userData dir (this runs as plain node, no app.getPath())
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { truncateToolOutput } from './output-cap'

const WORKSPACE_ID = process.env.WORKSPACE_ID ?? ''
if (!WORKSPACE_ID) {
  console.error('[semantic-search-server] ERROR: WORKSPACE_ID is required')
  process.exit(1)
}

const server = new McpServer(
  { name: 'semantic-search', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

async function registerTools(): Promise<void> {
  const { vectorSearchService } = await import('../services/vector-search.service')

  // Hydrate the in-memory vector collection from SQLite. In the main process this
  // happens on workspace open, but this standalone server starts with a fresh, empty
  // singleton — without hydration, search/similar_code/codebase_concepts all return [].
  try {
    if (vectorSearchService.hasPersistedIndex(WORKSPACE_ID)) {
      const { symbolCount } = await vectorSearchService.loadPersistedIndex(WORKSPACE_ID)
      console.error(`[semantic-search-server] Hydrated ${symbolCount} vectors from DB`)
    } else {
      console.error(
        `[semantic-search-server] No persisted index for workspace ${WORKSPACE_ID} (not indexed)`
      )
    }
  } catch (err) {
    console.error('[semantic-search-server] Hydration failed:', err)
  }

  server.tool(
    'semantic_search',
    'Search the codebase using natural language queries. Returns relevant code chunks with file paths, symbol names, and relevance scores.',
    {
      query: z.string().describe('Natural language search query'),
      language: z.string().optional().describe('Filter by programming language'),
      directory: z.string().optional().describe('Filter by directory path prefix'),
      nResults: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(10)
        .describe('Number of results to return')
    },
    async (args) => {
      // Build where clause from optional filters
      const where: Record<string, unknown> = {}
      if (args.language) where.language = args.language
      if (args.directory) where.directory = args.directory

      const results = await vectorSearchService.search(WORKSPACE_ID, args.query, {
        nResults: args.nResults,
        ...(Object.keys(where).length > 0 ? { where } : {})
      })
      // 6A-2: Cap semantic search at 15,000 chars (embedding results can be verbose)
      return {
        content: [
          {
            type: 'text' as const,
            text: truncateToolOutput(
              JSON.stringify({ results, count: results.length }),
              15_000
            )
          }
        ]
      }
    }
  )

  server.tool(
    'similar_code',
    'Find code similar to a given code snippet or symbol.',
    {
      code: z.string().describe('Code snippet to find similar patterns for'),
      nResults: z.number().int().min(1).max(100).optional().default(5)
    },
    async (args) => {
      const results = await vectorSearchService.searchByCode(WORKSPACE_ID, args.code, {
        nResults: args.nResults
      })
      return {
        content: [
          {
            type: 'text' as const,
            text: truncateToolOutput(
              JSON.stringify({ results, count: results.length }),
              15_000
            )
          }
        ]
      }
    }
  )

  server.tool(
    'codebase_concepts',
    'Get a high-level overview of concepts and patterns in the codebase.',
    {
      maxConcepts: z.number().int().min(1).max(100).optional().default(20)
    },
    async (args) => {
      const concepts = await vectorSearchService.getConceptClusters(WORKSPACE_ID, {
        maxClusters: args.maxConcepts
      })
      return {
        content: [
          {
            type: 'text' as const,
            text: truncateToolOutput(JSON.stringify({ concepts }), 15_000)
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
  console.error(`[semantic-search-server] Started (workspace=${WORKSPACE_ID})`)
}

main().catch((err) => {
  console.error('[semantic-search-server] Fatal:', err)
  process.exit(1)
})
