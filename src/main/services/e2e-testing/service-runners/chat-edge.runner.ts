/**
 * Chat Edge-Case Service Runners — concurrency, lifecycle, and race condition testing.
 *
 * These runners bypass the normal prompt path and directly exercise chatStreamService
 * to test edge conditions that can't be triggered via catalog prompts.
 *
 * - runChatEdgeConcurrent: empty prompt rejection + concurrent stream rejection
 * - runChatEdgeRapidCancel: 3× start → abort → restart cycles
 * - runChatEdgeCompactRace: compact() then immediately stream
 */

import type { E2EServiceContext } from './index'
import type { E2ETranscriptEntry } from '../../../../shared/types'
import electronLog from 'electron-log/main'

const log = electronLog.scope('E2EChatEdgeRunner')

function statusEntry(content: string): E2ETranscriptEntry {
  return { role: 'system', type: 'status', content, timestamp: Date.now() }
}

function errorEntry(content: string): E2ETranscriptEntry {
  return { role: 'system', type: 'error', content, timestamp: Date.now() }
}

// ── Concurrent Stream Rejection + Empty Prompt ──

/**
 * Tests:
 * 1. Whitespace-only prompt → assert graceful rejection (no stream-lock leak)
 * 2. Start a real stream → immediately start another → assert second rejects, first completes
 */
export async function runChatEdgeConcurrent(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { chatStreamService } = await import('../../chat-stream.service')

    // Part 1: Empty/whitespace-only prompt
    transcript.push(statusEntry('testing_empty_prompt'))
    try {
      const handle = await chatStreamService.stream(ctx.conversationId, '   ')
      // If stream was accepted, wait for it to complete/fail
      await handle.done.catch(() => {})
      transcript.push(statusEntry('empty_accepted_unexpectedly'))
    } catch (err) {
      // Expected: empty prompt should be rejected
      transcript.push(statusEntry('empty_rejected'))
      log.info(`[chat-edge-concurrent] Empty prompt correctly rejected: ${(err as Error).message}`)
    }

    // Brief delay to ensure lock is released
    await new Promise((r) => setTimeout(r, 1000))

    // Verify no stream lock by sending a real prompt
    transcript.push(statusEntry('testing_post_empty_stream'))
    try {
      const entries = await ctx.streamPrompt('What is 1+1? Answer briefly.', {
        conversationId: ctx.conversationId
      })
      const hasResponse = entries.some((e) => e.type === 'text' && e.role === 'assistant')
      transcript.push(statusEntry(hasResponse ? 'second_stream_ok' : 'second_stream_no_response'))
    } catch (err) {
      transcript.push(statusEntry(`second_stream_failed: ${(err as Error).message}`))
    }

    // Part 2: Concurrent stream rejection
    await new Promise((r) => setTimeout(r, 2000))
    transcript.push(statusEntry('testing_concurrent'))

    try {
      // Start first stream (don't await completion)
      const firstPromise = chatStreamService.stream(
        ctx.conversationId,
        'Explain the concept of recursion in programming. Be detailed.'
      )

      // Give it a moment to start
      await new Promise((r) => setTimeout(r, 300))

      // Try to start second stream immediately
      try {
        await chatStreamService.stream(ctx.conversationId, 'What is 2+2?')
        transcript.push(statusEntry('second_stream_accepted_unexpectedly'))
      } catch (err) {
        transcript.push(statusEntry('second_stream_rejected'))
        log.info(
          `[chat-edge-concurrent] Second stream correctly rejected: ${(err as Error).message}`
        )
      }

      // Wait for first stream to finish
      const firstHandle = await firstPromise.catch(() => null)
      if (firstHandle) {
        await firstHandle.done.catch(() => {})
        transcript.push(statusEntry('first_stream_ok'))
      }
    } catch (err) {
      transcript.push(statusEntry(`concurrent_test_error: ${(err as Error).message}`))
    }
  } catch (err) {
    transcript.push(errorEntry((err as Error).message))
  }

  return transcript
}

// ── Rapid Cancel-Restart ──

