/**
 * plan-registry.service — Single entry point for plan registration in the
 * unified Plan Hub registry.
 *
 * Each source (Chat, Grill, Audit, Council) calls a dedicated `register*`
 * method. The service normalizes all plan types to StructuredPlan, derives
 * metrics, and writes to the `plans` table via PlanRepository.
 *
 * Design principles:
 *   - Non-critical: all register methods wrap in try-catch so existing features
 *     never break if the registry fails.
 *   - Idempotent: duplicate source registrations are skipped via findBySource().
 *   - Pure normalization: mappers are side-effect free.
 */

import log from 'electron-log'
import { planRepository } from '../db/repositories/plan.repository'
import { grillPlanToStructuredPlan } from './grill-plan-mapper'
import { auditPlanToStructuredPlan } from './audit-plan-mapper'
import type {
  StructuredPlan,
  GrillStructuredPlan,
  AuditPlan,
  CouncilVerdict,
  PlanRecord
} from '../../shared/types'

const svcLog = log.scope('plan-registry')

class PlanRegistryService {
  // ── Chat plans ──

  registerChatPlan(params: {
    workspaceId: string
    conversationId: string
    messageId: string
    plan: StructuredPlan
    rawContent: string
  }): PlanRecord | null {
    try {
      // Deduplicate: one plan per message
      const existing = planRepository.findBySource('chat', params.messageId)
      if (existing) {
        svcLog.info(`[register-chat] Skipped duplicate for message=${params.messageId}`)
        return existing
      }

      const record = planRepository.savePlan({
        workspaceId: params.workspaceId,
        source: 'chat',
        sourceId: params.messageId,
        title: params.plan.title || 'Untitled Plan',
        summary: params.plan.summary || '',
        planType: params.plan.type ?? null,
        structuredPlan: params.plan,
        linkedConversationId: params.conversationId
      })

      svcLog.info(
        `[register-chat] ✓ Plan registered: id=${record.id}, title="${record.title}"`
      )
      return record
    } catch (err) {
      svcLog.warn('[register-chat] Failed (non-critical):', err)
      return null
    }
  }

  // ── Grill plans ──

  registerGrillPlan(params: {
    workspaceId: string
    grillSessionId: string
    plan: GrillStructuredPlan
  }): PlanRecord | null {
    try {
      const existing = planRepository.findBySource('grill', params.grillSessionId)
      if (existing) {
        svcLog.info(`[register-grill] Skipped duplicate for session=${params.grillSessionId}`)
        return existing
      }

      const structuredPlan = grillPlanToStructuredPlan(params.plan)

      const record = planRepository.savePlan({
        workspaceId: params.workspaceId,
        source: 'grill',
        sourceId: params.grillSessionId,
        title: params.plan.title || 'Untitled Grill Plan',
        summary: params.plan.summary || '',
        planType: structuredPlan.type ?? null,
        structuredPlan,
        sourcePlanJson: JSON.stringify(params.plan),
        requirementDocument: params.plan.requirementDocument || null
      })

      svcLog.info(
        `[register-grill] ✓ Plan registered: id=${record.id}, items=${params.plan.items.length}`
      )
      return record
    } catch (err) {
      svcLog.warn('[register-grill] Failed (non-critical):', err)
      return null
    }
  }

  // ── Audit plans ──

  registerAuditPlan(params: {
    workspaceId: string
    auditPlanId: string
    plan: AuditPlan
  }): PlanRecord | null {
    try {
      const existing = planRepository.findBySource('audit', params.auditPlanId)
      if (existing) {
        svcLog.info(`[register-audit] Skipped duplicate for plan=${params.auditPlanId}`)
        return existing
      }

      const structuredPlan = auditPlanToStructuredPlan(params.plan)

      const record = planRepository.savePlan({
        workspaceId: params.workspaceId,
        source: 'audit',
        sourceId: params.auditPlanId,
        title: params.plan.title || 'Untitled Audit Plan',
        summary: params.plan.summary || '',
        planType: 'audit',
        structuredPlan,
        sourcePlanJson: JSON.stringify(params.plan),
        requirementDocument: params.plan.requirementDocument || null
      })

      svcLog.info(
        `[register-audit] ✓ Plan registered: id=${record.id}, items=${params.plan.items.length}`
      )
      return record
    } catch (err) {
      svcLog.warn('[register-audit] Failed (non-critical):', err)
      return null
    }
  }

  // ── Council verdicts (registers the original plan with council link) ──

  registerCouncilVerdict(params: {
    workspaceId: string
    councilSessionId: string
    verdict: CouncilVerdict
    originalPlan: StructuredPlan
  }): PlanRecord | null {
    try {
      const existing = planRepository.findBySource('council', params.councilSessionId)
      if (existing) {
        svcLog.info(`[register-council] Skipped duplicate for session=${params.councilSessionId}`)
        return existing
      }

      const record = planRepository.savePlan({
        workspaceId: params.workspaceId,
        source: 'council',
        sourceId: params.councilSessionId,
        title: params.originalPlan.title || 'Council-Reviewed Plan',
        summary:
          params.verdict.summary || params.originalPlan.summary || '',
        planType: params.originalPlan.type ?? null,
        structuredPlan: params.originalPlan,
        sourcePlanJson: JSON.stringify(params.verdict),
        linkedCouncilSessionId: params.councilSessionId
      })

      svcLog.info(
        `[register-council] ✓ Plan registered: id=${record.id}, verdict=${params.verdict.verdict}`
      )
      return record
    } catch (err) {
      svcLog.warn('[register-council] Failed (non-critical):', err)
      return null
    }
  }
}

export const planRegistryService = new PlanRegistryService()
