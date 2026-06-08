#!/usr/bin/env node
/**
 * Control Actions MCP Server — externalized for CLI interactive mode.
 *
 * Exposes three tools: emit_plan, ask_user, emit_memory.
 * Communicates events back to the Electron main process via a Unix domain
 * socket (IPC bridge). The main process creates the socket server before
 * spawning the Claude CLI; this server connects to it on startup.
 *
 * Environment variables:
 *   IPC_SOCKET_PATH  — Path to the Unix domain socket for event bridge
 *   WORKSPACE_PATH   — Current workspace path
 *   CONVERSATION_ID  — Active conversation ID (optional)
 *   CONVERSATION_MODE — 'plan' | 'build' | 'danger'
 *
 * This file is bundled as a standalone script and spawned by the CLI via
 * the MCP config's stdio declaration.
 *
 * Uses @modelcontextprotocol/sdk (the standard MCP SDK, NOT the Agent SDK).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createConnection, type Socket } from 'node:net'
import { createAskUserRegistry } from './ask-user-registry'

// ── Environment ──
const IPC_SOCKET_PATH = process.env.IPC_SOCKET_PATH
const WORKSPACE_PATH = process.env.WORKSPACE_PATH ?? process.cwd()
// CONVERSATION_ID reserved for future per-conversation routing
void process.env.CONVERSATION_ID
const CONVERSATION_MODE = process.env.CONVERSATION_MODE ?? 'plan'

// ── IPC Bridge ──
let ipcSocket: Socket | null = null

function connectIpc(): void {
  if (!IPC_SOCKET_PATH) {
    console.error(
      '[control-actions-server] WARNING: No IPC_SOCKET_PATH — events will be logged only'
    )
    return
  }

  try {
    ipcSocket = createConnection(IPC_SOCKET_PATH)
    ipcSocket.on('error', (err) => {
      console.error(`[control-actions-server] IPC socket error: ${err.message}`)
      ipcSocket = null
      // The bridge is gone — no response can ever arrive. Resolve any blocked
      // ask_user promises so the turn unwinds cleanly instead of hanging forever.
      askUserRegistry.resolveAll(SOCKET_CLOSED_MESSAGE)
    })
    ipcSocket.on('close', () => {
      ipcSocket = null
      // Same teardown on a clean close (e.g. Stop killed the CLI + this child).
      askUserRegistry.resolveAll(SOCKET_CLOSED_MESSAGE)
    })
  } catch (err) {
    console.error(`[control-actions-server] Failed to connect to IPC: ${(err as Error).message}`)
  }
}

/**
 * Send an event to the Electron main process via the IPC bridge.
 * Falls back to stderr logging when the socket is unavailable.
 */
function emitEvent(type: string, payload: unknown, requestId?: string): void {
  const event = JSON.stringify({ type, payload, requestId, timestamp: Date.now() })

  if (ipcSocket && !ipcSocket.destroyed) {
    ipcSocket.write(event + '\n')
  } else {
    console.error(`[control-actions-server] IPC unavailable — event lost: ${type}`)
  }
}

/**
 * Registry of in-flight ask_user requests awaiting a user response.
 * A socket close/error resolves every pending request via resolveAll().
 */
const askUserRegistry = createAskUserRegistry()

const SOCKET_CLOSED_MESSAGE =
  'Connection to the app closed before you answered — ask again or proceed.'

/**
 * Listen for responses from the Electron main process on the IPC socket.
 * Processes `askUserResponse` events and resolves pending ask_user promises.
 */
function setupResponseListener(): void {
  if (!ipcSocket) return

  let buffer = ''
  ipcSocket.on('data', (data: Buffer) => {
    buffer += data.toString('utf-8')

    let newlineIdx: number
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim()
      buffer = buffer.slice(newlineIdx + 1)
      if (!line) continue

      try {
        const event = JSON.parse(line)
        if (event.type === 'askUserResponse' && event.requestId) {
          askUserRegistry.resolve(event.requestId, event.payload?.response ?? 'User acknowledged')
        }
      } catch {
        console.error(`[control-actions-server] Malformed response: ${line.slice(0, 120)}`)
      }
    }
  })
}

/**
 * Send an ask_user event and wait for the user's response.
 *
 * Resolves ONLY when a real `askUserResponse` arrives, or when the IPC socket
 * tears down (close/error → registry.resolveAll). There is no auto-timeout: the
 * turn waits as long as the user needs to answer. Stopping the turn kills the
 * CLI and this child process, which closes the socket and unwinds the promise.
 */
function askUserAndWaitForResponse(requestId: string, payload: unknown): Promise<string> {
  return new Promise<string>((resolve) => {
    // Register the pending request
    askUserRegistry.register(requestId, resolve)

    // Send the event to Electron
    emitEvent('askUser', payload, requestId)
  })
}

// ── Zod Schemas (same as control-actions.tool.ts) ──

