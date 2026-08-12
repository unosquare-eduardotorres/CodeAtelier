#!/usr/bin/env node
/**
 * Semantic Search MCP Server — externalized for CLI interactive mode.
 *
 * Exposes: semantic_search, similar_code, codebase_concepts
 *
 * Architecture:
 *   Tool schemas are registered synchronously (cheap — zod only),
 *   then transport is connected immediately so the MCP handshake completes fast.
 *   Heavy work (vector-search service import + index hydration) is deferred to
 *   a memoized ensureReady() called on first tool invocation, with a background
 *   warm-up kicked off after connect.
 *
 * Environment variables:
 *   WORKSPACE_ID — Workspace UUID for vector index queries
 *   DB_PATH      — Electron userData dir (this runs as plain node, no app.getPath())
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { truncateToolOutput } from './output-cap'
import { withErrorBoundary } from './tool-error-handler'

const WORKSPACE_ID = process.env.WORKSPACE_ID ?? ''
if (!WORKSPACE_ID) {
  console.error('[semantic-search-server] ERROR: WORKSPACE_ID is required')
  process.exit(1)
}

const server = new McpServer(
  { name: 'semantic-search', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

// ── Lazy service initialization ─────────────────────────────────────────

type VectorService = typeof import('../services/vector-search.service').vectorSearchService

let readyPromise: Promise<VectorService> | null = null
let retryCount = 0
const MAX_RETRIES = 3

/** Memoized lazy init — imports service + hydrates vector index. */
function ensureReady(): Promise<VectorService> {
  if (!readyPromise) {
    readyPromise = (async (): Promise<VectorService> => {
      // Pre-flight: verify native module compatibility before importing DB-backed services
      const { checkNativeModuleCompat } = await import('./native-module-check')
      const compat = checkNativeModuleCompat()
      if (!compat.ok) {
        throw new Error(compat.error ?? 'Native module check failed')
      }
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

      console.error('[semantic-search-server] Services initialized')
      return vectorSearchService
    })()

    // Clear cached promise on rejection so next call can retry
    readyPromise.catch((err) => {
      if (retryCount < MAX_RETRIES) {
        retryCount++
        console.error(
          `[semantic-search-server] Init failed (attempt ${retryCount}/${MAX_RETRIES}), will retry on next call:`,
          err
        )
        readyPromise = null // Allow next invocation to retry
      } else {
        console.error(
          `[semantic-search-server] Init failed after ${MAX_RETRIES} retries — giving up:`,
          err
        )
      }
    })
  }
  return readyPromise
}

/**
 * Wrap a payload for return, substituting a self-describing hint when the result
 * set is empty *because the workspace was never indexed*. Without this the model
 * cannot tell "not indexed" from "no matches" and retries the tool for nothing.
 */
function emptyAwarePayload(
  vectorSearchService: VectorService,
  isEmpty: boolean,
  payload: Record<string, unknown>
): { content: { type: 'text'; text: string }[] } {
  let body = payload
  if (isEmpty) {
    let indexed = true
    try {
      indexed = vectorSearchService.hasPersistedIndex(WORKSPACE_ID)
    } catch {
      /* treat as indexed — a probe failure must not fabricate a "not indexed" claim */
    }
    if (!indexed) {
      body = {
        ...payload,
        indexed: false,
        hint: 'This workspace has no embedding index — semantic search cannot answer. Use Grep/Glob instead, and do not retry this tool.'
      }
    }
  }
  return {
    content: [{ type: 'text' as const, text: truncateToolOutput(JSON.stringify(body), 15_000) }]
  }
}

// ── Tool schema registration (synchronous — no heavy imports) ───────────

function registerToolSchemas(): void {
  server.tool(
    'semantic_search',
    'Find code by MEANING when you cannot name the symbol — "how does auth work", ' +
      '"where is retry logic". Use code-graph search_identifiers when you know the name, ' +
      'Grep for exact strings. Returns indexed:false if the workspace has no index.',
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
    withErrorBoundary('semantic_search', async (args) => {
      const vectorSearchService = await ensureReady()
      // Build where clause from optional filters
      const where: Record<string, unknown> = {}
      if (args.language) where.language = args.language
      if (args.directory) where.directory = args.directory

      const results = await vectorSearchService.search(WORKSPACE_ID, args.query, {
        nResults: args.nResults,
        ...(Object.keys(where).length > 0 ? { where } : {})
      })
      // 6A-2: Cap semantic search at 15,000 chars (embedding results can be verbose)
      return emptyAwarePayload(vectorSearchService, results.length === 0, {
        results,
        count: results.length
      })
    })
  )

  server.tool(
    'similar_code',
    'Find duplicates or repeated patterns given a code snippet. Use for "is this already ' +
      'implemented somewhere" and refactor-scoping — not for locating a known symbol.',
    {
      code: z.string().describe('Code snippet to find similar patterns for'),
      nResults: z.number().int().min(1).max(100).optional().default(5)
    },
    withErrorBoundary('similar_code', async (args) => {
      const vectorSearchService = await ensureReady()
      const results = await vectorSearchService.searchByCode(WORKSPACE_ID, args.code, {
        nResults: args.nResults
      })
      return emptyAwarePayload(vectorSearchService, results.length === 0, {
        results,
        count: results.length
      })
    })
  )

  server.tool(
    'codebase_concepts',
    'Cluster the indexed codebase into high-level concepts. Orientation only, for unfamiliar ' +
      'repos — do not use to answer specific questions.',
    {
      maxConcepts: z.number().int().min(1).max(100).optional().default(20)
    },
    withErrorBoundary('codebase_concepts', async (args) => {
      const vectorSearchService = await ensureReady()
      const concepts = await vectorSearchService.getConceptClusters(WORKSPACE_ID, {
        maxClusters: args.maxConcepts
      })
      return emptyAwarePayload(vectorSearchService, concepts.length === 0, { concepts })
    })
  )
}

async function main(): Promise<void> {
  registerToolSchemas()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`[semantic-search-server] Started (workspace=${WORKSPACE_ID})`)
  // Warm up services + hydrate vector index in the background — non-blocking
  void ensureReady().catch((err) =>
    console.error('[semantic-search-server] Background warm-up failed:', err)
  )
}

main().catch((err) => {
  console.error('[semantic-search-server] Fatal:', err)
  process.exit(1)
})
