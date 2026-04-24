import type { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import type { AgentIntent } from '../../shared/types'
import { eventLoggerService } from './event-logger.service'
import { chatAgentLogger } from '../logger'

const log = chatAgentLogger

/**
 * Routes AgentIntent values to the appropriate IPC channel.
 *
 * This replaces the inline event listeners in ChatStreamService.registerEventForwarders()
 * that previously forwarded 5+ string-based EventEmitter events to the renderer.
 *
 * Each intent type maps to exactly one IPC send — trivially testable without EventEmitter,
 * closures, or shared mutable state.
 */
export class IntentRouter {
  constructor(private mainWindow: BrowserWindow) {}

  /**
   * Route a single generalist intent to the appropriate IPC channel.
   *
   * @returns A Promise that resolves to a handoff brief if the intent was a handoff,
   *          or undefined for all other intent types. This allows the caller to
   *          chain handoff execution without separate event listeners.
   */
  route(conversationId: string, intent: AgentIntent): void {
    switch (intent.type) {
      case 'response':
        // Response intents are a no-op here — text is already streamed chunk-by-chunk
        // during the streaming phase. The 'response' type exists for completeness
        // in the intent union but doesn't need routing.
        break

      case 'plan':
        log.info(`[IntentRouter:plan] conversationId=${conversationId}`)
        eventLoggerService.logPlanDetected({
          conversationId,
          detectionPath: intent.plan.structuredPlan ? 'tool' : 'regex',
          structured: !!intent.plan.structuredPlan,
          contentLength: intent.plan.rawContent.length
        })
        this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_PLAN, {
          conversationId,
          ...intent.plan
        })
        break

      case 'askUser':
        log.info(
          `[IntentRouter:askUser] conversationId=${conversationId} questions=${intent.questions.length}`
        )
        this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_ASK_QUESTION, {
          conversationId,
          questions: intent.questions
        })
        break

      case 'grillQuestion':
        log.info(
          `[IntentRouter:grillQuestion] conversationId=${conversationId} questions=${intent.questions.length}`
        )
        this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_GRILL_QUESTION, {
          conversationId,
          questions: intent.questions
        })
        break

      case 'grillComplete':
        log.info(`[IntentRouter:grillComplete] conversationId=${conversationId}`)
        this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_GRILL_COMPLETE, {
          conversationId,
          summary: intent.summary,
          proposedTasks: intent.proposedTasks
        })
        break

      case 'grillEvaluation':
        log.info(
          `[IntentRouter:grillEvaluation] conversationId=${conversationId} score=${intent.evaluation.score}`
        )
        this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_GRILL_EVALUATION, {
          conversationId,
          ...intent.evaluation
        })
        break

      case 'error':
        log.error(`[IntentRouter:error] conversationId=${conversationId} message=${intent.message}`)
        // Errors are handled in the streaming phase via chunk emission — no separate IPC channel.
        break
    }
  }

}
