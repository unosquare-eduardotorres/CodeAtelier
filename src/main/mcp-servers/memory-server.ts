#!/usr/bin/env node
/**
 * Memory MCP Server — knowledge-aware fact management for CLI interactive mode.
 *
 * Exposes three tools: memory_search, memory_record, memory_flag.
 * Communicates with the knowledge engine via direct service imports.
 * Runs as a standalone child process (spawned as the app binary under
 * ELECTRON_RUN_AS_NODE=1), NOT inside the Electron main process — `electron`
 * and `electron-log` are stubbed by the build-time standalone shim, and DB_PATH
 * supplies the userData directory.
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
import { withErrorBoundary } from './tool-error-handler'

const WORKSPACE_ID = process.env.WORKSPACE_ID ?? ''

const server = new McpServer({ name: 'memory', version: '1.0.0' }, { capabilities: { tools: {} } })

// ── Lazy service initialization ─────────────────────────────────────────

type Services = {
  memoryRetrievalService: typeof import('../services/memory-retrieval.service').memoryRetrievalService
  memoryEngineService: typeof import('../services/memory-engine.service').memoryEngineService
  memoryFactRepository: typeof import('../db/repositories/memory-fact.repository').memoryFactRepository
}

let readyPromise: Promise<Services> | null = null
let retryCount = 0
const MAX_RETRIES = 3

/** Memoized lazy init — safe to call from every handler; only loads once. */
function ensureReady(): Promise<Services> {
  if (!readyPromise) {
    readyPromise = (async (): Promise<Services> => {
      // Pre-flight: verify native module compatibility before importing DB-backed services
      const { checkNativeModuleCompat } = await import('./native-module-check')
      const compat = checkNativeModuleCompat()
      if (!compat.ok) {
        throw new Error(compat.error ?? 'Native module check failed')
      }
      const { memoryRetrievalService } = await import('../services/memory-retrieval.service')
      const { memoryEngineService } = await import('../services/memory-engine.service')
      const { memoryFactRepository } = await import('../db/repositories/memory-fact.repository')
      console.error('[memory-server] Services initialized')
      return { memoryRetrievalService, memoryEngineService, memoryFactRepository }
    })()

    // Clear cached promise on rejection so next call can retry
    readyPromise.catch((err) => {
      if (retryCount < MAX_RETRIES) {
        retryCount++
        console.error(
          `[memory-server] Init failed (attempt ${retryCount}/${MAX_RETRIES}), will retry on next call:`,
          err
        )
        readyPromise = null // Allow next invocation to retry
      } else {
        console.error(`[memory-server] Init failed after ${MAX_RETRIES} retries — giving up:`, err)
      }
    })
  }
  return readyPromise
}

// ── Tool schema registration (synchronous — no heavy imports) ───────────

function registerToolSchemas(): void {
  // ── memory_search ─────────────────────────────────────────────────────
  server.tool(
    'memory_search',
    'Search the workspace knowledge base for relevant facts. Use before making assumptions about project conventions, architecture decisions, or known gotchas. Facts about the project, not past conversations — use recall_plans for those.',
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
        .describe('Number of results to return'),
      asOf: z
        .string()
        .optional()
        .describe(
          'ISO timestamp for a point-in-time view — returns what the project ' +
            'believed at that moment, including facts since superseded. Omit for current truth.'
        )
    },
    withErrorBoundary('memory_search', async (args) => {
      const { memoryRetrievalService } = await ensureReady()
      const results = await memoryRetrievalService.retrieve(
        WORKSPACE_ID,
        args.query,
        args.limit,
        args.category,
        [],
        args.asOf ? { asOf: args.asOf } : undefined
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
    })
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
        .max(4000)
        .describe('The fact — precise, actionable, self-contained (1-5 sentences)'),
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
    withErrorBoundary('memory_record', async (args) => {
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
          content: [
            { type: 'text' as const, text: 'Fact deduplicated or capped — no new record created.' }
          ]
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
    })
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
    withErrorBoundary('memory_flag', async (args) => {
      const { memoryEngineService, memoryFactRepository } = await ensureReady()
      const existing = memoryFactRepository.findById(args.factId) as
        import('../../shared/types').MemoryFact | undefined
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
          return {
            content: [
              { type: 'text' as const, text: 'Contradiction note deduplicated — no change made.' }
            ]
          }
        }
        // Guard: writeFact may UPDATE-match the replacement against the very fact
        // being contradicted and return it — don't self-supersede.
        if (newFact.id !== existing.id) {
          memoryFactRepository.supersedeFact(existing.id, newFact.id)
          memoryFactRepository.createContradiction({
            oldFactId: existing.id,
            newFactId: newFact.id,
            status: 'auto_resolved',
            resolution: args.note
          })
        }
        return {
          content: [
            {
              type: 'text' as const,
              text:
                newFact.id !== existing.id
                  ? `Fact "${existing.title}" superseded by "${newFact.title}" (id: ${newFact.id})`
                  : `Fact "${existing.title}" updated in place (id: ${existing.id})`
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
    })
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
