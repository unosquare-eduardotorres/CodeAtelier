/**
 * E2E Stream Helper — extracted from E2ERunnerService so service runners can
 * reuse the same chat-stream pipeline for hybrid scenarios.
 *
 * The helper captures transcript entries via the chunk-tap registry and supports
 * auto-responders for ask_user and permission_request events.
 */

import type { E2ETranscriptEntry } from '../../../shared/types'
import { chatStreamService } from '../chat-stream.service'
import { chatAgentService } from '../chat-agent.service'
import { registerChunkTap, unregisterChunkTap } from '../../ipc/chat-shared'
import type { StreamChunk } from '../index'
import electronLog from 'electron-log/main'

const log = electronLog.scope('E2EStreamHelper')

const CHUNK_TAP_KEY = 'e2e-stream-helper'

// ── Filler Text Generator ──

/**
 * Generate filler text of approximately `chars` length with a SECRET_CODE needle at the end.
 * Used by the long-context scenario for needle-in-haystack testing.
 */
export function generateFillerWithNeedle(chars: number): string {
  const needle = '\n\nSECRET_CODE: NEEDLE-7X9Q\n\n'
  const paragraphs = [
    'The history of computing spans centuries of innovation and discovery. From the abacus to modern quantum processors, each era has brought new paradigms of computation and information processing. ',
    'Software engineering principles evolved from early structured programming through object-oriented design to modern functional and reactive paradigms. Design patterns emerged as reusable solutions. ',
    'Database systems progressed from hierarchical and network models to relational databases, then to NoSQL solutions including document stores, graph databases, and key-value stores. ',
    'Networking protocols form the backbone of modern communication. The OSI model, TCP/IP stack, HTTP, WebSockets, and gRPC each serve different use cases in distributed systems. ',
    'Cloud computing transformed infrastructure management. Virtualization, containerization with Docker, and orchestration with Kubernetes changed how applications are deployed and scaled. ',
    'Machine learning algorithms span supervised learning (classification, regression), unsupervised learning (clustering, dimensionality reduction), and reinforcement learning approaches. ',
    'Cryptographic systems protect data through symmetric encryption (AES, ChaCha20), asymmetric encryption (RSA, ECDSA), hash functions (SHA-256), and key exchange protocols (Diffie-Hellman). ',
    'Programming language theory encompasses type systems, lambda calculus, formal semantics, compiler design, garbage collection strategies, and memory management approaches. '
  ]

  const parts: string[] = []
  let totalLen = 0
  const targetLen = chars - needle.length
  let idx = 0

  while (totalLen < targetLen) {
    const para = paragraphs[idx % paragraphs.length]
    parts.push(para)
    totalLen += para.length
    idx++
  }

  return parts.join('') + needle
}

/**
 * Generate a no-whitespace filler string of approximately `chars` length.
 * Used by giant-single-line scenario to stress test single-line handling.
 * Contains repeating hex-like characters with a needle at the end.
 */
export function generateNoWhitespaceFiller(chars: number): string {
  const needle = 'SECRET_CODE:NEEDLE-7X9Q'
  const alphabet = 'abcdef0123456789ABCDEF'
  const targetLen = chars - needle.length
  const parts: string[] = []
  let totalLen = 0

  while (totalLen < targetLen) {
    const chunk = Array.from(
      { length: Math.min(200, targetLen - totalLen) },
      (_, i) => alphabet[(totalLen + i) % alphabet.length]
    ).join('')
    parts.push(chunk)
    totalLen += chunk.length
  }

  return parts.join('') + needle
}

// ── Chunk-to-Transcript Mapper ──

