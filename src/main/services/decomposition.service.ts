import type {
  ConversationMode,
  CostPreference,
  DecomposedTask,
  HandoffBrief,
  InvestigationDepth,
  TaskPlan
} from '../../shared/types'
import { DEFAULT_COST_PREFERENCE } from '../../shared/constants'
import { generalistLogger } from '../logger'
import { SDKExecutor } from './sdk-executor'
import { promptBuilder } from './prompt-builder'
import { modelConfigService } from './model-config.service'
import { eventLoggerService } from './event-logger.service'
import { enrichTasksWithComplexity } from './complexity-scorer.service'
import { enrichFilesDiscussed } from './mcp-server.service'
import { codeGraphService } from './code-graph.service'
import { vectorSearchService } from './vector-search.service'
import { parseDecompositionResult as parseDecompositionResultUtil } from './generalist-utils'
import {
  conversationSpecialistRepository,
  specialistRepository,
  workspaceRepository
} from '../db/repositories'

/**
 * Handles task decomposition — extracting multi-specialist task planning from GeneralistService.
 *
 * Responsibilities:
 * - File enrichment via code graph + semantic search
 * - Fast path: single specialist → skip LLM decomposition
 * - Full path: multi-specialist → decompose via LLM
 * - Build decomposition inputs (specialist list, context blocks)
 * - Parse and validate decomposition results
 * - Complexity scoring and model selection
 */
export class DecompositionService {
  private readonly log = generalistLogger

  async decompose(
    brief: HandoffBrief,
    conversationId: string,
    mode: ConversationMode,
    context: {
      workspacePath: string
      workspaceId: string | null
      repomapEnabled: boolean
      semanticSearchEnabled: boolean
    }
  ): Promise<TaskPlan> {
    const { workspacePath, workspaceId, repomapEnabled, semanticSearchEnabled } = context

    // ── Code Graph + Semantic Search: enrich filesDiscussed ──
    if (repomapEnabled || semanticSearchEnabled) {
      try {
        const sources: { source: string; files: string[]; priority: number }[] = [
          { source: 'generalist', files: brief.filesDiscussed, priority: 0 }
        ]

        if (repomapEnabled && workspaceId) {
          const repomapFiles = await codeGraphService.getTopRankedFiles(
            workspaceId,
            brief.filesDiscussed,
            50
          )
          if (repomapFiles.length > 0) {
            sources.push({ source: 'repomap', files: repomapFiles, priority: 1 })
          }
        }

        if (semanticSearchEnabled && workspaceId) {
          try {
            const semanticResults = await vectorSearchService.search(
              workspaceId,
              brief.summary,
              { nResults: 10 }
            )
            if (semanticResults.length > 0) {
              const semanticFiles = semanticResults.map((r) => r.filePath)
              sources.push({ source: 'semantic', files: semanticFiles, priority: 2 })
            }
          } catch (semanticError) {
            this.log.warn(
              '[PIPELINE:semantic-enrich] Failed — skipping semantic enrichment:',
              semanticError
            )
          }
        }

        if (sources.length > 1) {
          const originalCount = brief.filesDiscussed.length
          const { files, contributions } = enrichFilesDiscussed(sources)
          brief.filesDiscussed = files
          const contribStr = Object.entries(contributions)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ')
          this.log.info(
            `[PIPELINE:file-enrich] ${originalCount} → ${files.length} files (${contribStr})`
          )
        }
      } catch (error) {
        this.log.warn('[PIPELINE:file-enrich] Failed — using original filesDiscussed:', error)
      }
    }

    // ── FAST PATH: single specialist → skip decomposition LLM call entirely ──
    if (brief.specialists.length === 1) {
      return this.fastPathDecompose(brief, conversationId, mode, workspacePath)
    }

    // ── FULL PATH: multi-specialist → decompose via LLM ──
    return this.fullPathDecompose(brief, conversationId, mode, workspacePath)
  }

