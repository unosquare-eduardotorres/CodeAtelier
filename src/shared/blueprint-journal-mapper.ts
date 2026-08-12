/**
 * Blueprint Journal → Chat Message mapper.
 *
 * Converts journal events from the blueprint_events table into
 * BlueprintChatMessage-compatible records for transcript hydration.
 *
 * This module is shared between main and renderer processes.
 * It's pure — no DOM, Electron, or store dependencies.
 */

import { stripBlueprintBlocks } from './blueprint-clarify-parsers'
import type {
  ClarifyFindingsBlock,
  ClarifyQuestion,
  QuestionAnswerState
} from './blueprint-clarify-parsers'
import { parseBlueprintPlan, parseBlueprintTasks } from './blueprint-artifact-parsers'
import type { ToolActivity } from './types'

// ── Types ──

/** Event shape from blueprint_events table (matches BlueprintEvent) */
export interface JournalEvent {
  id: string
  blueprintId: string
  seq: number
  type: string // 'system' | 'agent' | 'user' | 'findings' | 'qa' | 'plan' | 'tasks'
  payload: Record<string, unknown>
  createdAt: string
}

// Uses the real ToolActivity type from shared/types so HydratedChatMessage
// is directly assignable to BlueprintChatMessage (matching status union).

/**
 * Chat message types matching BlueprintChatMessage from blueprint.store.ts.
 * Reproduced here to avoid circular dependency with renderer store.
 */
export type HydratedChatMessage =
  | { type: 'agent'; content: string; toolActivities: ToolActivity[]; timestamp: number }
  | { type: 'user'; content: string; timestamp: number }
  | { type: 'system'; content: string; timestamp: number }
  | { type: 'findings'; findings: ClarifyFindingsBlock; round: number; timestamp: number }
  | { type: 'qa'; questions: ClarifyQuestion[]; answers: Record<string, QuestionAnswerState>; timestamp: number }
  | { type: 'plan'; plan: Record<string, unknown>; timestamp: number }
  | { type: 'tasks'; tasks: Record<string, unknown>; timestamp: number }

// ── Mapper ──

/**
 * Pure mapper: converts journal events into chat messages for transcript display.
 *
 * Handles:
 * - system events (phaseStart, phaseComplete, waveStart, waveComplete)
 * - findings events (derives round from count of prior findings)
 * - qa events (questions paired with immediately-following user answers)
 * - plan/tasks events (parses contentMd or uses contentJson)
 * - agent events (with toolActivities when present)
 * - user events (free-text clarify answers)
 *
 * Exported and pure for unit testing.
 */
/** Maximum events to hydrate — prevents huge transcripts from freezing the renderer. */
export const HYDRATION_EVENT_CAP = 2000

