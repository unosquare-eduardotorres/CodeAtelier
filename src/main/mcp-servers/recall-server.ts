#!/usr/bin/env node
/**
 * Recall MCP Server — agent access to past plans and the conversation around them.
 *
 * Exposes three tools: recall_plans, recall_plan, recall_conversation.
 *
 * Why it exists: an agent asked to "revisit that plan from last week" has no
 * way to reach it — history lives in SQLite, not in the session. Plans are
 * recorded in two places and neither is complete on its own:
 *   • the `plans` registry (rich metadata, but often empty — registration is
 *     best-effort and retention hard-deletes past 50 rows)
 *   • the message that rendered the plan card (always present, plain text)
 * recall_plans unions both and dedupes.
 *
 * Environment variables:
 *   WORKSPACE_ID — Workspace UUID for scoped queries
 *   DB_PATH      — Electron userData dir (for standalone node execution)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { truncateToolOutput } from './output-cap'
import { withErrorBoundary } from './tool-error-handler'
import {
  entryFromMessage,
  entryFromPlanRecord,
  formatConversationWindow,
  formatEntryList,
  formatPlanDetail,
  matchesQuery,
  mergePlanEntries,
  parseRecallRef,
  parseTs,
  sliceWindow,
  type RecallPlanEntry
} from './recall-helpers'

const WORKSPACE_ID = process.env.WORKSPACE_ID ?? ''

/** Upper bound on the message scan — the newest N plan-bearing messages. */
const MESSAGE_SCAN_LIMIT = 100
/** Hard cap on messages returned by recall_conversation. */
const MAX_WINDOW_MESSAGES = 25

const server = new McpServer({ name: 'recall', version: '1.0.0' }, { capabilities: { tools: {} } })

// ── Lazy service initialization ─────────────────────────────────────────

type Services = {
  planRepository: typeof import('../db/repositories/plan.repository').planRepository
  messageRepository: typeof import('../db/repositories/message.repository').messageRepository
  conversationRepository: typeof import('../db/repositories/conversation.repository').conversationRepository
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
      const { planRepository } = await import('../db/repositories/plan.repository')
      const { messageRepository } = await import('../db/repositories/message.repository')
      const { conversationRepository } = await import(
        '../db/repositories/conversation.repository'
      )
      console.error('[recall-server] Services initialized')
      return { planRepository, messageRepository, conversationRepository }
    })()

    // Clear cached promise on rejection so next call can retry
    readyPromise.catch((err) => {
      if (retryCount < MAX_RETRIES) {
        retryCount++
        console.error(
          `[recall-server] Init failed (attempt ${retryCount}/${MAX_RETRIES}), will retry on next call:`,
          err
        )
        readyPromise = null
      } else {
        console.error(`[recall-server] Init failed after ${MAX_RETRIES} retries — giving up:`, err)
      }
    })
  }
  return readyPromise
}

// ── Shared lookups ──────────────────────────────────────────────────────

/** Build the merged plan list for the workspace (registry ∪ messages). */
async function loadEntries(): Promise<RecallPlanEntry[]> {
  const { planRepository, messageRepository } = await ensureReady()

  const registryEntries = planRepository
    .getForWorkspace(WORKSPACE_ID)
    .map(entryFromPlanRecord)

  const messageEntries = messageRepository
    .findPlanBlockMessages(WORKSPACE_ID, MESSAGE_SCAN_LIMIT)
    .map(entryFromMessage)
    .filter((e): e is RecallPlanEntry => e !== null)

  return mergePlanEntries(registryEntries, messageEntries)
}

/** Resolve a ref to a single entry, honouring workspace scoping. */
async function resolveEntry(ref: string): Promise<RecallPlanEntry | null> {
  const parsed = parseRecallRef(ref)
  if (!parsed) return null
  const { planRepository, messageRepository, conversationRepository } = await ensureReady()

  if (parsed.kind === 'plan' || parsed.kind === 'auto') {
    const plan = planRepository.getById(parsed.id)
    if (plan && plan.workspaceId === WORKSPACE_ID) return entryFromPlanRecord(plan)
    if (parsed.kind === 'plan') return null
  }

  const message = messageRepository.findById(parsed.id)
  if (!message) return null
  const conversation = conversationRepository.findById(message.conversationId)
  if (!conversation || conversation.workspaceId !== WORKSPACE_ID) return null

  return entryFromMessage({
    id: message.id,
    conversationId: message.conversationId,
    conversationTitle: conversation.title,
    createdAt: message.createdAt,
    contentMd: message.contentMd
  })
}

// ── Tool schema registration (synchronous — no heavy imports) ───────────

