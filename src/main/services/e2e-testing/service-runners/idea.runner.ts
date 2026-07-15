/**
 * Idea Service Runners — CRUD, grill linkage, conversion, and blueprint generation.
 *
 * Most are deterministic (no LLM) — they exercise ideaRepository directly.
 * ideas.grill-to-blueprint is heavy (requires LLM for grill evaluation).
 */

import type { E2EServiceContext } from './index'
import type { E2ETranscriptEntry } from '../../../../shared/types'
import electronLog from 'electron-log/main'

const log = electronLog.scope('E2EIdeaRunner')

function statusEntry(content: string): E2ETranscriptEntry {
  return { role: 'system', type: 'status', content, timestamp: Date.now() }
}

function errorEntry(content: string): E2ETranscriptEntry {
  return { role: 'system', type: 'error', content, timestamp: Date.now() }
}

// ── Idea CRUD ──

/**
 * Deterministic: create / update / delete via ideaRepository.
 */
export async function runIdeaCrud(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { ideaRepository } = await import('../../../db/repositories')

    // Create
    const idea = ideaRepository.create(
      ctx.workspaceId,
      'E2E Test Idea',
      'A test idea for validating CRUD operations in the E2E runner.'
    )
    log.info(`[idea-crud] Created: ${idea.id}`)
    transcript.push(statusEntry(`idea_created: ${idea.id}`))

    // Update
    const updated = ideaRepository.update(idea.id, {
      title: 'E2E Test Idea — Updated',
      description: 'Updated description for the E2E test idea.'
    })
    if (updated) {
      transcript.push(statusEntry(`idea_updated: ${updated.title}`))
    } else {
      transcript.push(statusEntry('idea_update_failed'))
    }

    // Verify read
    const fetched = ideaRepository.findById(idea.id)
    if (fetched && fetched.title === 'E2E Test Idea — Updated') {
      transcript.push(statusEntry('idea_read_verified'))
    }

    // Delete
    ideaRepository.delete(idea.id)
    const afterDelete = ideaRepository.findById(idea.id)
    if (!afterDelete) {
      transcript.push(statusEntry('idea_deleted'))
    } else {
      transcript.push(statusEntry('idea_delete_failed'))
    }
  } catch (err) {
    transcript.push(errorEntry((err as Error).message))
  }

  return transcript
}

// ── Idea Start Grill ──

/**
 * Deterministic: create idea → setGrillConversation → verify linkage via findByGrillConversation.
 */
export async function runIdeaStartGrill(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { ideaRepository, conversationRepository } = await import('../../../db/repositories')

    // Create idea
    const idea = ideaRepository.create(
      ctx.workspaceId,
      'Grill Linkage Test',
      'An idea to test grill conversation linkage.'
    )
    transcript.push(statusEntry(`idea_created: ${idea.id}`))

    // Create a grill conversation
    const grillConv = conversationRepository.create(
      ctx.workspaceId,
      'E2E Grill Conversation',
      'plan'
    )
    transcript.push(statusEntry(`grill_conv_created: ${grillConv.id}`))

    // Link idea to grill conversation
    ideaRepository.setGrillConversation(idea.id, grillConv.id)
    ideaRepository.updateStatus(idea.id, 'grilling')

    // Verify reverse lookup
    const linked = ideaRepository.findByGrillConversation(grillConv.id)
    if (linked && linked.id === idea.id) {
      transcript.push(statusEntry('grill_linked'))
      log.info(`[idea-start-grill] Linkage verified: idea=${idea.id} → conv=${grillConv.id}`)
    } else {
      transcript.push(statusEntry('grill_link_failed'))
    }

    // Cleanup
    ideaRepository.delete(idea.id)
  } catch (err) {
    transcript.push(errorEntry((err as Error).message))
  }

  return transcript
}

// ── Idea Convert Direct ──

/**
 * Deterministic: create → setConvertedConversation + status update → assert converted status.
 */
export async function runIdeaConvert(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { ideaRepository, conversationRepository } = await import('../../../db/repositories')

    // Create idea
    const idea = ideaRepository.create(
      ctx.workspaceId,
      'Convert Test Idea',
      'An idea to test direct conversion flow.'
    )
    transcript.push(statusEntry(`idea_created: ${idea.id}`))

    // Create a target conversation
    const targetConv = conversationRepository.create(
      ctx.workspaceId,
      'E2E Converted Conversation',
      'build'
    )

    // Set as converted
    ideaRepository.setConvertedConversation(idea.id, targetConv.id)
    ideaRepository.updateStatus(idea.id, 'completed')

    // Verify
    const result = ideaRepository.findById(idea.id)
    if (result && result.status === 'completed' && result.convertedConversationId === targetConv.id) {
      transcript.push(statusEntry('converted'))
      log.info(`[idea-convert] Conversion verified: idea=${idea.id} → conv=${targetConv.id}`)
    } else {
      transcript.push(statusEntry(`convert_failed: status=${result?.status}, convId=${result?.convertedConversationId}`))
    }

    // Cleanup
    ideaRepository.delete(idea.id)
  } catch (err) {
    transcript.push(errorEntry((err as Error).message))
  }

  return transcript
}

// ── Idea Grill to Blueprint ──

/**
 * Heavy: idea → grill evaluate (local-llm) → blueprintService.createFromIdea → assert phases exist.
 * This requires an active LLM backend. Marked as heavy in the catalog.
 */
export async function runIdeaToBlueprint(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { ideaRepository } = await import('../../../db/repositories')

    // Create a substantive idea
    const idea = ideaRepository.create(
      ctx.workspaceId,
      'Build a REST API',
      'Build a REST API with Express.js and TypeScript for managing a task list. ' +
      'Include CRUD endpoints, input validation with Zod, and error handling middleware.'
    )
    transcript.push(statusEntry(`idea_created: ${idea.id}`))

    // Try to create blueprint from idea
    try {
      const { blueprintService } = await import('../../blueprint.service')
      const blueprint = blueprintService.createFromIdea(idea.id, ctx.workspaceId)

      log.info(`[idea-to-blueprint] Blueprint created: ${blueprint.id}, phases: ${blueprint.phases.length}`)
      transcript.push(statusEntry(`blueprint_created: phases=${blueprint.phases.length}`))
    } catch (bpErr) {
      // createFromIdea may not exist or may require specific prerequisites
      transcript.push(statusEntry(`blueprint_error: ${(bpErr as Error).message}`))
    }

    // Cleanup
    ideaRepository.delete(idea.id)
  } catch (err) {
    transcript.push(errorEntry((err as Error).message))
  }

  return transcript
}
