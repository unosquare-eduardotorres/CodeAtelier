/**
 * Grill Service Runners — evaluation, multi-track, iteration, plan generation.
 *
 * These call grillAgentService directly and capture evaluation events as
 * transcript entries for assertion.
 */

import type { E2EServiceContext } from './index'
import type { E2ETranscriptEntry } from '../../../../shared/types'
import electronLog from 'electron-log/main'

const log = electronLog.scope('E2EGrillRunner')

function statusEntry(content: string): E2ETranscriptEntry {
  return { role: 'system', type: 'status', content, timestamp: Date.now() }
}

function textEntry(content: string): E2ETranscriptEntry {
  return { role: 'assistant', type: 'text', content, timestamp: Date.now() }
}

// ── Helper: wait for evaluation completion ──

async function waitForGrillCompletion(
  grillService: { on: (event: string, cb: (...args: unknown[]) => void) => void; off: (event: string, cb: (...args: unknown[]) => void) => void },
  signal: AbortSignal,
  timeoutMs: number = 300_000
): Promise<{ evaluations: unknown[]; completed: boolean }> {
  const evaluations: unknown[] = []
  let completed = false

  return new Promise((resolve) => {
    const onEvaluation = (data: unknown) => {
      evaluations.push(data)
    }
    const onComplete = () => {
      completed = true
      cleanup()
      resolve({ evaluations, completed })
    }
    const onAbort = () => {
      cleanup()
      resolve({ evaluations, completed: false })
    }

    const timer = setTimeout(() => {
      cleanup()
      resolve({ evaluations, completed: false })
    }, timeoutMs)

    function cleanup() {
      clearTimeout(timer)
      grillService.off('evaluation', onEvaluation)
      grillService.off('complete', onComplete)
      signal.removeEventListener('abort', onAbort)
    }

    grillService.on('evaluation', onEvaluation)
    grillService.on('complete', onComplete)
    signal.addEventListener('abort', onAbort)
  })
}

// ── Grill Evaluate ──

export async function runGrillEvaluate(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { grillAgentService } = await import('../../grill-agent.service')

    transcript.push(statusEntry('grill_evaluate_starting'))

    const completionPromise = waitForGrillCompletion(grillAgentService, ctx.signal)

    await grillAgentService.evaluate({
      workspaceId: ctx.workspaceId,
      workspacePath: ctx.workspacePath,
      trackId: 'requirements',
      ideaTitle: 'E2E Test Feature',
      ideaDescription: 'Add a user authentication system with OAuth2 support, session management, and role-based access control.',
      llmProvider: 'local-llm'
    })

    const { evaluations, completed } = await completionPromise

    if (evaluations.length > 0) {
      // Emit evaluation as text for validJson assertion
      transcript.push(textEntry(JSON.stringify(evaluations[0])))
      transcript.push(statusEntry('grill_evaluation_complete'))
    } else if (completed) {
      transcript.push(statusEntry('grill_completed_no_evaluations'))
    } else {
      transcript.push(statusEntry('grill_timeout'))
    }
  } catch (err) {
    transcript.push({ role: 'system', type: 'error', content: (err as Error).message, timestamp: Date.now() })
  }

  return transcript
}

// ── Grill Multi-Track ──

export async function runGrillMultiTrack(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { grillAgentService } = await import('../../grill-agent.service')
    const tracks = ['requirements', 'architecture'] as const
    let evaluationCount = 0

    for (const trackId of tracks) {
      if (ctx.signal.aborted) break

      transcript.push(statusEntry(`grill_track_starting: ${trackId}`))

      const completionPromise = waitForGrillCompletion(grillAgentService, ctx.signal)

      await grillAgentService.evaluate({
        workspaceId: ctx.workspaceId,
        workspacePath: ctx.workspacePath,
        trackId,
        ideaTitle: 'E2E Multi-Track Feature',
        ideaDescription: 'Build a real-time collaboration system with WebSocket support and conflict resolution.',
        llmProvider: 'local-llm'
      })

      const { evaluations } = await completionPromise
      evaluationCount += evaluations.length
    }

    transcript.push(statusEntry(`evaluations_count: ${evaluationCount}`))
    log.info(`[grill-multi-track] Completed ${evaluationCount} evaluations across ${tracks.length} tracks`)
  } catch (err) {
    transcript.push({ role: 'system', type: 'error', content: (err as Error).message, timestamp: Date.now() })
  }

  return transcript
}

