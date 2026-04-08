import type {
  ConversationMode,
  ControlToolState,
  GeneralistIntent,
  GrillEvaluation,
  GrillQuestion,
  PlanDetectedEvent,
  StructuredPlan
} from '../../shared/types'
import { HANDOFF_REGEX, PLAN_REGEX, parseHandoffBlock } from './generalist-utils'
import { generalistLogger } from '../logger'

const log = generalistLogger

/** Regex to detect grill-summary blocks emitted by the generalist. */
const GRILL_SUMMARY_REGEX = /```grill-summary\n([\s\S]*?)```/

/** Regex to detect grill-question blocks emitted by the generalist. */
const GRILL_QUESTION_REGEX = /```grill-question\n([\s\S]*?)```/g

/** Regex to detect grill-evaluation blocks (new structured format with score + questions). */
const GRILL_EVAL_REGEX = /```grill-evaluation\n([\s\S]*?)```/g

/**
 * Stateless intent detector — extracts the generalist's intent from accumulated text
 * and control tool state.
 *
 * Priority: MCP tool > regex fallback > plain response.
 * Note: ask-user uses MCP tool only (no regex fallback). Handoff and plan retain dual-path.
 *
 * This replaces the 6 detect*() methods previously scattered in GeneralistService,
 * consolidating dual-path detection (MCP tools + regex) into a single, testable class.
 */
export class IntentDetector {
  /**
   * Quick check for handoff presence in accumulated text during streaming.
   * Used for early stream termination — full intent detection happens post-stream.
   */
  hasHandoff(
    accumulatedText: string,
    mode: ConversationMode,
    investigationModeEnabled: boolean
  ): boolean {
    if (!investigationModeEnabled) return false
    if (mode === 'plan') return false
    return HANDOFF_REGEX.test(accumulatedText)
  }

  /**
   * Detect all intents from the completed response.
   *
   * Returns an array because the generalist can produce multiple intents in one turn
   * (e.g., grill questions + a plan). The caller should process them in order.
   *
   * MCP tool-based intents take priority over regex-detected ones for the same action type
   * (plan, handoff, askUser). Grill events are always regex-based.
   */
  detectAll(
    accumulatedText: string,
    controlToolState: ControlToolState,
    mode: ConversationMode,
    investigationModeEnabled: boolean
  ): GeneralistIntent[] {
    const intents: GeneralistIntent[] = []

    // ── MCP tool intents take priority ──

    if (controlToolState.plan && controlToolState.planIntent) {
      intents.push(controlToolState.planIntent)
    }

    if (controlToolState.handoff && controlToolState.handoffIntent) {
      intents.push(controlToolState.handoffIntent)
    }

    if (controlToolState.askUser && controlToolState.askUserIntent) {
      intents.push(controlToolState.askUserIntent)
    }

    // ── Regex fallbacks (only if MCP tool didn't fire for the same type) ──

    if (!controlToolState.handoff) {
      const handoffIntent = this.detectHandoff(accumulatedText, mode, investigationModeEnabled)
      if (handoffIntent) intents.push(handoffIntent)
    }

    if (!controlToolState.plan) {
      const planIntent = this.detectPlan(accumulatedText)
      if (planIntent) intents.push(planIntent)
    }

    // ── Grill events (always regex-based — no MCP tool equivalent) ──

    const grillSummary = this.detectGrillSummary(accumulatedText)
    if (grillSummary) intents.push(grillSummary)

    const grillEvaluations = this.detectGrillEvaluation(accumulatedText)
    intents.push(...grillEvaluations)

    const grillQuestions = this.detectGrillQuestion(accumulatedText)
    if (grillQuestions) intents.push(grillQuestions)

    return intents
  }

  /**
   * Log dual-mode telemetry — tracks which detection path fired for each action type.
   */
  logDetectionPaths(
    accumulatedText: string,
    controlToolState: ControlToolState,
    handoffDetectedInStream: boolean
  ): void {
    const regexPlanFired = !controlToolState.plan && !!accumulatedText.match(PLAN_REGEX)
    const regexHandoffFired =
      !controlToolState.handoff &&
      !handoffDetectedInStream &&
      !!accumulatedText.match(HANDOFF_REGEX)

    if (controlToolState.plan || regexPlanFired) {
      log.info(`[PIPELINE:plan-path] tool=${controlToolState.plan} regex=${regexPlanFired}`)
    }
    if (controlToolState.handoff || regexHandoffFired) {
      log.info(
        `[PIPELINE:handoff-path] tool=${controlToolState.handoff} regex=${regexHandoffFired}`
      )
    }
    if (controlToolState.askUser) {
      log.info(`[PIPELINE:ask-user-path] tool=true regex=false`)
    }
    if (controlToolState.memory) {
      log.info(`[PIPELINE:memory-path] tool=true`)
    }
  }

