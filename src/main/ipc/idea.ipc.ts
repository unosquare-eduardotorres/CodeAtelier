import { ipcMain } from 'electron'
import log from 'electron-log'
import { IPC_CHANNELS } from '../../shared/constants'
import type { Idea, LLMProvider } from '../../shared/types'
import {
  ideaRepository,
  conversationRepository,
  workspaceRepository,
  grillSessionRepository
} from '../db/repositories'
import { buildConversationModelSnapshot } from '../services/model-config.service'
import { memoryFactRepository } from '../db/repositories/memory-fact.repository'
import { memoryExtractionService } from '../services/memory-extraction.service'
import { validateSender } from './validate-sender'
import { requireObject, requireString, optionalString } from './validate-args'

const ideaLog = log.scope('idea-ipc')

/**
 * Sync a completed idea into the knowledge-aware memory engine.
 * Creates a consolidated 'decision' fact with grill decisions, track scores,
 * and summary. Enqueues LLM extraction over the plan for granular facts.
 *
 * MEM-GRILL-01: Reads grill_decisions and session data BEFORE grill:complete
 * strips them (ordering guarantee: idea:completeFromGrill fires before grill:complete).
 */
function syncIdeaToMemory(idea: Idea): void {
  if (idea.status !== 'completed') return

  // Gate behind captureGrill setting (default ON)
  const wsSettings = workspaceRepository.getSettings(idea.workspaceId)
  const grillCaptureEnabled = (wsSettings as any).memoryCaptureGrill !== false
  if (!grillCaptureEnabled) return

  const ideaTag = `idea:${idea.id}`
  const existing = memoryFactRepository
    .search(idea.workspaceId, idea.title, 5)
    .filter((f) => f.tags.includes(ideaTag))

  // Build enriched content with grill decisions + track scores
  const contentParts = [idea.description]

  // Parse grill decisions (Q→A pairs per track)
  if (idea.grillDecisions) {
    try {
      const decisions = JSON.parse(idea.grillDecisions)
      if (decisions && typeof decisions === 'object') {
        const decisionLines: string[] = []
        for (const [key, value] of Object.entries(decisions)) {
          if (typeof value === 'string') {
            decisionLines.push(`- **${key}**: ${value}`)
          } else if (value && typeof value === 'object') {
            decisionLines.push(`- **${key}**: ${JSON.stringify(value)}`)
          }
        }
        if (decisionLines.length > 0) {
          contentParts.push(`\n### Grill Decisions\n${decisionLines.join('\n')}`)
        }
      }
    } catch {
      // Malformed JSON — skip decisions
    }
  }

  // Read grill session for track scores and plan
  const grillSession = grillSessionRepository.findByIdeaId(idea.id)
  if (grillSession) {
    // Track scores
    if (Array.isArray(grillSession.trackScores) && grillSession.trackScores.length > 0) {
      const scoreLines = grillSession.trackScores.map((ts: any) =>
        `- ${ts.trackId ?? ts.track ?? 'unknown'}: ${ts.score ?? ts.value ?? '?'}/10`
      )
      contentParts.push(`\n### Track Scores\n${scoreLines.join('\n')}`)
    }
    if (grillSession.currentScore != null) {
      contentParts.push(`\n**Final Score**: ${grillSession.currentScore}/10 (${grillSession.scoreLabel ?? 'unrated'})`)
    }
  }

  if (idea.grillSummary) {
    contentParts.push(`\n### Grill Summary\n${idea.grillSummary}`)
  }
  const content = contentParts.filter(Boolean).join('\n')

  // Write/update the consolidated decision fact
  if (existing.length > 0) {
    memoryFactRepository.updateFact(existing[0].id, {
      title: `Idea: ${idea.title}`,
      content,
      tags: ['idea', 'grill', ideaTag]
    })
  } else {
    memoryFactRepository.createFact({
      workspaceId: idea.workspaceId,
      category: 'decision',
      title: `Idea: ${idea.title}`,
      content,
      tags: ['idea', 'grill', ideaTag],
      sourceType: 'grill',
      sourceRef: idea.id
    })
  }

  // Enqueue LLM extraction over the grill plan for granular facts
  // (risks, constraints, implementation decisions)
  if (grillSession?.plan) {
    const workspace = workspaceRepository.findById(idea.workspaceId)
    if (workspace?.repoPath) {
      const planText = JSON.stringify(grillSession.plan, null, 2)
      memoryExtractionService.enqueue(async () => {
        try {
          await memoryExtractionService.extractFromContent(
            idea.workspaceId,
            workspace.repoPath,
            `grill-plan:${idea.id}`,
            `## Grill Plan for "${idea.title}"\n\n${planText.substring(0, 40000)}`,
            undefined,
            { sourceType: 'grill', tags: ['grill', 'plan', ideaTag] }
          )
        } catch (err) {
          ideaLog.warn(`[syncIdeaToMemory] LLM extraction for grill plan failed: ${err}`)
        }
      })
    }
  }
}