const planSchema = z.object({
  type: z
    .enum(['bug', 'feature', 'refactor', 'audit', 'investigation'])
    .optional()
    .describe('Plan classification'),
  title: z.string().describe('Short title for the plan'),
  summary: z.string().describe('1-3 sentence overview'),
  problemSummary: z.string().optional(),
  rootCause: z.string().optional(),
  decisions: z.array(z.object({ what: z.string(), why: z.string() })).optional(),
  rootCauses: z
    .array(
      z.object({
        id: z.number(),
        title: z.string(),
        description: z.string(),
        symptom: z.string().optional()
      })
    )
    .optional(),
  verification: z.array(z.string()).optional(),
  phases: z
    .array(
      z.object({
        id: z.number(),
        title: z.string(),
        complexity: z.number().min(1).max(10),
        fileCount: z.number().optional(),
        risk: z.enum(['low', 'medium', 'high']),
        description: z.string(),
        files: z.array(z.object({ file: z.string(), change: z.string() })).optional()
      })
    )
    .optional(),
  currentState: z.string().optional(),
  implementationOrder: z.array(z.number()).optional(),
  sections: z
    .array(
      z.object({
        heading: z.string(),
        icon: z.string().optional(),
        content: z.string(),
        mermaid: z.string().optional()
      })
    )
    .optional(),
  steps: z
    .array(
      z.object({
        description: z.string(),
        file: z.string().optional(),
        change: z.string().optional()
      })
    )
    .optional(),
  files: z.array(z.string()).optional(),
  filesChanged: z.array(z.object({ file: z.string(), change: z.string() })).optional(),
  risks: z
    .array(
      z.object({
        risk: z.string(),
        severity: z.enum(['low', 'medium', 'high', 'critical']),
        mitigation: z.string().optional()
      })
    )
    .optional(),
  expectedOutcome: z.string().optional(),
  deferredItems: z.array(z.string()).optional(),
  diagrams: z.array(z.object({ title: z.string(), mermaid: z.string() })).optional()
})

const askUserSchema = z.object({
  questions: z.array(
    z.object({
      question: z.string(),
      header: z.string().optional(),
      options: z
        .array(z.object({ label: z.string(), description: z.string().optional() }))
        .optional()
    })
  ),
  action: z.string().optional()
})

const emitMemorySchema = z.object({
  type: z.enum(['user', 'feedback', 'project', 'reference']),
  title: z.string().min(1),
  content: z.string().min(1)
})

// ── MCP Server ──

const server = new McpServer(
  { name: 'control-actions', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

// emit_plan tool
server.tool(
  'emit_plan',
  'Emit a structured plan, proposal, or investigation findings. ' +
    'The UI renders this as an interactive card with Build Now / Refine buttons.',
  planSchema.shape,
  async (args) => {
    const plan = planSchema.parse(args)
    emitEvent('plan', plan)
    return {
      content: [{ type: 'text' as const, text: `Plan "${plan.title}" emitted successfully.` }]
    }
  }
)

// ask_user tool
server.tool(
  'ask_user',
  'Ask the user clarifying questions before proceeding. ' +
    'The UI renders these as an interactive question card. ' +
    'This tool waits for the user to respond before returning.',
  askUserSchema.shape,
  async (args) => {
    const { questions, action } = askUserSchema.parse(args)
    const requestId = crypto.randomUUID()
    const enrichedQuestions = questions.map((q) => ({
      ...q,
      id: crypto.randomUUID(),
      options: q.options ?? []
    }))

    // Send questions and wait for the user's response (blocks until they answer
    // or the IPC socket tears down; no auto-timeout)
    const userResponse = await askUserAndWaitForResponse(requestId, {
      questions: enrichedQuestions,
      action
    })

    return {
      content: [{ type: 'text' as const, text: `User response: ${userResponse}` }]
    }
  }
)

// emit_memory tool
server.tool(
  'emit_memory',
  'Persist a memory for future sessions.',
  emitMemorySchema.shape,
  async (args) => {
    const memory = emitMemorySchema.parse(args)
    emitEvent('memory', memory)
    return {
      content: [{ type: 'text' as const, text: `Memory saved: [${memory.type}] ${memory.title}` }]
    }
  }
)

// ── Bootstrap ──

async function main(): Promise<void> {
  connectIpc()
  setupResponseListener()

  console.error('[control-actions-server] Tools registered: emit_plan, ask_user, emit_memory')

  const transport = new StdioServerTransport()
  await server.connect(transport)

  console.error(
    `[control-actions-server] Started (workspace=${WORKSPACE_PATH}, mode=${CONVERSATION_MODE}, ipc=${IPC_SOCKET_PATH ? 'connected' : 'NONE'})`
  )
}

main().catch((err) => {
  console.error('[control-actions-server] Fatal:', err)
  process.exit(1)
})
