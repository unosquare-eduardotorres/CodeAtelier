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
        // Plan data reaches the renderer through the streaming pipeline (TaskPlanCard);
        // no dedicated IPC channel is needed.
        break

      case 'askUser':
        log.info(
          `[IntentRouter:askUser] conversationId=${conversationId} questions=${intent.questions.length} action=${intent.action ?? 'none'}`
        )
        this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_ASK_QUESTION, {
          conversationId,
          questions: intent.questions,
          action: intent.action,
          requestId: intent.requestId
        })
        break

      case 'grillQuestion':
      case 'grillComplete':
      case 'grillEvaluation':
        // Legacy chat-integrated grill flow — now handled by the dedicated grill system (grill.ipc.ts).
        // Intent detection still runs for logging but no IPC forwarding is needed.
        break

      case 'error':
        log.error(`[IntentRouter:error] conversationId=${conversationId} message=${intent.message}`)
        // Errors are handled in the streaming phase via chunk emission — no separate IPC channel.
        break
    }
  }
}