export function chunkToTranscriptEntry(chunk: StreamChunk): E2ETranscriptEntry | null {
  const now = Date.now()

  switch (chunk.type) {
    case 'text':
      return { role: 'assistant', type: 'text', content: chunk.content ?? '', timestamp: now }
    case 'thinking':
      return { role: 'assistant', type: 'thinking', content: chunk.content ?? '', timestamp: now }
    case 'tool_use': {
      let parsedArgs: Record<string, unknown> | undefined
      if (chunk.toolInput) {
        try {
          parsedArgs = JSON.parse(chunk.toolInput)
        } catch {
          /* ignore */
        }
      }
      return {
        role: 'assistant',
        type: 'tool_use',
        toolName: chunk.toolName,
        toolArgs: parsedArgs,
        timestamp: now
      }
    }
    case 'tool_result':
      return {
        role: 'assistant',
        type: 'tool_result',
        toolName: chunk.toolName,
        toolResult: chunk.content ?? '',
        timestamp: now
      }
    case 'error':
      return {
        role: 'system',
        type: 'error',
        content: chunk.error ?? chunk.content ?? 'Unknown error',
        timestamp: now
      }
    case 'status':
      return { role: 'system', type: 'status', content: chunk.content ?? '', timestamp: now }
    case 'compact_boundary':
      return {
        role: 'system',
        type: 'status',
        content: 'compact_boundary: ' + (chunk.content ?? ''),
        timestamp: now
      }
    case 'context_usage_update':
      return { role: 'system', type: 'status', content: 'context_usage_update', timestamp: now }
    case 'permission_request':
      return {
        role: 'system',
        type: 'status',
        content: 'permission_request: ' + (chunk.toolName ?? 'unknown'),
        timestamp: now
      }
    case 'todo_update':
      return { role: 'system', type: 'status', content: 'todo_update', timestamp: now }
    case 'phase_progress':
      return {
        role: 'system',
        type: 'status',
        content: 'phase_progress: ' + (chunk.phaseProgress?.phaseTitle ?? ''),
        timestamp: now
      }
    case 'turn_boundary':
      return { role: 'system', type: 'status', content: 'turn_boundary', timestamp: now }
    default:
      return {
        role: 'system',
        type: 'status',
        content:
          chunk.type +
          (chunk.toolName ? `: ${chunk.toolName}` : '') +
          (chunk.content ? ` — ${chunk.content.slice(0, 200)}` : ''),
        timestamp: now
      }
  }
}

// ── Permission Auto-Responder ──

/**
 * Auto-deny permission requests so the stream doesn't hang during E2E testing.
 * The permission_request chunk still lands in the transcript for assertion.
 */
function setupPermissionAutoResponder(
  onChunk: (chunk: StreamChunk) => void
): (chunk: StreamChunk) => void {
  return (chunk: StreamChunk) => {
    onChunk(chunk)
    // Permission auto-deny — mirrors the ask_user auto-responder pattern
    if (chunk.type === 'permission_request' && chunk.permissionRequest) {
      const { permissionId } = chunk.permissionRequest as { permissionId?: string; tool?: string }
      if (permissionId) {
        log.info(`[streamHelper] permission auto-responder: denying permissionId=${permissionId}`)
        // Delay briefly so the chunk tap registration is complete
        setTimeout(() => {
          // The opencode-executor.respondToPermission requires sessionId + permissionId.
          // Since we're in the E2E runner context, we access it via the import.
          import('../opencode-executor')
            .then(({ openCodeExecutor }) => {
              // We need the sessionId from the active agent session
              const session = chatAgentService.getStatus()
              const sessionId = (session as { sessionId?: string })?.sessionId
              if (sessionId) {
                openCodeExecutor
                  .respondToPermission(sessionId, permissionId, false)
                  .catch((err: Error) => {
                    log.warn(`[streamHelper] permission auto-deny failed:`, err.message)
                  })
              }
            })
            .catch(() => {
              log.warn('[streamHelper] Could not import opencode-executor for permission auto-deny')
            })
        }, 300)
      }
    }
  }
}

// ── Stream Prompt Helper ──

export interface StreamPromptOptions {
  conversationId: string
  text: string
  timeoutMs: number
  attachments?: string[]
  abortAfterMs?: number
  /** External abort signal (e.g. from cancel()) */
  onAbort?: (abortFn: () => void) => void
}