  /**
   * Single-specialist fast path — skip decomposition LLM call entirely.
   * When the handoff names exactly 1 specialist, decomposition is a no-op
   * (it would just return 1 task). Save ~2K tokens + 3-5s latency.
   */
  private async fastPathDecompose(
    brief: HandoffBrief,
    conversationId: string,
    mode: ConversationMode,
    workspacePath: string
  ): Promise<TaskPlan> {
    this.log.info(
      `Single-specialist fast path: skipping decomposition for ${brief.specialists[0]}`
    )

    const syntheticTask: DecomposedTask = {
      id: 't1',
      specialist: brief.specialists[0],
      description: brief.summary,
      dependsOn: [],
      verificationCommand: 'npm run typecheck'
    }

    // Enrich with complexity scoring
    const settings = workspaceRepository.getSettingsByPath(workspacePath) ?? {}
    const costPreference = (settings.costPreference as CostPreference) || DEFAULT_COST_PREFERENCE
    const enrichedTasks = enrichTasksWithComplexity([syntheticTask], costPreference)

    eventLoggerService.logDecompositionStarted({
      conversationId,
      summary: brief.summary,
      specialists: brief.specialists
    })
    eventLoggerService.logDecompositionCompleted({
      conversationId,
      taskCount: 1,
      tasks: enrichedTasks.map((t) => ({
        id: t.id,
        specialist: t.specialist,
        model: t.model
      }))
    })

    this.log.info(
      `  ${enrichedTasks[0].id}: ${enrichedTasks[0].complexity?.tier}/${enrichedTasks[0].model} (score: ${enrichedTasks[0].complexity?.total}) [fast-path]`
    )

    // Strategy 13: Pre-select investigation depth based on question complexity.
    const filesCount = brief.filesDiscussed?.length ?? 0
    const summaryLower = brief.summary.toLowerCase()
    const needsDeepInvestigation =
      summaryLower.includes('audit') ||
      summaryLower.includes('comprehensive') ||
      summaryLower.includes('all files') ||
      summaryLower.includes('across the codebase') ||
      filesCount > 3
    const suggestedDepth = needsDeepInvestigation ? 'standard' : 'quick'
    this.log.info(`[PIPELINE:depth-preselect] files=${filesCount} suggested=${suggestedDepth}`)

    return {
      conversationId,
      summary: brief.summary,
      mode,
      tasks: enrichedTasks,
      brief,
      investigationDepth: suggestedDepth as InvestigationDepth
    }
  }

