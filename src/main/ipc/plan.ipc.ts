/**
 * plan.ipc — IPC handlers for the Plan Hub (unified plan registry).
 *
 * Provides CRUD operations on the `plans` table and the "import plan"
 * flow that creates a new conversation pre-loaded with plan content.
 */

import { ipcMain } from 'electron'
import log from 'electron-log'
import { IPC_CHANNELS } from '../../shared/constants'
import { planRepository } from '../db/repositories/plan.repository'
import { conversationRepository, messageRepository } from '../db/repositories'
import { getDatabase } from '../db/index'
import { validateSender } from './validate-sender'
import type { PlanFilters, PlanStatus } from '../../shared/types'

const planLog = log.scope('plan-ipc')

export function registerPlanIpc(): void {
  // ── plan:getAll — List plans for a workspace with optional filters ──
  ipcMain.handle(
    IPC_CHANNELS.PLAN_GET_ALL,
    (event, args: { workspaceId: string; filters?: PlanFilters }) => {
      validateSender(event)
      return planRepository.getForWorkspace(args.workspaceId, args.filters)
    }
  )

  // ── plan:getById — Fetch a single plan ──
  ipcMain.handle(IPC_CHANNELS.PLAN_GET_BY_ID, (event, args: { planId: string }) => {
    validateSender(event)
    return planRepository.getById(args.planId)
  })

  // ── plan:updateStatus — Update plan lifecycle status ──
  ipcMain.handle(
    IPC_CHANNELS.PLAN_UPDATE_STATUS,
    (
      event,
      args: {
        planId: string
        status: PlanStatus
        linkedConversationId?: string
        linkedMpaRunId?: string
        linkedCouncilSessionId?: string
      }
    ) => {
      validateSender(event)
      planRepository.updateStatus(args.planId, args.status, {
        conversationId: args.linkedConversationId,
        mpaRunId: args.linkedMpaRunId,
        councilSessionId: args.linkedCouncilSessionId
      })
      planLog.info(`[plan:updateStatus] ${args.planId} → ${args.status}`)
      return { success: true }
    }
  )

  // ── plan:delete — Delete a plan from the registry ──
  ipcMain.handle(IPC_CHANNELS.PLAN_DELETE, (event, args: { planId: string }) => {
    validateSender(event)
    const deleted = planRepository.deletePlan(args.planId)
    planLog.info(`[plan:delete] ${args.planId} deleted=${deleted}`)
    return { deleted }
  })

  // ── plan:import — Create new conversation pre-loaded with plan content ──
  ipcMain.handle(
    IPC_CHANNELS.PLAN_IMPORT,
    (event, args: { planId: string; workspaceId: string }) => {
      validateSender(event)

      const plan = planRepository.getById(args.planId)
      if (!plan) {
        throw new Error(`Plan not found: ${args.planId}`)
      }

      // Build the message content from requirementDocument or structured plan
      const planContent =
        plan.requirementDocument ||
        `# ${plan.title}\n\n${plan.summary}\n\n${JSON.stringify(plan.structuredPlan, null, 2)}`

      const messageContent = `I have a plan I'd like to implement:\n\n${planContent}`

      // ATOM-03: Wrap all three writes in a transaction so partial failure
      // doesn't leave an orphaned conversation or un-linked plan.
      const db = getDatabase()
      const result = db.transaction(() => {
        const conversation = conversationRepository.create(args.workspaceId, plan.title, 'plan')
        messageRepository.create(conversation.id, 'user', messageContent)
        planRepository.markHandedOff(plan.id, conversation.id)
        return { conversationId: conversation.id, planId: plan.id }
      })()

      planLog.info(`[plan:import] Plan ${result.planId} imported into conversation ${result.conversationId}`)

      return result
    }
  )
}
