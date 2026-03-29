import type {
  AgentStatus,
  ConversationMode,
  CostPreference,
  DecomposedTask,
  HandoffBrief,
  TaskPlan
} from '../../shared/types'
import { AGENT_IDS, DEFAULT_COST_PREFERENCE } from '../../shared/constants'
import { orchestratorLogger } from '../logger'
import { specialistRepository, workspaceRepository } from '../db/repositories'
import { enrichTasksWithComplexity } from './complexity-scorer.service'
import { promptBuilder } from './prompt-builder'
import { AgentBaseService } from './agent-base.service'
import { modelConfigService } from './model-config.service'
import { eventLoggerService } from './event-logger.service'
import { SDKExecutor } from './sdk-executor'
import type { SDKExecuteResult } from './sdk-executor'

/** Maximum number of session entries before evicting oldest */
const MAX_SESSION_MAP_SIZE = 100

export class OrchestratorService extends AgentBaseService {
  protected readonly log = orchestratorLogger
  private workspacePath: string | null = null
  private sessionMap: Map<string, string> = new Map()
  private currentConversationId: string | null = null
  /** AbortController for cancelling in-flight SDK queries */
  private sdkAbortController: AbortController | null = null

  /**
   * Initializes the orchestrator for the given workspace.
   * No process is spawned here — each message spawns its own `claude -p` process.
   */
  async start(workspacePath: string): Promise<void> {
    // Stop any active process if running
    if (this.process) {
      await this.stop()
    }

    this.workspacePath = workspacePath
    this.startedAt = Date.now()
    this.currentStatus = 'idle'
    this.buffer = ''
    this.sessionMap.clear()
    this.currentConversationId = null
    this.tokenUsage = 0

    this.log.info('Ready for workspace:', workspacePath)
    this.emit('statusUpdate', this.getStatus())
  }

  /**
   * Sends a message via the Agent SDK.
   * Uses `--resume` with session ID for multi-turn conversation continuity.
   */
  async send(
    message: string,
    conversationId?: string,
    mode: ConversationMode = 'build'
  ): Promise<void> {
    return this.sendViaSDK(message, conversationId, mode)
  }

  /**
   * SDK path — uses Agent SDK query() for streaming.
   * Produces the same StreamChunk events as CLI path, so downstream is unchanged.
   */
  private async sendViaSDK(
    message: string,
    conversationId?: string,
    mode: ConversationMode = 'build'
  ): Promise<void> {
    if (!this.workspacePath) {
      throw new Error('Orchestrator not started — no workspace path set')
    }

    this.currentStatus = 'thinking'
    this.buffer = ''
    this.hasEmittedContent = false
    this.messageStartedAt = Date.now()
    this.processedToolIds.clear()
    this.currentConversationId = conversationId ?? null
    this.emit('statusUpdate', this.getStatus())

    const existingSession = conversationId ? this.sessionMap.get(conversationId) : null
    const systemPrompt = existingSession
      ? undefined
      : promptBuilder.build({
          role: 'orchestrator',
          mode,
          workspacePath: this.workspacePath
        })

    const abortController = new AbortController()
    this.sdkAbortController = abortController

    const executor = new SDKExecutor()
    try {
      for await (const chunk of executor.execute({
        prompt: message,
        systemPrompt: systemPrompt ?? '',
        model: modelConfigService.getModel(this.workspacePath, 'orchestrator'),
        cwd: this.workspacePath,
        permissionMode: mode === 'build' ? 'bypassPermissions' : 'plan',
        allowedTools: ['WebSearch', 'WebFetch'],
        resume: existingSession ?? undefined,
        abortController
      })) {
        if ('_meta' in chunk && chunk._meta) {
          const meta = chunk._meta as SDKExecuteResult
          if (meta.sessionId && conversationId) {
            this.sessionMap.set(conversationId, meta.sessionId)
            this.evictOldSessions()
          }
          this.tokenUsage += meta.tokenUsage.input + meta.tokenUsage.output
        } else {
          this.emit('chunk', chunk) // Same StreamChunk interface — IPC unchanged
        }
      }

      this.sdkAbortController = null
      this.currentStatus = 'idle'
      this.emit('statusUpdate', this.getStatus())
      this.emit('complete')
    } catch (error) {
      this.sdkAbortController = null
      this.log.error('SDK send failed:', error)
      this.emit('chunk', {
        type: 'error',
        error: `Orchestrator SDK error: ${(error as Error).message}`
      })
      this.currentStatus = 'failed'
      this.emit('statusUpdate', this.getStatus())
      this.emit('complete')
    }
  }

  /**
   * Decomposes a handoff brief into structured sub-tasks via the Agent SDK.
   */
  async decompose(
    brief: HandoffBrief,
    conversationId: string,
    mode: ConversationMode
  ): Promise<TaskPlan> {
    return this.decomposeViaSDK(brief, conversationId, mode)
  }

  /**
   * Builds the decomposition prompt and specialist list from a handoff brief.
   */
  private buildDecompositionInputs(brief: HandoffBrief): { prompt: string; specialistList: string } {
    const activeSpecialists = specialistRepository.findActive()
    const relevantSpecialists =
      brief.specialists.length > 0
        ? activeSpecialists.filter((s) => brief.specialists.includes(s.agentId))
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

    const prompt = `Think step by step about the dependencies and potential file conflicts before decomposing.

Task to decompose: "${brief.summary}"
${decisionsBlock}
${constraintsBlock}
${filesBlock}
${conversationBlock}

Available specialists:
${specialistList}

Decompose this task into sub-tasks and respond with ONLY valid JSON.`

    return { prompt, specialistList }
  }