  // ── Private detection methods ──

  private detectHandoff(
    accumulatedText: string,
    mode: ConversationMode,
    investigationModeEnabled: boolean
  ): GeneralistIntent | null {
    if (!investigationModeEnabled) return null

    if (mode === 'plan') {
      const match = accumulatedText.match(HANDOFF_REGEX)
      if (match) {
        log.warn(
          `[PIPELINE:handoff-suppressed] Plan-mode handoff blocked — generalist must produce plan directly.`
        )
      }
      return null
    }

    const brief = parseHandoffBlock(accumulatedText)
    if (!brief) return null

    log.info('Handoff detected (regex):', {
      summary: brief.summary,
      decisions: brief.decisions.length,
      constraints: brief.constraints.length,
      filesDiscussed: brief.filesDiscussed.length,
      specialists: brief.specialists
    })

    return { type: 'handoff', brief }
  }

  private detectPlan(accumulatedText: string): GeneralistIntent | null {
    const match = accumulatedText.match(PLAN_REGEX)
    if (!match) return null

    const rawContent = match[1].trim()
    let structuredPlan: StructuredPlan | null = null
    try {
      const parsed = JSON.parse(rawContent)
      if (parsed && typeof parsed === 'object' && typeof parsed.title === 'string') {
        structuredPlan = parsed as StructuredPlan
      }
    } catch {
      // Raw markdown plan — still emit the event with null structured data
    }

    log.info(
      `[PIPELINE:plan-detected] structured=${!!structuredPlan} contentLen=${rawContent.length}`
    )

    const planEvent: PlanDetectedEvent = {
      rawContent,
      structuredPlan,
      beforePlan: accumulatedText.substring(0, match.index!),
      afterPlan: accumulatedText.substring(match.index! + match[0].length)
    }

    return { type: 'plan', plan: planEvent }
  }

  private detectGrillSummary(accumulatedText: string): GeneralistIntent | null {
    const match = accumulatedText.match(GRILL_SUMMARY_REGEX)
    if (!match) return null

    try {
      const data = JSON.parse(match[1].trim())
      if (data.summary) {
        log.info('Grill summary detected:', data.summary)
        return {
          type: 'grillComplete',
          summary: data.summary,
          proposedTasks: Array.isArray(data.proposedTasks) ? data.proposedTasks : []
        }
      }
    } catch (error) {
      log.error('Failed to parse grill-summary block:', error)
    }

    return null
  }

  private detectGrillQuestion(accumulatedText: string): GeneralistIntent | null {
    const matches = [...accumulatedText.matchAll(GRILL_QUESTION_REGEX)]
    if (matches.length === 0) return null

    const allQuestions: GrillQuestion[] = []
    for (const match of matches) {
      try {
        const data = JSON.parse(match[1].trim())
        if (data.questions && Array.isArray(data.questions)) {
          allQuestions.push(...data.questions)
        }
      } catch (error) {
        log.error('Failed to parse grill-question block:', error)
      }
    }

    if (allQuestions.length === 0) return null

    log.info(`Grill questions detected: ${allQuestions.length} questions`)
    return { type: 'grillQuestion', questions: allQuestions }
  }

  private detectGrillEvaluation(accumulatedText: string): GeneralistIntent[] {
    const matches = [...accumulatedText.matchAll(GRILL_EVAL_REGEX)]
    if (matches.length === 0) return []

    const intents: GeneralistIntent[] = []
    for (const match of matches) {
      try {
        const data = JSON.parse(match[1].trim())
        if (typeof data.score === 'number' && Array.isArray(data.questions)) {
          log.info(
            `Grill evaluation detected: score=${data.score}, questions=${data.questions.length}`
          )
          intents.push({
            type: 'grillEvaluation',
            evaluation: {
              trackId: data.trackId ?? undefined,
              score: data.score,
              scoreLabel: data.scoreLabel ?? '',
              feedback: data.feedback ?? '',
              questions: data.questions,
              suggestedNextTrack: data.suggestedNextTrack ?? undefined
            } as GrillEvaluation
          })
        }
      } catch (error) {
        log.error('Failed to parse grill-evaluation block:', error)
      }
    }

    return intents
  }
}

/** Singleton instance */
export const intentDetector = new IntentDetector()
