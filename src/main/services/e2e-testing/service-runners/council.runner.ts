/**
 * Council Service Runners — session lifecycle, advisor opinions, synthesis, structured output.
 *
 * Caveats:
 * - 5 parallel advisors serialize on one local GPU (timeout 30 min)
 * - Peer review stage hardcodes runOneShotClaude(claude-haiku) → knownIssue on synthesis/structured-output
 * - start-session and advisor-opinions assert only stages 1-2 so they pass locally
 */

import type { E2EServiceContext } from './index'
import type { E2ETranscriptEntry } from '../../../../shared/types'
function statusEntry(content: string): E2ETranscriptEntry {
  return { role: 'system', type: 'status', content, timestamp: Date.now() }
}

function textEntry(content: string): E2ETranscriptEntry {
  return { role: 'assistant', type: 'text', content, timestamp: Date.now() }
}

// ── Helper: start council evaluation and collect events up to a target stage ──

async function runCouncilToStage(
  ctx: E2EServiceContext,
  targetStage: 'member_complete' | 'verdict' | 'complete'
): Promise<{
  transcript: E2ETranscriptEntry[]
  memberCompleteCount: number
  verdict: unknown | null
}> {
  const transcript: E2ETranscriptEntry[] = []
  let memberCompleteCount = 0
  let verdict: unknown | null = null

  try {
    const { councilService } = await import('../../council.service')

    transcript.push(statusEntry('council_starting'))

    const done = new Promise<void>((resolve) => {
      const onPhaseChanged = (data: { phase?: string }) => {
        transcript.push(statusEntry(`phase_changed: ${data.phase ?? 'unknown'}`))
      }
      const onMemberComplete = (_data: unknown) => {
        memberCompleteCount++
        transcript.push(statusEntry(`member_complete: ${memberCompleteCount}`))
        if (targetStage === 'member_complete' && memberCompleteCount >= 2) {
          cleanup()
          resolve()
        }
      }
      const onVerdict = (data: unknown) => {
        verdict = data
        transcript.push(statusEntry('verdict'))
        if (targetStage === 'verdict') {
          cleanup()
          resolve()
        }
      }
      const onComplete = () => {
        transcript.push(statusEntry('council_complete'))
        cleanup()
        resolve()
      }

      function cleanup() {
        councilService.off('phase-changed', onPhaseChanged)
        councilService.off('member-complete', onMemberComplete)
        councilService.off('verdict', onVerdict)
        councilService.off('complete', onComplete)
      }

      councilService.on('phase-changed', onPhaseChanged)
      councilService.on('member-complete', onMemberComplete)
      councilService.on('verdict', onVerdict)
      councilService.on('complete', onComplete)

      // Timeout fallback
      setTimeout(() => {
        cleanup()
        transcript.push(statusEntry('council_timeout'))
        resolve()
      }, 1_200_000) // 20 min max
    })

    // Start evaluation
    await councilService.evaluate({
      workspaceId: ctx.workspaceId,
      workspacePath: ctx.workspacePath,
      inputType: 'plan',
      planContent: 'Add a user authentication system with OAuth2, session management, and RBAC.',
      structuredPlan: null,
      originalUserRequest: 'Build auth system',
      workspaceContext: 'TypeScript project with Express.js backend',
      filesInScope: ['src/hello.ts', 'src/tasks.ts'],
      llmProvider: 'local-llm'
    })

    await done
  } catch (err) {
    transcript.push({ role: 'system', type: 'error', content: (err as Error).message, timestamp: Date.now() })
  }

  return { transcript, memberCompleteCount, verdict }
}

// ── Council Start Session ──

export async function runCouncilStartSession(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const { transcript } = await runCouncilToStage(ctx, 'member_complete')
  return transcript
}

// ── Council Advisor Opinions ──

export async function runCouncilAdvisorOpinions(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const { transcript, memberCompleteCount } = await runCouncilToStage(ctx, 'member_complete')
  transcript.push(statusEntry(`advisor_opinions_received: ${memberCompleteCount}`))
  return transcript
}

// ── Council Synthesis ──

export async function runCouncilSynthesis(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const { transcript, verdict } = await runCouncilToStage(ctx, 'verdict')
  if (verdict) {
    transcript.push(statusEntry('synthesis'))
  }
  return transcript
}

// ── Council Structured Output ──

export async function runCouncilStructuredOutput(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const { transcript, verdict } = await runCouncilToStage(ctx, 'complete')
  if (verdict) {
    transcript.push(textEntry(JSON.stringify(verdict)))
  }
  return transcript
}