  /**
   * Parses the raw decomposition result into a validated TaskPlan.
   */
  private parseDecompositionResult(
    result: string,
    conversationId: string,
    brief: HandoffBrief,
    mode: ConversationMode
  ): TaskPlan {
    // Parse the JSON response — strip markdown fences if present
    let jsonStr = result
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim()
    }

    let parsed: { tasks: DecomposedTask[] }
    try {
      parsed = JSON.parse(jsonStr)
    } catch {
      this.log.error('Failed to parse decomposition JSON:', jsonStr.substring(0, 500))
      const parseError = 'Failed to parse task decomposition — LLM returned invalid JSON'
      eventLoggerService.logDecompositionFailed({
        conversationId,
        error: parseError,
        fallback: 'legacy'
      })
      throw new Error(parseError)
    }

    if (!parsed.tasks || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
      const emptyError = 'Task decomposition returned no tasks'
      eventLoggerService.logDecompositionFailed({
        conversationId,
        error: emptyError,
        fallback: 'legacy'
      })
      throw new Error(emptyError)
    }

    // Validate and normalize tasks — including raw complexity from LLM
    const tasks: DecomposedTask[] = parsed.tasks.map((t, i) => ({
      id: t.id || `t${i + 1}`,
      specialist: t.specialist,
      description: t.description,
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
      complexity: t.complexity, // raw from LLM — will be validated next
      verificationCommand: typeof t.verificationCommand === 'string' ? t.verificationCommand : undefined
    }))

    // Read workspace cost preference and enrich tasks with validated complexity scores
    const settings = this.workspacePath
      ? workspaceRepository.getSettingsByPath(this.workspacePath)
      : {}
    const costPreference = (settings.costPreference as CostPreference) || DEFAULT_COST_PREFERENCE

    const enrichedTasks = enrichTasksWithComplexity(tasks, costPreference)

    this.log.info(`Decomposed into ${enrichedTasks.length} tasks (cost: ${costPreference})`)
    for (const t of enrichedTasks) {
      this.log.info(`  ${t.id}: ${t.complexity?.tier}/${t.model} (score: ${t.complexity?.total})`)
    }

    // ── Event: decomposition completed ──
    eventLoggerService.logDecompositionCompleted({
      conversationId,
      taskCount: enrichedTasks.length,
      tasks: enrichedTasks.map((t) => ({
        id: t.id,
        specialist: t.specialist,
        model: t.model
      }))
    })

    return {
      conversationId,
      summary: brief.summary,
      mode,
      tasks: enrichedTasks,
      brief
    }
  }

  /**
   * SDK path — uses Agent SDK for decomposition (no NDJSON, no child process).
   */
  private async decomposeViaSDK(
    brief: HandoffBrief,
    conversationId: string,
    mode: ConversationMode
  ): Promise<TaskPlan> {
    if (!this.workspacePath) {
      throw new Error('Orchestrator not started — no workspace path set')
    }

    const { prompt } = this.buildDecompositionInputs(brief)

    this.log.info('Decomposing task via SDK for specialists:', brief.specialists.join(', '))

    eventLoggerService.logDecompositionStarted({
      conversationId,
      summary: brief.summary,
      specialists: brief.specialists
    })

    this.currentStatus = 'thinking'
    this.messageStartedAt = Date.now()
    this.emit('statusUpdate', this.getStatus())

    try {
      const executor = new SDKExecutor()
      const { result } = await executor.executeAndCollect({
        prompt,
        systemPrompt: promptBuilder.getDecompositionPrompt(),
        model: modelConfigService.getModel(this.workspacePath, 'orchestrator'),
        cwd: this.workspacePath,
        permissionMode: 'plan',
        allowedTools: []
      })

      this.currentStatus = 'idle'
      this.emit('statusUpdate', this.getStatus())

      return this.parseDecompositionResult(result, conversationId, brief, mode)
    } catch (error) {
      eventLoggerService.logDecompositionFailed({
        conversationId,
        error: (error as Error).message,
        fallback: 'legacy'
      })
      this.currentStatus = 'idle'
      this.emit('statusUpdate', this.getStatus())
      throw error
    }
  }

  async stop(): Promise<void> {
    // Abort in-flight SDK query if running
    if (this.sdkAbortController) {
      this.log.info('Aborting in-flight SDK query')
      this.sdkAbortController.abort()
      this.sdkAbortController = null
    }
    await super.stop()
    this.sessionMap.clear()
    this.currentConversationId = null
  }

  clearSession(conversationId: string): void {
    this.sessionMap.delete(conversationId)
  }

  /**
   * Evicts the oldest session entries when the map exceeds MAX_SESSION_MAP_SIZE.
   * Map iteration order is insertion order, so first entries are oldest.
   */
  private evictOldSessions(): void {
    if (this.sessionMap.size <= MAX_SESSION_MAP_SIZE) return
    const excess = this.sessionMap.size - MAX_SESSION_MAP_SIZE
    let removed = 0
    for (const key of this.sessionMap.keys()) {
      if (removed >= excess) break
      this.sessionMap.delete(key)
      removed++
    }
    this.log.info(
      `Evicted ${removed} old orchestrator sessions (map size: ${this.sessionMap.size})`
    )
  }

  getStatus(): AgentStatus {
    const isActive =
      this.currentStatus === 'thinking' ||
      this.currentStatus === 'writing' ||
      this.currentStatus === 'reviewing'

    return {
      agentId: AGENT_IDS.ORCHESTRATOR,
      agentType: 'orchestrator',
      status: this.currentStatus,
      elapsedMs: isActive && this.messageStartedAt ? Date.now() - this.messageStartedAt : 0,
      tokenUsage: this.tokenUsage
    }
  }

  isRunning(): boolean {
    return this.workspacePath !== null
  }
}

export const orchestratorService = new OrchestratorService()
