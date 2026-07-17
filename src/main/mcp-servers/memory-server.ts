#!/usr/bin/env node
/**
 * Memory MCP Server — knowledge-aware fact management for CLI interactive mode.
 *
 * Exposes three tools: memory_search, memory_record, memory_flag.
 * Communicates with the knowledge engine via direct service imports
 * (runs in the Electron main process context, not as a standalone child).
 *
 * Architecture:
 *   Tool schemas are registered synchronously (cheap — zod + handler refs),
 *   then transport is connected immediately so the MCP handshake completes fast.
 *   Heavy service imports are deferred to a memoized ensureReady() called on
 *   first tool invocation, with a background warm-up kicked off after connect.
 *
 * Environment variables:
 *   WORKSPACE_ID — Workspace UUID for scoped fact queries
 *   DB_PATH      — Electron userData dir (for standalone node execution)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { truncateToolOutput } from './output-cap'

const WORKSPACE_ID = process.env.WORKSPACE_ID ?? ''

const server = new McpServer(
  { name: 'memory', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

// ── Lazy service initialization ─────────────────────────────────────────

type Services = {
  memoryRetrievalService: typeof import('../services/memory-retrieval.service').memoryRetrievalService
  memoryEngineService: typeof import('../services/memory-engine.service').memoryEngineService
  memoryFactRepository: typeof import('../db/repositories/memory-fact.repository').memoryFactRepository
}

let readyPromise: Promise<Services> | null = null

/** Memoized lazy init — safe to call from every handler; only loads once. */
function ensureReady(): Promise<Services> {
  if (!readyPromise) {
    readyPromise = (async (): Promise<Services> => {
      const { memoryRetrievalService } = await import('../services/memory-retrieval.service')
      const { memoryEngineService } = await import('../services/memory-engine.service')
      const { memoryFactRepository } = await import('../db/repositories/memory-fact.repository')
      console.error('[memory-server] Services initialized')
      return { memoryRetrievalService, memoryEngineService, memoryFactRepository }
    })()
  }
  return readyPromise
}

// ── Tool schema registration (synchronous — no heavy imports) ───────────

