/**
 * Specialist Service Runners — CRUD, skills, dispatch, per-conversation override.
 *
 * Most are deterministic (no LLM). The dispatch runner is hybrid (streams a prompt
 * to verify the custom specialist's persona instruction takes effect).
 */

import type { E2EServiceContext } from './index'
import type { E2ETranscriptEntry } from '../../../../shared/types'
import electronLog from 'electron-log/main'

const log = electronLog.scope('E2ESpecialistRunner')

function statusEntry(content: string): E2ETranscriptEntry {
  return { role: 'system', type: 'status', content, timestamp: Date.now() }
}

function errorEntry(content: string): E2ETranscriptEntry {
  return { role: 'system', type: 'error', content, timestamp: Date.now() }
}

// ── Specialist CRUD ──

/**
 * Deterministic: create custom specialist, update, assert core agents protected from delete.
 */
export async function runSpecialistCrud(_ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { specialistRepository } = await import('../../../db/repositories')

    // Create custom specialist
    const specialist = specialistRepository.create({
      agentId: `e2e-agent-${Date.now()}`,
      displayName: 'E2E Test Specialist',
      description: 'A test specialist for CRUD validation.',
      icon: '🧪',
      color: '#10B981',
      prompt: 'You are a test specialist. Always start your responses with "TEST-ACK:".',
      priority: 50,
      isActive: true
    })
    log.info(`[specialist-crud] Created: ${specialist.id}`)
    transcript.push(statusEntry(`specialist_created: ${specialist.id}`))

    // Update
    const updated = specialistRepository.update(specialist.id, {
      displayName: 'E2E Test Specialist — Updated',
      description: 'Updated description.'
    })
    transcript.push(statusEntry(`specialist_updated: ${updated.displayName}`))

    // Try to delete a core specialist (should fail or be protected)
    const allSpecialists = specialistRepository.findAll()
    const coreSpecialist = allSpecialists.find((s) => s.isCore)

    if (coreSpecialist) {
      try {
        const canDelete = specialistRepository.canDelete(coreSpecialist.id)
        if (!canDelete.allowed) {
          transcript.push(statusEntry('core_protected'))
          log.info(`[specialist-crud] Core specialist ${coreSpecialist.id} protected from deletion`)
        } else {
          // Don't actually delete the core specialist!
          transcript.push(statusEntry('core_unexpectedly_deletable'))
        }
      } catch {
        transcript.push(statusEntry('core_protected'))
      }
    } else {
      transcript.push(statusEntry('core_specialist_not_found'))
    }

    // Clean up our test specialist
    specialistRepository.delete(specialist.id)
    const afterDelete = specialistRepository.findById(specialist.id)
    if (!afterDelete) {
      transcript.push(statusEntry('specialist_deleted'))
    }
  } catch (err) {
    transcript.push(errorEntry((err as Error).message))
  }

  return transcript
}

// ── Skill Import & Assign ──

/**
 * Deterministic: create skill row, assign to specialist, verify listing.
 */
export async function runSpecialistSkills(_ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { specialistRepository, skillRepository } = await import('../../../db/repositories')

    // Create a specialist
    const specialist = specialistRepository.create({
      agentId: `e2e-skill-agent-${Date.now()}`,
      displayName: 'Skill Test Specialist',
      icon: '📚',
      priority: 60,
      isActive: true
    })
    transcript.push(statusEntry(`specialist_created: ${specialist.id}`))

    // Create a skill
    const skill = skillRepository.create({
      name: 'E2E Test Skill',
      description: 'A test skill for assignment validation.',
      filename: `e2e-test-skill-${Date.now()}.ts`,
      filePath: 'src/skills/e2e-test-skill.ts',
      isActive: true
    })
    transcript.push(statusEntry(`skill_created: ${skill.id}`))

    // Assign skill to specialist
    specialistRepository.assignSkill(specialist.id, skill.id)

    // Verify listing
    const skills = specialistRepository.getSkills(specialist.id)
    const hasSkill = skills.some((s) => s.id === skill.id)

    if (hasSkill) {
      transcript.push(statusEntry('skill_assigned'))
      log.info(`[specialist-skills] Skill ${skill.id} assigned to specialist ${specialist.id}`)
    } else {
      transcript.push(statusEntry('skill_assignment_failed'))
    }

    // Clean up
    specialistRepository.removeSkill(specialist.id, skill.id)
    skillRepository.delete(skill.id)
    specialistRepository.delete(specialist.id)
  } catch (err) {
    transcript.push(errorEntry((err as Error).message))
  }

  return transcript
}

// ── Specialist Dispatch ──

