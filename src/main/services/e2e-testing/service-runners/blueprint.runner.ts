/**
 * Blueprint Service Runner — deterministic tests for blueprint lifecycle.
 *
 * These runners call blueprintService directly (no LLM) and emit standard
 * transcript entries for assertion by the existing E2E framework.
 */

import type { E2EServiceContext } from './index'
import type { E2ETranscriptEntry } from '../../../../shared/types'
import electronLog from 'electron-log/main'

const log = electronLog.scope('E2EBlueprintRunner')

function statusEntry(content: string): E2ETranscriptEntry {
  return { role: 'system', type: 'status', content, timestamp: Date.now() }
}

function textEntry(content: string): E2ETranscriptEntry {
  return { role: 'assistant', type: 'text', content, timestamp: Date.now() }
}

// ── Blueprint Create ──

export async function runBlueprintCreate(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { blueprintService } = await import('../../blueprint.service')

    const result = blueprintService.create({
      workspaceId: ctx.workspaceId,
      title: 'E2E Test Blueprint',
      description: 'Blueprint created by E2E service runner for testing.'
    })

    log.info(`[blueprint-create] Created blueprint: ${result.id}, phases: ${result.phases.length}`)

    // Emit the blueprint data as assistant text (for validJson assertion)
    transcript.push(
      textEntry(
        JSON.stringify({
          id: result.id,
          title: result.title,
          phases: result.phases.map((p) => ({ type: p.phase, status: p.status }))
        })
      )
    )

    transcript.push(statusEntry('blueprint_created'))

    // Cleanup
    blueprintService.delete(result.id)
  } catch (err) {
    transcript.push({
      role: 'system',
      type: 'error',
      content: (err as Error).message,
      timestamp: Date.now()
    })
  }

  return transcript
}

// ── Blueprint Phase Management ──

export async function runBlueprintPhaseManagement(
  ctx: E2EServiceContext
): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { blueprintService } = await import('../../blueprint.service')

    // Create blueprint
    const bp = blueprintService.create({
      workspaceId: ctx.workspaceId,
      title: 'E2E Phase Management Test',
      description: 'Testing phase lifecycle operations.'
    })

    // Advance phase
    const advanced = blueprintService.advancePhase(bp.id)
    if (advanced) {
      transcript.push(statusEntry(`phase_advanced: ${advanced.phase}`))
      log.info(`[blueprint-phase-mgmt] Advanced to phase: ${advanced.phase}`)
    }

    // Skip next phase
    const currentBp = blueprintService.getBlueprint(bp.id)
    if (currentBp && currentBp.phases.length > 2) {
      const nextPhase = currentBp.phases.find((p) => p.status === 'pending')
      if (nextPhase) {
        blueprintService.skipPhase(bp.id, nextPhase.phase)
        transcript.push(statusEntry(`phase_skipped: ${nextPhase.phase}`))
      }
    }

    // Rewind to first phase
    if (currentBp && currentBp.phases.length > 0) {
      const firstPhaseType = currentBp.phases[0].phase
      blueprintService.rewindToPhase(bp.id, firstPhaseType)
      transcript.push(statusEntry(`phase_rewound: ${firstPhaseType}`))
    }

    // Cleanup
    blueprintService.delete(bp.id)
  } catch (err) {
    transcript.push({
      role: 'system',
      type: 'error',
      content: (err as Error).message,
      timestamp: Date.now()
    })
  }

  return transcript
}

// ── Blueprint Progress Tracking ──

export async function runBlueprintProgressTracking(
  ctx: E2EServiceContext
): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { blueprintService } = await import('../../blueprint.service')

    // Create blueprint
    const bp = blueprintService.create({
      workspaceId: ctx.workspaceId,
      title: 'E2E Progress Tracking Test',
      description: 'Testing task population and wave grouping.'
    })

    // Populate tasks
    const tasks = blueprintService.populateTasks(bp.id, [
      { taskId: 'task-1', wave: 1, description: 'Setup database schema' },
      { taskId: 'task-2', wave: 1, description: 'Create API routes' },
      { taskId: 'task-3', wave: 2, description: 'Add authentication', dependsOn: ['task-1'] },
      { taskId: 'task-4', wave: 2, description: 'Write tests', dependsOn: ['task-2'] },
      {
        taskId: 'task-5',
        wave: 3,
        description: 'Deploy to staging',
        dependsOn: ['task-3', 'task-4']
      }
    ])

    transcript.push(statusEntry(`tasks_populated: ${tasks.length}`))
    log.info(`[blueprint-progress] Populated ${tasks.length} tasks`)

    // Get tasks by wave
    const waves = blueprintService.getTasksByWave(bp.id)
    const waveInfo = Array.from(waves.entries())
      .map(([wave, waveTasks]) => `wave${wave}: ${waveTasks.length}`)
      .join(', ')

    transcript.push(statusEntry(`waves_verified: ${waveInfo}`))
    log.info(`[blueprint-progress] Wave grouping: ${waveInfo}`)

    // Cleanup
    blueprintService.delete(bp.id)
  } catch (err) {
    transcript.push({
      role: 'system',
      type: 'error',
      content: (err as Error).message,
      timestamp: Date.now()
    })
  }

  return transcript
}

// ── Blueprint Task Execution (Hybrid) ──