  /**
   * Full multi-specialist decomposition via LLM call.
   */
  private async fullPathDecompose(
    brief: HandoffBrief,
    conversationId: string,
    mode: ConversationMode,
    workspacePath: string
  ): Promise<TaskPlan> {
    const { prompt } = this.buildDecompositionInputs(brief, mode, conversationId)

    this.log.info('Decomposing task for specialists:', brief.specialists.join(', '))

    eventLoggerService.logDecompositionStarted({
      conversationId,
      summary: brief.summary,
      specialists: brief.specialists
    })

    const executor = new SDKExecutor()
    try {
      const { result } = await executor.executeAndCollect({
        prompt,
        systemPrompt: promptBuilder.getDecompositionPrompt(mode),
        model: modelConfigService.getModel(workspacePath, 'generalist'),
        cwd: workspacePath,
        permissionMode: 'plan',
        allowedTools: [],
        outputFormat: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              tasks: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    specialist: { type: 'string' },
                    description: { type: 'string' },
                    dependsOn: { type: 'array', items: { type: 'string' } },
                    complexity: { type: 'number' },
                    model: { type: 'string', enum: ['haiku', 'sonnet', 'opus'] },
                    verificationCommand: { type: 'string' }
                  },
                  required: ['id', 'specialist', 'description']
                }
              }
            },
            required: ['tasks']
          }
        }
      })

      return this.parseDecompositionResult(result, conversationId, brief, mode, workspacePath)
    } catch (error) {
      eventLoggerService.logDecompositionFailed({
        conversationId,
        error: (error as Error).message,
        fallback: 'none'
      })
      throw error
    }
  }

  private buildDecompositionInputs(
    brief: HandoffBrief,
    mode?: ConversationMode,
    conversationId?: string
  ): { prompt: string; specialistList: string } {
    const globallyActiveSpecialists = specialistRepository.findActive()
    let activeSpecialists = globallyActiveSpecialists

    if (conversationId) {
      const overrides = conversationSpecialistRepository.findByConversation(conversationId)
      if (overrides.length > 0) {
        const activeSpecialistIds = new Set(
          overrides.filter((override) => override.isActive).map((override) => override.specialistId)
        )
        activeSpecialists = globallyActiveSpecialists.filter((specialist) =>
          activeSpecialistIds.has(specialist.id)
        )
      }
    }

    const relevantSpecialists =
      brief.specialists.length > 0
        ? activeSpecialists.filter(
            (s) => brief.specialists.includes(s.agentId) || brief.specialists.includes(s.id)
          )
        : activeSpecialists

    const specialistList = relevantSpecialists
      .map(
        (s) =>
          `- "${s.agentId}" — ${s.displayName}: ${s.prompt?.substring(0, 150) || 'General specialist'}`
      )
      .join('\n')

    // ── Build rich context for decomposition ──
    const decisionsBlock =
      brief.decisions.length > 0
        ? `\nKey decisions already made:\n${brief.decisions.map((d) => `- ${d}`).join('\n')}`
        : ''

    const constraintsBlock =
      brief.constraints.length > 0
        ? `\nConstraints to respect:\n${brief.constraints.map((c) => `- ${c}`).join('\n')}`
        : ''

    const filesBlock =
      brief.filesDiscussed.length > 0
        ? `\nFiles discussed/planned:\n${brief.filesDiscussed.map((f) => `- ${f}`).join('\n')}`
        : ''

    // Strategy 5: Truncate recentMessages to prevent unbounded context in decomposition.
    const MAX_CONVERSATION_CHARS = 3000
    const rawConversation =
      brief.recentMessages.length > 0
        ? brief.recentMessages.map((m) => `[${m.role}]: ${m.content}`).join('\n---\n')
        : ''
    const conversationBlock = rawConversation
      ? `\nRecent conversation context:\n${rawConversation.length > MAX_CONVERSATION_CHARS ? rawConversation.substring(rawConversation.length - MAX_CONVERSATION_CHARS) + '\n[... earlier messages truncated]' : rawConversation}`
      : ''

    const modeInstruction =
      mode === 'plan'
        ? '\n\nIMPORTANT: This is a PLAN-MODE decomposition. Create investigation/analysis tasks. Every task description MUST end with "Produce a structured investigation report." If the analysis reveals a clear fix, include it as a proposed-fix recommendation in the report — but do NOT create separate implementation tasks.'
        : '\n\nIMPORTANT: This is a BUILD-MODE decomposition. Create IMPLEMENTATION tasks that write code, modify files, and make changes. Use action verbs: implement, fix, create, refactor, update, add. Do NOT create investigation-only tasks — the user wants code changes, not reports. Include verificationCommand for each task (e.g., "npm run typecheck").'

    const prompt = `Think step by step about the dependencies and potential file conflicts before decomposing.

Task to decompose: "${brief.summary}"
${modeInstruction}
${decisionsBlock}
${constraintsBlock}
${filesBlock}
${conversationBlock}

Available specialists:
${specialistList}

Decompose this task into sub-tasks and respond with ONLY valid JSON.`

    return { prompt, specialistList }
  }

  private parseDecompositionResult(
    result: string,
    conversationId: string,
    brief: HandoffBrief,
    mode: ConversationMode,
    workspacePath: string
  ): TaskPlan {
    // Keep parsed JSON preview for parity with existing parse-error logging.
    let jsonPreview = result
    const previewFenceMatch = jsonPreview.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (previewFenceMatch) {
      jsonPreview = previewFenceMatch[1].trim()
    }

    try {
      const taskPlan = parseDecompositionResultUtil(
        result,
        conversationId,
        brief,
        mode,
        (tasks: DecomposedTask[]) => {
          // Preserve previous behavior: ignore any model field from raw LLM JSON.
          const normalizedTasks = tasks.map((task) => ({
            ...task,
            model: undefined
          }))

          // Read workspace cost preference and enrich tasks with validated complexity scores
          const settings = workspaceRepository.getSettingsByPath(workspacePath) ?? {}
          const costPreference =
            (settings.costPreference as CostPreference) || DEFAULT_COST_PREFERENCE

          const enrichedTasks = enrichTasksWithComplexity(normalizedTasks, costPreference)

          this.log.info(`Decomposed into ${enrichedTasks.length} tasks (cost: ${costPreference})`)
          for (const t of enrichedTasks) {
            this.log.info(
              `  ${t.id}: ${t.complexity?.tier}/${t.model} (score: ${t.complexity?.total})`
            )
          }

          return enrichedTasks
        }
      )

      // ── Event: decomposition completed ──
      eventLoggerService.logDecompositionCompleted({
        conversationId,
        taskCount: taskPlan.tasks.length,
        tasks: taskPlan.tasks.map((t) => ({
          id: t.id,
          specialist: t.specialist,
          model: t.model
        }))
      })

      return taskPlan
    } catch (error) {
      const originalError =
        error instanceof Error ? error.message : 'Task decomposition returned no tasks'
      const normalizedError =
        originalError === 'Task decomposition response missing tasks array'
          ? 'Task decomposition returned no tasks'
          : originalError

      if (normalizedError === 'Failed to parse task decomposition — LLM returned invalid JSON') {
        this.log.error('Failed to parse decomposition JSON:', jsonPreview.substring(0, 500))
      }

      eventLoggerService.logDecompositionFailed({
        conversationId,
        error: normalizedError,
        fallback: 'none'
      })
      throw new Error(normalizedError)
    }
  }
}

export const decompositionService = new DecompositionService()
