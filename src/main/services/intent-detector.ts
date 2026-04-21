import type {
  ConversationMode,
  ControlToolState,
  GeneralistIntent,
  GrillEvaluation,
  GrillQuestion
} from '../../shared/types'
import { generalistLogger } from '../logger'

const log = generalistLogger

/** Regex to detect grill-summary blocks emitted by the generalist. */
const GRILL_SUMMARY_REGEX = /```grill-summary\n([\s\S]*?)```/

/** Regex to detect grill-question blocks emitted by the generalist. */
const GRILL_QUESTION_REGEX = /```grill-question\n([\s\S]*?)```/g

/** Regex to detect grill-evaluation blocks (new structured format with score + questions). */
const GRILL_EVAL_REGEX = /```grill-evaluation\n([\s\S]*?)```/g

/**
 * Stateless intent detector — extracts the generalist's intent from control tool state.
 *
 * MCP tools are the single source of truth for all action-type intents (plan, handoff, askUser).
 * Regex detection for these intents has been eliminated — no dual-path, no races.
 * Grill events remain regex-based (no MCP tool equivalent).
 */
export class IntentDetector {
  /**
   * Detect all intents from the completed response.
   *
   * Returns an array because the generalist can produce multiple intents in one turn
   * (e.g., grill questions + a plan). The caller should process them in order.
   */
  detectAll(
    accumulatedText: string,
    controlToolState: ControlToolState,
    _mode: ConversationMode,
    _investigationModeEnabled: boolean
  ): GeneralistIntent[] {
    const intents: GeneralistIntent[] = []

    // ── MCP tool intents (single source of truth for action types) ──

    if (controlToolState.plan && controlToolState.planIntent) {
      intents.push(controlToolState.planIntent)
    }

    if (controlToolState.handoff && controlToolState.handoffIntent) {
      intents.push(controlToolState.handoffIntent)
    }

    if (controlToolState.askUser && controlToolState.askUserIntent) {
      intents.push(controlToolState.askUserIntent)
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

  // ── Private detection methods (grill events only) ──

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