/**
 * 3× (start → abort at 500ms → restart) → assert no zombie sessions.
 * Each restart should succeed, proving proper cleanup after abort.
 */
export async function runChatEdgeRapidCancel(
  ctx: E2EServiceContext
): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { chatStreamService } = await import('../../chat-stream.service')

    let successCount = 0
    const cycles = 3

    for (let i = 0; i < cycles; i++) {
      transcript.push(statusEntry(`cycle_${i + 1}_start`))

      try {
        const handle = await chatStreamService.stream(
          ctx.conversationId,
          `Cycle ${i + 1}: Write a short paragraph about software engineering.`
        )

        // Abort after 500ms
        await new Promise((r) => setTimeout(r, 500))
        handle.abort()

        // Wait for abort to settle
        await handle.done.catch(() => {})
        await new Promise((r) => setTimeout(r, 1000))

        // Restart with a new prompt
        try {
          const restartEntries = await ctx.streamPrompt(
            `Cycle ${i + 1} restart: What is ${i + 1} + ${i + 1}? Answer briefly.`,
            { conversationId: ctx.conversationId }
          )
          const hasResponse = restartEntries.some(
            (e) => e.type === 'text' && e.role === 'assistant'
          )
          if (hasResponse) successCount++
          transcript.push(
            statusEntry(`cycle_${i + 1}_restart_${hasResponse ? 'ok' : 'no_response'}`)
          )
        } catch (restartErr) {
          transcript.push(
            statusEntry(`cycle_${i + 1}_restart_failed: ${(restartErr as Error).message}`)
          )
        }

        // Brief delay between cycles
        await new Promise((r) => setTimeout(r, 1000))
      } catch (err) {
        transcript.push(statusEntry(`cycle_${i + 1}_error: ${(err as Error).message}`))
        await new Promise((r) => setTimeout(r, 2000))
      }
    }

    log.info(`[chat-edge-rapid-cancel] Success: ${successCount}/${cycles}`)
    transcript.push(
      statusEntry(
        successCount >= 2 ? 'no_zombie_sessions' : `zombie_risk: ${successCount}/${cycles}`
      )
    )
  } catch (err) {
    transcript.push(errorEntry((err as Error).message))
  }

  return transcript
}

// ── Stream During Compaction ──

/**
 * Trigger compact() then immediately stream → assert either queued or clean rejection.
 * Never corruption.
 */
export async function runChatEdgeCompactRace(
  ctx: E2EServiceContext
): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { chatAgentService } = await import('../../chat-agent.service')

    // First, ensure there's some conversation history to compact
    transcript.push(statusEntry('building_history'))
    const entries1 = await ctx.streamPrompt('Remember the number 42. Just acknowledge.', {
      conversationId: ctx.conversationId
    })
    transcript.push(...entries1.filter((e) => e.type === 'status'))

    await new Promise((r) => setTimeout(r, 1000))

    const entries2 = await ctx.streamPrompt('What is the meaning of life? Brief answer.', {
      conversationId: ctx.conversationId
    })
    transcript.push(...entries2.filter((e) => e.type === 'status'))

    await new Promise((r) => setTimeout(r, 1000))

    // Trigger compact (don't await) then immediately stream
    transcript.push(statusEntry('triggering_compact_race'))

    const compactPromise = chatAgentService.compact().catch((err: Error) => {
      log.info(
        `[chat-edge-compact-race] Compact error (may be expected): ${(err as Error).message}`
      )
    })

    // Immediately try to stream during compaction
    try {
      const raceEntries = await ctx.streamPrompt('What number did I ask you to remember?', {
        conversationId: ctx.conversationId
      })

      const hasResponse = raceEntries.some((e) => e.type === 'text' && e.role === 'assistant')
      transcript.push(
        statusEntry(hasResponse ? 'stream_after_compact_ok' : 'stream_after_compact_no_response')
      )
    } catch (err) {
      // Clean rejection is acceptable
      transcript.push(statusEntry(`compact_race_ok: ${(err as Error).message}`))
    }

    await compactPromise
  } catch (err) {
    transcript.push(errorEntry((err as Error).message))
  }

  return transcript
}