export function journalEventsToChatMessages(events: JournalEvent[]): HydratedChatMessage[] {
  // Hydration cap: take only the last N events + prepend truncation marker
  let truncated = false
  let capped = events
  if (events.length > HYDRATION_EVENT_CAP) {
    truncated = true
    capped = events.slice(events.length - HYDRATION_EVENT_CAP)
  }

  const messages: HydratedChatMessage[] = []
  if (truncated) {
    // MINOR-FIX: Apply same isNaN guard as the main event loop to prevent
    // NaN timestamp on the truncation marker from unparseable createdAt.
    const markerTs = capped.length > 0 ? new Date(capped[0].createdAt).getTime() : Date.now()
    messages.push({
      type: 'system',
      content: `… ${events.length - HYDRATION_EVENT_CAP} earlier events omitted`,
      timestamp: isNaN(markerTs) ? Date.now() : markerTs
    })
  }
  let findingsRound = 0

  // GAP-7: Pre-index phases that have accumulator-style agent entries
  // (those with toolActivities key). When present, skip non-accumulator
  // agent events (artifactType-bearing) to avoid duplicate bubbles.
  const phasesWithAccumulatorAgents = new Set<string>()
  for (const ev of capped) {
    if (ev.type === 'agent' && ev.payload.toolActivities) {
      const phase = ev.payload.phase as string | undefined
      if (phase) phasesWithAccumulatorAgents.add(phase)
    }
  }

  // Pre-index: build a map of qa-seq → next-user-events for answer pairing
  const userAnswersByQaSeq = new Map<number, JournalEvent[]>()
  for (let i = 0; i < capped.length; i++) {
    if (capped[i].type === 'qa' && capped[i].payload.questions) {
      // Collect immediately-following 'user' events as answers
      const answers: JournalEvent[] = []
      for (let j = i + 1; j < capped.length; j++) {
        if (capped[j].type === 'user') {
          answers.push(capped[j])
        } else {
          break // stop at first non-user event
        }
      }
      if (answers.length > 0) {
        userAnswersByQaSeq.set(capped[i].seq, answers)
      }
    }
  }

  // Track which user events were consumed as qa answers (skip them in main loop)
  const consumedUserSeqs = new Set<number>()
  for (const answers of userAnswersByQaSeq.values()) {
    for (const a of answers) consumedUserSeqs.add(a.seq)
  }

  for (const event of capped) {
    // MINOR-FIX: Guard against unparseable SQLite created_at formats
    const parsed = new Date(event.createdAt).getTime()
    const ts = isNaN(parsed) ? Date.now() : parsed
    const p = event.payload

    switch (event.type) {
      case 'system': {
        const ev = p.event as string | undefined
        if (ev === 'phaseStart') {
          const phase = (p.phase as string) ?? 'unknown'
          const phaseLabel = phase.charAt(0).toUpperCase() + phase.slice(1)
          messages.push({ type: 'system', content: `${phaseLabel} phase started`, timestamp: ts })
        } else if (ev === 'phaseComplete') {
          const phase = (p.phase as string) ?? 'unknown'
          const phaseLabel = phase.charAt(0).toUpperCase() + phase.slice(1)
          const status = (p.status as string) ?? 'complete'
          messages.push({ type: 'system', content: `${phaseLabel} phase ${status}`, timestamp: ts })
        } else if (ev === 'waveStart') {
          const wave = p.wave as number ?? 0
          const taskCount = p.taskCount as number ?? 0
          messages.push({ type: 'system', content: `Wave ${wave} started — ${taskCount} tasks`, timestamp: ts })
        } else if (ev === 'waveComplete') {
          const wave = p.wave as number ?? 0
          messages.push({ type: 'system', content: `Wave ${wave} complete`, timestamp: ts })
        } else {
          // Generic system message (e.g. future event types)
          messages.push({ type: 'system', content: String(p.message ?? p.event ?? 'System event'), timestamp: ts })
        }
        break
      }

      case 'findings': {
        findingsRound++
        const findings = p.findings as ClarifyFindingsBlock
        if (findings) {
          messages.push({ type: 'findings', findings, round: findingsRound, timestamp: ts })
        }
        break
      }

      case 'qa': {
        const questions = p.questions as ClarifyQuestion[] | undefined
        if (questions) {
          // Try to pair with user answers
          const pairedAnswers = userAnswersByQaSeq.get(event.seq)
          const answersRecord: Record<string, QuestionAnswerState> = {}
          if (pairedAnswers?.length) {
            // Best-effort: if single user message, map it as free-text for all questions
            // If multiple, pair by index
            for (let qi = 0; qi < questions.length; qi++) {
              const q = questions[qi]
              const qId = q.id ?? `q-${qi}`
              const answerEvent = pairedAnswers[Math.min(qi, pairedAnswers.length - 1)]
              const message = (answerEvent.payload.message as string) ?? ''
              answersRecord[qId] = {
                selectedOptions: [],
                otherText: message,
                otherSelected: true,
                skipped: false
              }
            }
          }
          messages.push({ type: 'qa', questions, answers: answersRecord, timestamp: ts })
        } else if (p.event === 'gateReady') {
          // Gate-ready marker — render as system message
          messages.push({ type: 'system', content: 'Clarify gate ready — review findings before proceeding', timestamp: ts })
        }
        break
      }

      case 'plan': {
        const contentJson = p.contentJson as Record<string, unknown> | undefined
        const contentMd = p.contentMd as string | undefined
        const plan = contentJson ?? (contentMd ? parseBlueprintPlan(contentMd) : null) ?? {}
        messages.push({ type: 'plan', plan, timestamp: ts })
        break
      }

      case 'tasks': {
        const contentJson = p.contentJson as Record<string, unknown> | undefined
        const contentMd = p.contentMd as string | undefined
        const tasks = contentJson ?? (contentMd ? parseBlueprintTasks(contentMd) : null) ?? {}
        messages.push({ type: 'tasks', tasks, timestamp: ts })
        break
      }

      case 'agent': {
        // GAP-7: Skip artifact-type agent entries when same phase has
        // accumulator-style entries (which already carry the same content).
        const agentPhase = p.phase as string | undefined
        if (p.artifactType && agentPhase && phasesWithAccumulatorAgents.has(agentPhase)) {
          break // duplicate — accumulator entry already journals this content
        }
        const content = (p.contentMd as string) || (p.content as string) || ''
        const toolActivities = (p.toolActivities as ToolActivity[]) ?? []
        if (content.trim() || toolActivities.length > 0) {
          messages.push({ type: 'agent', content: stripBlueprintBlocks(content), toolActivities, timestamp: ts })
        }
        break
      }

      case 'user': {
        // Skip user events that were consumed as qa answers
        if (consumedUserSeqs.has(event.seq)) break
        const message = (p.message as string) ?? ''
        if (message.trim()) {
          messages.push({ type: 'user', content: message, timestamp: ts })
        }
        break
      }

      default:
        // Unknown event type — skip silently (forward compat)
        break
    }
  }

  return messages
}
