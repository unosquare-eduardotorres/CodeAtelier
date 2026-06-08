/**
 * PrimingContextGatherer — collects workspace context for session priming.
 *
 * Gathers recent git changes, active plan state, and relevant workspace memories
 * to inject before the first prompt so the session starts warm. Each source is
 * independently testable.
 *
 * Extracted from AgentSessionService.buildPrimingContext.
 */

import { workspaceRepository, memoryRepository } from '../db/repositories'
import { localPlanStateService } from './local-plan-state.service'

type PrimingPart = { type: 'text'; text: string }

export class PrimingContextGatherer {
  /**
   * Build priming context for a new session.
   * Returns an array of text parts that can be injected before the first prompt.
   */
  async gather(opts: {
    workspaceId: string | null
    workspacePath: string | null
    conversationId: string | null
    userPrompt: string
  }): Promise<PrimingPart[]> {
    const { workspaceId, workspacePath, conversationId, userPrompt } = opts

    // Check feature flag — gate priming for independent testing
    try {
      if (workspaceId) {
        const settings = workspaceRepository.getSettings(workspaceId)
        if (settings.contextPrimingEnabled === false) {
          return []
        }
      }
    } catch {
      /* non-fatal */
    }

    const parts: PrimingPart[] = []

    const [gitPart, planPart, memoryPart] = await Promise.all([
      this.gatherRecentGitChanges(workspacePath),
      this.gatherActivePlanState(conversationId),
      this.gatherWorkspaceMemories(workspaceId, userPrompt)
    ])

    if (gitPart) parts.push(gitPart)
    if (planPart) parts.push(planPart)
    if (memoryPart) parts.push(memoryPart)

    return parts
  }

  /**
   * 1. Recent git changes (last 3 commits diff stat).
   */
  private async gatherRecentGitChanges(workspacePath: string | null): Promise<PrimingPart | null> {
    if (!workspacePath) return null
    try {
      const { execSync } = await import('node:child_process')
      const gitDiff = execSync('git diff --stat HEAD~3 2>/dev/null || true', {
        cwd: workspacePath,
        timeout: 5000,
        encoding: 'utf-8',
        maxBuffer: 10_000
      }).trim()

      if (gitDiff && gitDiff.length > 10) {
        return {
          type: 'text',
          text: `[Workspace Context: Recent Changes]\n${gitDiff}`
        }
      }
    } catch {
      /* git not available or no commits — non-fatal */
    }
    return null
  }

  /**
   * 2. Active plan state (if any conversation has a plan in progress).
   */
  private async gatherActivePlanState(conversationId: string | null): Promise<PrimingPart | null> {
    if (!conversationId) return null
    try {
      const planState = localPlanStateService.getForConversation(conversationId)
      if (planState?.planText) {
        const planText = planState.planText
        const planSummary =
          planText.length > 2000 ? planText.slice(0, 2000) + '\n[...truncated]' : planText
        return {
          type: 'text',
          text: `[Workspace Context: Active Plan]\n${planSummary}`
        }
      }
    } catch {
      /* plan service not available — non-fatal */
    }
    return null
  }

  /**
   * 3. Top relevant workspace memories matching the user's prompt topic.
   */
  private async gatherWorkspaceMemories(
    workspaceId: string | null,
    userPrompt: string
  ): Promise<PrimingPart | null> {
    if (!workspaceId) return null
    try {
      const memories = memoryRepository.search(workspaceId, userPrompt.slice(0, 100))
      const topMemories = memories.slice(0, 5)
      if (topMemories.length > 0) {
        const memoryText = topMemories.map((m) => `- [${m.type}] ${m.content}`).join('\n')
        return {
          type: 'text',
          text: `[Workspace Context: Relevant Memories]\n${memoryText}`
        }
      }
    } catch {
      /* memory service not available — non-fatal */
    }
    return null
  }
}

/** Singleton instance */
export const primingContextGatherer = new PrimingContextGatherer()