/**
 * Stream a prompt through chatStreamService and capture the full transcript.
 * Used by both the E2E runner and service runners for hybrid scenarios.
 */
export async function streamPrompt(opts: StreamPromptOptions): Promise<E2ETranscriptEntry[]> {
  const { conversationId, text, timeoutMs, attachments, abortAfterMs } = opts
  const transcript: E2ETranscriptEntry[] = []

  // Add user prompt to transcript
  transcript.push({ role: 'user', type: 'text', content: text, timestamp: Date.now() })

  let handle: { abort: () => void; done: Promise<void>; requestId?: string } | null = null
  let ourRequestId: string | undefined
  let abortTimerId: ReturnType<typeof setTimeout> | undefined
  let firstTextSeen = false

  const abortStream = (): void => {
    if (handle) {
      handle.abort()
    } else {
      void chatStreamService.stop().catch(() => {})
    }
  }

  // Register external abort callback
  if (opts.onAbort) opts.onAbort(abortStream)

  // Chunk handler with permission auto-responder
  const chunkHandler = setupPermissionAutoResponder((_chunk: StreamChunk) => {
    // Already handled in wrapper — this is the inner handler
  })

  // Register chunk tap
  registerChunkTap(CHUNK_TAP_KEY, (requestId: string | undefined, chunk: StreamChunk) => {
    if (requestId && ourRequestId && requestId !== ourRequestId) return
    const entry = chunkToTranscriptEntry(chunk)
    if (entry) transcript.push(entry)
    chunkHandler(chunk)

    // Abort timer: fire N ms after the first text chunk
    if (abortAfterMs && !firstTextSeen && chunk.type === 'text') {
      firstTextSeen = true
      abortTimerId = setTimeout(() => {
        log.info(`[streamPrompt] abortAfterMs=${abortAfterMs} triggered — aborting stream`)
        abortStream()
      }, abortAfterMs)
    }
  })

  // ask_user auto-responder
  const ASK_USER_DELAY_MS = 500
  const onAskQuestion = (data: {
    questions?: { question: string }[]
    action?: string
    requestId?: string
  }): void => {
    if (data.requestId) {
      log.info(`[streamPrompt] ask_user auto-responder: answering requestId=${data.requestId}`)
      setTimeout(() => {
        chatAgentService.respondToAskUser(
          data.requestId!,
          'Option A — proceed with the first option.'
        )
      }, ASK_USER_DELAY_MS)
    }
  }
  chatAgentService.on('askQuestion', onAskQuestion)

  let timerId: ReturnType<typeof setTimeout> | undefined

  try {
    const GRACE_MS = 5_000
    const streamPromise = chatStreamService.stream(conversationId, text, attachments)
    streamPromise
      .then((h) => {
        handle = h
        ourRequestId = h.requestId
      })
      .catch(() => {})

    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timerId = setTimeout(() => resolve('timeout'), timeoutMs)
    })

    const result = await Promise.race([
      streamPromise
        .then((h) => h.done)
        .then(() => 'done' as const)
        .catch(() => 'done' as const),
      timeoutPromise
    ])

    if (result === 'timeout') {
      abortStream()
      if (handle) {
        await Promise.race([
          (handle as { done: Promise<void> }).done.catch(() => {}),
          new Promise<void>((r) => setTimeout(r, GRACE_MS))
        ])
      } else {
        await new Promise<void>((r) => setTimeout(r, GRACE_MS))
      }
      transcript.push({
        role: 'system',
        type: 'error',
        content: `Prompt timed out after ${timeoutMs}ms`,
        timestamp: Date.now()
      })
    }
  } catch (err) {
    transcript.push({
      role: 'system',
      type: 'error',
      content: err instanceof Error ? err.message : String(err),
      timestamp: Date.now()
    })
  } finally {
    if (timerId !== undefined) clearTimeout(timerId)
    if (abortTimerId !== undefined) clearTimeout(abortTimerId)
    unregisterChunkTap(CHUNK_TAP_KEY)
    chatAgentService.off('askQuestion', onAskQuestion)
  }

  return transcript
}