function registerToolSchemas(): void {
  // ── recall_plans ──────────────────────────────────────────────────────
  server.tool(
    'recall_plans',
    'Search past plans in this workspace — including plans from earlier chats that are no longer in your context. Call this BEFORE telling the user a past plan cannot be recovered.',
    {
      query: z
        .string()
        .optional()
        .describe('Search term matched against plan title, summary and body. Omit to list all.'),
      source: z
        .enum(['chat', 'grill', 'audit', 'council', 'mpa', 'blueprint', 'message'])
        .optional()
        .describe('Filter by where the plan came from'),
      includeSuperseded: z
        .boolean()
        .optional()
        .default(true)
        .describe('Include older revisions that were superseded by a newer plan'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe('Maximum plans to return')
    },
    withErrorBoundary('recall_plans', async (args) => {
      const entries = (await loadEntries())
        .filter((e) => matchesQuery(e, args.query))
        .filter((e) => (args.source ? e.source === args.source : true))
        .filter((e) => (args.includeSuperseded === false ? !e.superseded : true))
        .slice(0, args.limit)

      return {
        content: [
          {
            type: 'text' as const,
            text: truncateToolOutput(formatEntryList(entries, args.query), 12_000)
          }
        ]
      }
    })
  )

  // ── recall_plan ───────────────────────────────────────────────────────
  server.tool(
    'recall_plan',
    'Retrieve one past plan in full, with its revision lineage. Takes a ref from recall_plans (plan:<id> or msg:<id>).',
    {
      ref: z.string().describe('Plan ref from recall_plans — "plan:<id>" or "msg:<id>"')
    },
    withErrorBoundary('recall_plan', async (args) => {
      const entry = await resolveEntry(args.ref)
      if (!entry) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No plan found for ref "${args.ref}" in this workspace. Run recall_plans first to get valid refs.`
            }
          ]
        }
      }

      // Revision lineage — registry rows only; message-derived plans have none.
      let lineage: { previous?: RecallPlanEntry | null; superseding?: RecallPlanEntry | null } = {}
      if (entry.ref.startsWith('plan:')) {
        const { planRepository } = await ensureReady()
        const planId = entry.ref.slice('plan:'.length)
        const previous = planRepository.getPreviousPlan(planId)
        const superseding = planRepository.getSupersedingPlan(planId)
        lineage = {
          previous: previous ? entryFromPlanRecord(previous) : null,
          superseding: superseding ? entryFromPlanRecord(superseding) : null
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: truncateToolOutput(formatPlanDetail(entry, lineage), 20_000)
          }
        ]
      }
    })
  )

  // ── recall_conversation ───────────────────────────────────────────────
  server.tool(
    'recall_conversation',
    'Read the conversation around a past plan — the discussion, root-cause reasoning and decisions that produced it. Takes a ref from recall_plans.',
    {
      ref: z.string().describe('Plan ref from recall_plans — "plan:<id>" or "msg:<id>"'),
      before: z
        .number()
        .int()
        .min(0)
        .max(20)
        .optional()
        .default(6)
        .describe('Messages to include before the plan'),
      after: z
        .number()
        .int()
        .min(0)
        .max(20)
        .optional()
        .default(6)
        .describe('Messages to include after the plan')
    },
    withErrorBoundary('recall_conversation', async (args) => {
      const entry = await resolveEntry(args.ref)
      if (!entry) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No plan found for ref "${args.ref}" in this workspace. Run recall_plans first to get valid refs.`
            }
          ]
        }
      }
      if (!entry.conversationId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Plan ${entry.ref} ("${entry.title}") is not linked to a chat conversation — it came from ${entry.source}, so there is no surrounding discussion to read.`
            }
          ]
        }
      }

      const { messageRepository, conversationRepository } = await ensureReady()
      const conversation = conversationRepository.findById(entry.conversationId)
      if (!conversation || conversation.workspaceId !== WORKSPACE_ID) {
        return {
          content: [
            { type: 'text' as const, text: `Conversation for ${entry.ref} is no longer available.` }
          ]
        }
      }

      const messages = messageRepository
        .findByConversation(entry.conversationId)
        .filter((m) => !m.hidden)

      // Anchor: the exact message for msg: refs, otherwise the message closest
      // in time to the plan's creation.
      const anchorId = entry.ref.startsWith('msg:') ? entry.ref.slice('msg:'.length) : null
      let anchorIndex = anchorId ? messages.findIndex((m) => m.id === anchorId) : -1
      if (anchorIndex < 0) {
        const target = parseTs(entry.createdAt)
        let bestDelta = Number.POSITIVE_INFINITY
        messages.forEach((msg, idx) => {
          const delta = Math.abs(parseTs(msg.createdAt) - target)
          if (delta < bestDelta) {
            bestDelta = delta
            anchorIndex = idx
          }
        })
      }
      if (anchorIndex < 0) anchorIndex = messages.length - 1

      // Clamp the requested window to the hard cap (anchor always included).
      let before = args.before
      let after = args.after
      while (before + after + 1 > MAX_WINDOW_MESSAGES) {
        if (after >= before) after--
        else before--
      }

      const { window } = sliceWindow(messages, anchorIndex, before, after)

      return {
        content: [
          {
            type: 'text' as const,
            text: truncateToolOutput(
              formatConversationWindow({
                conversationTitle: conversation.title,
                anchorRef: entry.ref,
                anchorId: messages[anchorIndex]?.id ?? null,
                messages: window.map((m) => ({
                  id: m.id,
                  role: m.role,
                  createdAt: m.createdAt,
                  contentMd: m.contentMd
                })),
                totalInConversation: messages.length
              }),
              20_000
            )
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
  console.error(`[recall-server] Started (workspace=${WORKSPACE_ID})`)
  // Warm up services in the background — non-blocking
  void ensureReady().catch((err) =>
    console.error('[recall-server] Background warm-up failed:', err)
  )
}

main().catch((err) => {
  console.error('[recall-server] Fatal:', err)
  process.exit(1)
})