/**
 * Remove the fact linked to a deleted idea.
 */
function removeIdeaMemory(idea: Idea): void {
  const ideaTag = `idea:${idea.id}`
  const existing = memoryFactRepository
    .search(idea.workspaceId, idea.title, 5)
    .filter((f) => f.tags.includes(ideaTag))
  for (const fact of existing) {
    memoryFactRepository.archiveFact(fact.id)
  }
}

export function registerIdeaIpc(): void {
  // idea:list — returns all ideas for a workspace
  ipcMain.handle(IPC_CHANNELS.IDEA_LIST, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.IDEA_LIST)
    const workspaceId = requireString(args, 'workspaceId', IPC_CHANNELS.IDEA_LIST)
    return ideaRepository.findByWorkspace(workspaceId)
  })

  // idea:create — create a new idea
  ipcMain.handle(IPC_CHANNELS.IDEA_CREATE, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.IDEA_CREATE)
    const workspaceId = requireString(args, 'workspaceId', IPC_CHANNELS.IDEA_CREATE)
    const title = requireString(args, 'title', IPC_CHANNELS.IDEA_CREATE)
    const description = optionalString(args, 'description', IPC_CHANNELS.IDEA_CREATE) ?? ''
    const idea = ideaRepository.create(workspaceId, title.trim(), description.trim())
    return idea
  })

  // idea:update — update title/description
  ipcMain.handle(IPC_CHANNELS.IDEA_UPDATE, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.IDEA_UPDATE)
    const id = requireString(args, 'id', IPC_CHANNELS.IDEA_UPDATE)
    const title = optionalString(args, 'title', IPC_CHANNELS.IDEA_UPDATE)
    const description = optionalString(args, 'description', IPC_CHANNELS.IDEA_UPDATE)
    const updated = ideaRepository.update(id, { title, description })
    return updated
  })

  // idea:delete — delete an idea
  ipcMain.handle(IPC_CHANNELS.IDEA_DELETE, (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.IDEA_DELETE)
    const id = requireString(args, 'id', IPC_CHANNELS.IDEA_DELETE)
    const idea = ideaRepository.findById(id)
    ideaRepository.delete(id)
    if (idea) removeIdeaMemory(idea)
  })

  // idea:startGrill — create/resume a grill conversation for this idea
  ipcMain.handle(IPC_CHANNELS.IDEA_START_GRILL, (event, rawArgs: unknown) => {
    validateSender(event)
    const startGrillArgs = requireObject(rawArgs, IPC_CHANNELS.IDEA_START_GRILL)
    const ideaId = requireString(startGrillArgs, 'ideaId', IPC_CHANNELS.IDEA_START_GRILL)
    const workspaceId = requireString(startGrillArgs, 'workspaceId', IPC_CHANNELS.IDEA_START_GRILL)

    const idea = ideaRepository.findById(ideaId)
    if (!idea) throw new Error('Idea not found')

    // If already has a grill conversation, return it (resume)
    if (idea.grillConversationId) {
      const conv = conversationRepository.findById(idea.grillConversationId)
      if (conv) return { idea, conversation: conv }
    }

    // Read workspace LLM provider for conversation creation
    const wsSettings = workspaceRepository.getSettings(workspaceId)
    const llmProvider: LLMProvider = wsSettings.llmProvider ?? 'claude'
    const snapshot = buildConversationModelSnapshot(workspaceId, llmProvider)

    // Create a new conversation for the grill session
    const conv = conversationRepository.create(
      workspaceId,
      `💡 Grill: ${idea.title}`,
      'plan',
      undefined,
      llmProvider,
      undefined,
      undefined,
      undefined,
      snapshot
    )

    // Link it to the idea and update status
    ideaRepository.setGrillConversation(ideaId, conv.id)
    const updated = ideaRepository.updateStatus(ideaId, 'grilling')

    return { idea: updated, conversation: conv }
  })

  // idea:convertDirect — create a work item conversation from idea
  ipcMain.handle(IPC_CHANNELS.IDEA_CONVERT_DIRECT, (event, rawArgs: unknown) => {
    validateSender(event)
    const convertArgs = requireObject(rawArgs, IPC_CHANNELS.IDEA_CONVERT_DIRECT)
    const ideaId = requireString(convertArgs, 'ideaId', IPC_CHANNELS.IDEA_CONVERT_DIRECT)
    const workspaceId = requireString(convertArgs, 'workspaceId', IPC_CHANNELS.IDEA_CONVERT_DIRECT)

    const idea = ideaRepository.findById(ideaId)
    if (!idea) throw new Error('Idea not found')

    // Read workspace LLM provider for conversation creation
    const wsSettingsDirect = workspaceRepository.getSettings(workspaceId)
    const llmProviderDirect: LLMProvider = wsSettingsDirect.llmProvider ?? 'claude'
    const snapshotDirect = buildConversationModelSnapshot(workspaceId, llmProviderDirect)

    // Create conversation with idea title
    const conv = conversationRepository.create(
      workspaceId,
      idea.title,
      'plan',
      undefined,
      llmProviderDirect,
      undefined,
      undefined,
      undefined,
      snapshotDirect
    )

    // Mark idea as completed
    ideaRepository.setConvertedConversation(ideaId, conv.id)
    const updated = ideaRepository.updateStatus(ideaId, 'completed')

    if (updated) syncIdeaToMemory(updated)
    return { idea: updated, conversation: conv }
  })

  // idea:saveGrillDecisions — save grill iteration state (score, description, history) as JSON
  ipcMain.handle(IPC_CHANNELS.IDEA_SAVE_GRILL_DECISIONS, (event, rawArgs: unknown) => {
    validateSender(event)
    const grillArgs = requireObject(rawArgs, IPC_CHANNELS.IDEA_SAVE_GRILL_DECISIONS)
    const ideaId = requireString(grillArgs, 'ideaId', IPC_CHANNELS.IDEA_SAVE_GRILL_DECISIONS)
    const decisions = requireString(grillArgs, 'decisions', IPC_CHANNELS.IDEA_SAVE_GRILL_DECISIONS)
    return ideaRepository.saveGrillDecisions(ideaId, decisions)
  })

  // idea:completeFromGrill — find the idea linked to a grill conversation and mark completed
  ipcMain.handle(IPC_CHANNELS.IDEA_COMPLETE_FROM_GRILL, (event, rawArgs: unknown) => {
    validateSender(event)
    const completeArgs = requireObject(rawArgs, IPC_CHANNELS.IDEA_COMPLETE_FROM_GRILL)
    const conversationId = requireString(
      completeArgs,
      'conversationId',
      IPC_CHANNELS.IDEA_COMPLETE_FROM_GRILL
    )
    const summary = optionalString(completeArgs, 'summary', IPC_CHANNELS.IDEA_COMPLETE_FROM_GRILL)

    const idea = ideaRepository.findByGrillConversation(conversationId)
    if (!idea) return null

    if (summary) {
      ideaRepository.setGrillSummary(idea.id, summary)
    }
    const updated = ideaRepository.updateStatus(idea.id, 'completed')
    if (updated) {
      // Re-fetch to get the full data including grillSummary set above
      const refreshed = ideaRepository.findById(updated.id)
      if (refreshed) syncIdeaToMemory(refreshed)
    }
    return updated
  })
}