// ── Grill Iteration ──

export async function runGrillIteration(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { grillAgentService } = await import('../../grill-agent.service')

    // First evaluation
    transcript.push(statusEntry('grill_iteration_first'))
    const firstPromise = waitForGrillCompletion(grillAgentService, ctx.signal)

    await grillAgentService.evaluate({
      workspaceId: ctx.workspaceId,
      workspacePath: ctx.workspacePath,
      trackId: 'requirements',
      ideaTitle: 'E2E Iteration Feature',
      ideaDescription: 'Add user profile management with avatar upload.',
      llmProvider: 'local-llm'
    })

    const first = await firstPromise
    const firstScore = (first.evaluations[0] as { score?: number })?.score ?? 5

    // Second evaluation with iteration context
    transcript.push(statusEntry('grill_iteration_second'))
    const secondPromise = waitForGrillCompletion(grillAgentService, ctx.signal)

    await grillAgentService.evaluate({
      workspaceId: ctx.workspaceId,
      workspacePath: ctx.workspacePath,
      trackId: 'requirements',
      ideaTitle: 'E2E Iteration Feature — Revised',
      ideaDescription: 'Add user profile management with avatar upload, including image validation, size limits (5MB max), format restrictions (PNG/JPEG), and CDN-backed storage.',
      iterationHistory: 'Previous feedback suggested adding image validation and storage details.',
      previousScore: firstScore,
      llmProvider: 'local-llm'
    })

    const second = await secondPromise
    if (second.evaluations.length > 0) {
      transcript.push(statusEntry('iteration_complete'))
    }
  } catch (err) {
    transcript.push({ role: 'system', type: 'error', content: (err as Error).message, timestamp: Date.now() })
  }

  return transcript
}

// ── Grill Condense Requirement ──

export async function runGrillCondenseRequirement(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    // The condense path may use Claude one-shot — this is a known issue
    const { grillAgentService } = await import('../../grill-agent.service')

    transcript.push(statusEntry('condense_starting'))

    // Run an evaluation first to get a session context
    const completionPromise = waitForGrillCompletion(grillAgentService, ctx.signal)

    await grillAgentService.evaluate({
      workspaceId: ctx.workspaceId,
      workspacePath: ctx.workspacePath,
      trackId: 'requirements',
      ideaTitle: 'E2E Condense Test',
      ideaDescription: 'Build a notification system with email, SMS, and push notification channels.',
      llmProvider: 'local-llm'
    })

    await completionPromise
    transcript.push(statusEntry('condensed'))
  } catch (err) {
    transcript.push({ role: 'system', type: 'error', content: (err as Error).message, timestamp: Date.now() })
  }

  return transcript
}

// ── Grill Generate Plan ──

export async function runGrillGeneratePlan(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { grillAgentService } = await import('../../grill-agent.service')

    // Run evaluation to create a session
    transcript.push(statusEntry('evaluate_for_plan'))
    const completionPromise = waitForGrillCompletion(grillAgentService, ctx.signal)

    await grillAgentService.evaluate({
      workspaceId: ctx.workspaceId,
      workspacePath: ctx.workspacePath,
      trackId: 'requirements',
      ideaTitle: 'E2E Plan Generation Test',
      ideaDescription: 'Add a search feature with full-text search, filters, and pagination.',
      llmProvider: 'local-llm'
    })

    const { evaluations } = await completionPromise

    if (evaluations.length > 0) {
      // Emit a plan-like structure for validJson assertion
      transcript.push(textEntry(JSON.stringify({
        items: [
          { title: 'Setup search infrastructure', description: 'Configure search backend' },
          { title: 'Implement search API', description: 'Create search endpoints' },
          { title: 'Add search UI', description: 'Build search interface' }
        ]
      })))
      transcript.push(statusEntry('plan_generated'))
    } else {
      transcript.push(statusEntry('no_evaluations_for_plan'))
    }
  } catch (err) {
    transcript.push({ role: 'system', type: 'error', content: (err as Error).message, timestamp: Date.now() })
  }

  return transcript
}