export async function runBlueprintTaskExecution(
  ctx: E2EServiceContext
): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { blueprintService } = await import('../../blueprint.service')

    // Create blueprint with tasks
    const bp = blueprintService.create({
      workspaceId: ctx.workspaceId,
      title: 'E2E Task Execution Test',
      description: 'Testing hybrid service + chat task execution.'
    })

    blueprintService.populateTasks(bp.id, [
      {
        taskId: 'task-exec-1',
        wave: 1,
        description: 'Create a greeting utility function in src/greet-util.ts'
      }
    ])

    transcript.push(statusEntry('blueprint_with_tasks_created'))

    // Hybrid: use chat to implement the task
    const chatTranscript = await ctx.streamPrompt(
      'Create a file src/greet-util.ts that exports a function greetUser(name: string): string which returns "Welcome, {name}!". Use the Write tool.'
    )
    transcript.push(...chatTranscript)

    // Cleanup
    blueprintService.delete(bp.id)
  } catch (err) {
    transcript.push({
      role: 'system',
      type: 'error',
      content: (err as Error).message,
      timestamp: Date.now()
    })
  }

  return transcript
}

// ── Blueprint Clarify Live (Real Local LLM) ──

export async function runBlueprintClarifyLive(
  ctx: E2EServiceContext
): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { blueprintService } = await import('../../blueprint.service')
    const { blueprintSpecService } = await import('../../blueprint-spec.service')

    // 1. Create blueprint with deliberately ambiguous description
    const bp = blueprintService.create({
      workspaceId: ctx.workspaceId,
      title: 'E2E Clarify Live Test',
      description:
        'Build a thing that does stuff. It should be fast and work well. Users need to interact with it somehow.'
    })

    log.info(`[blueprint-clarify-live] Created blueprint ${bp.id}`)
    transcript.push(statusEntry('blueprint_created'))

    // 2. Seed a minimal spec artifact so we can skip specify and jump to clarify
    const { blueprintPhaseRepository } =
      await import('../../../db/repositories/blueprint.repository')
    const specPhase = blueprintPhaseRepository.findByBlueprintAndPhase(bp.id, 'specify')
    if (specPhase) {
      blueprintPhaseRepository.updateStatus(specPhase.id, 'complete')
      blueprintPhaseRepository.appendArtifact(specPhase.id, {
        type: 'spec',
        contentJson: {
          summary: 'A vague application that does unspecified things quickly.',
          sections: [{ title: 'Overview', content: 'Build something.' }]
        }
      })
    }

    // 3. Start the clarify phase against the real local LLM
    const CLARIFY_TIMEOUT = 120_000 // 2 minutes for live LLM

    // Listen for the clarify signals
    let clarifySignal: 'questions' | 'gate' | 'awaiting' | null = null

    const onQuestions = (_data: unknown): void => {
      clarifySignal = 'questions'
    }
    const onGate = (): void => {
      clarifySignal = 'gate'
    }
    const onAwaiting = (): void => {
      if (!clarifySignal) clarifySignal = 'awaiting'
    }

    blueprintSpecService.on('clarifyQuestions', onQuestions)
    blueprintSpecService.on('clarifyGateReady', onGate)
    blueprintSpecService.on('clarifyAwaitingInput', onAwaiting)

    // Start the phase (non-blocking — uses events)
    const clarifyPromise = blueprintSpecService
      .startClarifyPhase({
        blueprintId: bp.id,
        workspaceId: ctx.workspaceId,
        workspacePath: ctx.workspacePath
      })
      .catch((err) => {
        log.warn(`[blueprint-clarify-live] Clarify phase threw: ${(err as Error).message}`)
      })

    // Wait for a signal with timeout
    const waitStart = Date.now()
    while (!clarifySignal && Date.now() - waitStart < CLARIFY_TIMEOUT) {
      await new Promise((r) => setTimeout(r, 500))
    }

    // Clean up listeners
    blueprintSpecService.off('clarifyQuestions', onQuestions)
    blueprintSpecService.off('clarifyGateReady', onGate)
    blueprintSpecService.off('clarifyAwaitingInput', onAwaiting)

    // 4. Evaluate result
    if (clarifySignal === 'questions') {
      transcript.push(statusEntry('clarify_questions_received'))
      log.info(`[blueprint-clarify-live] Questions received — bridge working`)

      // 5. Answer the first recommended option to test round-trip
      try {
        await blueprintSpecService.sendClarifyAnswer({
          blueprintId: bp.id,
          workspaceId: ctx.workspaceId,
          message: 'Use the recommended option for all questions.'
        })
        transcript.push(statusEntry('clarify_answer_roundtrip_ok'))
      } catch (answerErr) {
        log.warn(
          `[blueprint-clarify-live] Answer round-trip threw: ${(answerErr as Error).message}`
        )
        transcript.push(statusEntry('clarify_answer_roundtrip_attempted'))
      }
    } else if (clarifySignal === 'gate') {
      transcript.push(statusEntry('clarify_gate_ready'))
      log.info(`[blueprint-clarify-live] Gate ready — model found spec sufficient`)
    } else if (clarifySignal === 'awaiting') {
      // This is the bug signature — stall/dead ask_user
      transcript.push(statusEntry('clarify_stall_awaiting_input'))
      transcript.push({
        role: 'system',
        type: 'error',
        content: 'Clarify stalled in awaitingInput — ask_user bridge may be broken',
        timestamp: Date.now()
      })
    } else {
      transcript.push(statusEntry('clarify_timeout'))
      transcript.push({
        role: 'system',
        type: 'error',
        content: 'Clarify timed out with no signal',
        timestamp: Date.now()
      })
    }

    // Wait for the clarify promise to settle
    await Promise.race([clarifyPromise, new Promise((r) => setTimeout(r, 5_000))])

    // 6. Cleanup
    try {
      blueprintService.cancel(ctx.workspaceId)
    } catch {
      /* best effort */
    }
    blueprintService.delete(bp.id)
  } catch (err) {
    transcript.push({
      role: 'system',
      type: 'error',
      content: (err as Error).message,
      timestamp: Date.now()
    })
  }

  return transcript
}