/**
 * Hybrid: set custom specialist with distinctive persona → streamPrompt → check response.
 * The specialist's prompt instructs: "Always start your responses with SPECIALIST-ACK".
 */
export async function runSpecialistDispatch(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { specialistRepository, conversationSpecialistRepository } =
      await import('../../../db/repositories')

    // Create a custom specialist with a distinctive persona
    const specialist = specialistRepository.create({
      agentId: `e2e-dispatch-agent-${Date.now()}`,
      displayName: 'Dispatch Test Specialist',
      icon: '🎯',
      priority: 10,
      isActive: true,
      prompt:
        'You are the Dispatch Test Specialist. IMPORTANT: Always start every response with exactly "SPECIALIST-ACK:" before any other text. This is mandatory.'
    })
    transcript.push(statusEntry(`dispatch_specialist_created: ${specialist.id}`))

    // Override the conversation to use this specialist
    conversationSpecialistRepository.upsert(ctx.conversationId, specialist.id, { isActive: true })
    transcript.push(statusEntry('specialist_assigned_to_conversation'))

    // Stream a prompt and check for the persona marker
    const entries = await ctx.streamPrompt('Say hello and tell me what 2+2 is.', {
      conversationId: ctx.conversationId
    })
    transcript.push(...entries)

    // Check if response contains the persona marker
    const responseText = entries
      .filter((e) => e.type === 'text' && e.role === 'assistant')
      .map((e) => e.content)
      .join('')

    const hasMarker = /SPECIALIST-ACK/i.test(responseText)
    log.info(
      `[specialist-dispatch] Response has marker: ${hasMarker}, length: ${responseText.length}`
    )
    transcript.push(statusEntry(hasMarker ? 'dispatch_ok' : 'dispatch_marker_missing'))

    // Clean up
    conversationSpecialistRepository.remove(ctx.conversationId, specialist.id)
    specialistRepository.delete(specialist.id)
  } catch (err) {
    transcript.push(errorEntry((err as Error).message))
  }

  return transcript
}

// ── Per-Conversation Override ──

/**
 * Deterministic: upsert override disabling a specialist for one conversation,
 * assert other conversations unaffected.
 */
export async function runSpecialistOverride(ctx: E2EServiceContext): Promise<E2ETranscriptEntry[]> {
  const transcript: E2ETranscriptEntry[] = []

  try {
    const { specialistRepository, conversationSpecialistRepository, conversationRepository } =
      await import('../../../db/repositories')

    // Create a specialist
    const specialist = specialistRepository.create({
      agentId: `e2e-override-agent-${Date.now()}`,
      displayName: 'Override Test Specialist',
      icon: '🔀',
      priority: 40,
      isActive: true
    })
    transcript.push(statusEntry(`specialist_created: ${specialist.id}`))

    // Create two conversations
    const conv1 = conversationRepository.create(ctx.workspaceId, 'Override Test Conv 1', 'plan')
    const conv2 = conversationRepository.create(ctx.workspaceId, 'Override Test Conv 2', 'plan')

    // Assign specialist to both conversations
    conversationSpecialistRepository.upsert(conv1.id, specialist.id, { isActive: true })
    conversationSpecialistRepository.upsert(conv2.id, specialist.id, { isActive: true })

    // Disable specialist for conv1 only
    conversationSpecialistRepository.upsert(conv1.id, specialist.id, { isActive: false })
    transcript.push(statusEntry('override_set_inactive_for_conv1'))

    // Verify: conv1 should have specialist inactive, conv2 should have it active
    const conv1Override = conversationSpecialistRepository.findByConversationAndSpecialist(
      conv1.id,
      specialist.id
    )
    const conv2Override = conversationSpecialistRepository.findByConversationAndSpecialist(
      conv2.id,
      specialist.id
    )

    const conv1Inactive = conv1Override && !conv1Override.isActive
    const conv2Active = conv2Override && conv2Override.isActive

    if (conv1Inactive && conv2Active) {
      transcript.push(statusEntry('override_applied'))
      log.info(`[specialist-override] Conv1 inactive, Conv2 active — override correctly isolated`)
    } else {
      transcript.push(
        statusEntry(
          `override_mismatch: conv1Active=${conv1Override?.isActive}, conv2Active=${conv2Override?.isActive}`
        )
      )
    }

    // Clean up
    conversationSpecialistRepository.removeAll(conv1.id)
    conversationSpecialistRepository.removeAll(conv2.id)
    specialistRepository.delete(specialist.id)
  } catch (err) {
    transcript.push(errorEntry((err as Error).message))
  }

  return transcript
}