function registerToolSchemas(): void {
  // ── memory_search ─────────────────────────────────────────────────────
  server.tool(
    'memory_search',
    'Search the workspace knowledge base for relevant facts. Use before making assumptions about project conventions, architecture decisions, or known gotchas.',
    {
      query: z.string().describe('Natural language search query — what you want to know'),
      category: z
        .enum(['decision', 'convention', 'gotcha', 'preference', 'reference'])
        .optional()
        .describe('Filter by fact category'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .default(5)
        .describe('Number of results to return')
    },
    async (args) => {
      const { memoryRetrievalService } = await ensureReady()
      const results = await memoryRetrievalService.retrieve(
        WORKSPACE_ID,
        args.query,
        args.limit,
        args.category
      )
      const formatted = memoryRetrievalService.formatForToolResponse(results)
      return {
        content: [
          {
            type: 'text' as const,
            text: truncateToolOutput(formatted, 12_000)
          }
        ]
      }
    }
  )

  // ── memory_record ─────────────────────────────────────────────────────
  server.tool(
    'memory_record',
    'Record a new fact to the workspace knowledge base. Use when you discover or establish: architecture decisions, coding conventions, known gotchas, user preferences, or reference information. Also use when the user explicitly asks to save/remember something.',
    {
      category: z
        .enum(['decision', 'convention', 'gotcha', 'preference', 'reference'])
        .describe(
          'Fact category: decision (architecture choices), convention (coding rules), ' +
            'gotcha (surprising behaviors), preference (user prefs), reference (docs/links)'
        ),
      title: z.string().min(1).max(200).describe('Short descriptive title (5-15 words)'),
      content: z
        .string()
        .min(1)
        .max(2000)
        .describe('The fact — precise, actionable, self-contained (1-3 sentences)'),
      scopePaths: z
        .array(z.string())
        .optional()
        .describe('File/directory paths this fact relates to'),
      global: z
        .boolean()
        .optional()
        .default(false)
        .describe('If true, fact is cross-workspace (for user preferences/corrections)')
    },
    async (args) => {
      const { memoryEngineService } = await ensureReady()
      const fact = await memoryEngineService.writeFact({
        workspaceId: args.global ? null : WORKSPACE_ID || null,
        category: args.category,
        title: args.title,
        content: args.content,
        scopePaths: args.scopePaths,
        sourceType: 'tool',
        sourceRef: null
      })
      if (!fact) {
        return {
          content: [{ type: 'text' as const, text: 'Fact deduplicated or capped — no new record created.' }]
        }
      }
      const tierLabel = ['Observed', 'Confirmed', 'Established', 'Wisdom'][fact.tier]
      return {
        content: [
          {
            type: 'text' as const,
            text: `Fact recorded: [${fact.category}] "${fact.title}" (tier: ${tierLabel}, id: ${fact.id})`
          }
        ]
      }
    }
  )

  // ── memory_flag ───────────────────────────────────────────────────────
  server.tool(
    'memory_flag',
    'Flag an existing fact: confirm it (increases confidence) or mark it as contradicted (supersedes it). Use when you encounter evidence that supports or contradicts a known fact.',
    {
      factId: z.string().describe('The ID of the fact to flag'),
      intent: z
        .enum(['confirm', 'contradict'])
        .describe('confirm = evidence supports this fact; contradict = evidence disagrees'),
      note: z
        .string()
        .optional()
        .describe('Explanation of why you are confirming or contradicting this fact')
    },
    async (args) => {
      const { memoryEngineService, memoryFactRepository } = await ensureReady()
      const existing = memoryFactRepository.findById(args.factId) as
        | import('../../shared/types').MemoryFact
        | undefined
      if (!existing) {
        return {
          content: [{ type: 'text' as const, text: `Fact not found: ${args.factId}` }]
        }
      }

      if (args.intent === 'confirm') {
        const confirmed = memoryEngineService.confirmFactWithPromotion(args.factId, 'tool')
        const tierLabel = ['Observed', 'Confirmed', 'Established', 'Wisdom'][confirmed.tier]
        return {
          content: [
            {
              type: 'text' as const,
              text: `Fact confirmed: "${confirmed.title}" (count: ${confirmed.confirmationCount}, tier: ${tierLabel})`
            }
          ]
        }
      }

      // Contradict — create a new superseding fact with the note as content
      if (args.note) {
        const newFact = await memoryEngineService.writeFact({
          workspaceId: existing.workspaceId,
          category: existing.category,
          title: `[Updated] ${existing.title}`,
          content: args.note,
          scopePaths: existing.scopePaths,
          sourceType: 'tool',
          sourceRef: null
        })
        if (!newFact) {
          return { content: [{ type: 'text' as const, text: 'Contradiction note deduplicated — no change made.' }] }
        }
        memoryFactRepository.supersedeFact(existing.id, newFact.id)
        memoryFactRepository.createContradiction({
          oldFactId: existing.id,
          newFactId: newFact.id,
          status: 'auto_resolved',
          resolution: args.note
        })
        return {
          content: [
            {
              type: 'text' as const,
              text: `Fact "${existing.title}" superseded by "${newFact.title}" (id: ${newFact.id})`
            }
          ]
        }
      }

      // Just archive the old fact without a replacement
      memoryFactRepository.archiveFact(existing.id)
      return {
        content: [
          {
            type: 'text' as const,
            text: `Fact archived: "${existing.title}" (id: ${existing.id})`
          }
        ]
      }
    }
  )
}

async function main(): Promise<void> {
  registerToolSchemas()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`[memory-server] Started (workspace=${WORKSPACE_ID})`)
  // Warm up services in the background — non-blocking
  void ensureReady().catch((err) =>
    console.error('[memory-server] Background warm-up failed:', err)
  )
}

main().catch((err) => {
  console.error('[memory-server] Fatal:', err)
  process.exit(1)
})
