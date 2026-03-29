import { spawn } from 'node:child_process'
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
import { authProvider } from './auth-provider'
import { SDKExecutor } from './sdk-executor'
import type { SDKExecuteResult } from './sdk-executor'
import type { StreamChunk } from './agent-base.service'

/** Maximum number of session entries before evicting oldest */
const MAX_SESSION_MAP_SIZE = 100

export class OrchestratorService extends AgentBaseService {
  protected readonly log = orchestratorLogger
  private workspacePath: string | null = null
  private sessionMap: Map<string, string> = new Map()
  private currentConversationId: string | null = null

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
   * Sends a message — routes to SDK or CLI based on auth provider configuration.
   * Uses `--resume` with session ID for multi-turn conversation continuity.
   */
  async send(
    message: string,
    conversationId?: string,
    mode: ConversationMode = 'build'
  ): Promise<void> {
    if (authProvider.supportsSDK()) {
      return this.sendViaSDK(message, conversationId, mode)
    }
    return this.sendViaCLI(message, conversationId, mode)
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

    const executor = new SDKExecutor()
    for await (const chunk of executor.execute({
      prompt: message,
      systemPrompt: systemPrompt ?? '',
      model: modelConfigService.getModel(this.workspacePath, 'orchestrator'),
      cwd: this.workspacePath,
      permissionMode: mode === 'build' ? 'bypassPermissions' : 'plan',
      allowedTools: ['WebSearch', 'WebFetch'],
      resume: existingSession ?? undefined
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

    this.currentStatus = 'idle'
    this.emit('statusUpdate', this.getStatus())
    this.emit('complete')
  }

  /**
   * CLI path — spawns `claude -p` process with `--output-format stream-json`.
   * Original implementation, used when auth mode is Claude Max.
   */
  private async sendViaCLI(
    message: string,
    conversationId?: string,
    mode: ConversationMode = 'build'
  ): Promise<void> {
    if (!this.workspacePath) {
      throw new Error('Orchestrator not started — no workspace path set')
    }

    // Kill any still-running process from previous message
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM')
    }

    this.currentStatus = 'thinking'
    this.buffer = ''
    this.hasEmittedContent = false
    this.messageStartedAt = Date.now()
    this.processedToolIds.clear()
    this.currentConversationId = conversationId ?? null
    this.emit('statusUpdate', this.getStatus())

    // No LLM skill matching — skills are resolved deterministically via AgentRegistry
    // when the orchestrator decomposes tasks and assigns them to specialists.

    const orchestratorModel = modelConfigService.getModel(this.workspacePath, 'orchestrator')
    const args = [
      '-p',
      message,
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      orchestratorModel,
      '--allowedTools',
      'WebSearch,WebFetch'
    ]

    if (mode === 'build') {
      args.push('--permission-mode', 'bypassPermissions')
    } else {
      args.push('--permission-mode', 'plan')
    }

    // Hooks are configured declaratively via .claude/hooks/hooks.json
    // (CLI flags --pre-tool-use-hook / --post-tool-use-hook are not supported)

    const existingSession = conversationId ? this.sessionMap.get(conversationId) : null
    if (existingSession) {
      args.push('--resume', existingSession)
    }

    if (!existingSession) {
      const fullSystemPrompt = promptBuilder.build({
        role: 'orchestrator',
        mode,
        workspacePath: this.workspacePath!
      })
      args.push('--system-prompt', fullSystemPrompt)
    }

    const env = this.buildEnvWithPath()

    this.log.info(
      'Spawning claude with args:',
      args.filter((a) => a !== message && !a.includes('You are a')).join(' ')
    )

    const currentProcess = spawn('claude', args, {
      cwd: this.workspacePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env
    })
    this.process = currentProcess

    currentProcess.stdout?.on('data', (data: Buffer) => {
      if (this.process !== currentProcess) return
      this.log.debug('stdout:', data.toString().substring(0, 200))
      this.handleOutput(data)
    })

    currentProcess.stderr?.on('data', (data: Buffer) => {
      if (this.process !== currentProcess) return
      this.handleError(data)
    })

    currentProcess.on('exit', (code: number | null) => {
      if (this.process !== currentProcess) {
        this.log.debug('Stale process exit ignored (code:', code, ')')
        return
      }
      this.handleExit(code)
    })

    currentProcess.on('error', (err: Error) => {
      if (this.process !== currentProcess) return
      this.log.error('Process error:', err.message)
      this.currentStatus = 'failed'
      this.emit('statusUpdate', this.getStatus())
      this.emit('chunk', {
        type: 'error',
        error: `Failed to spawn Claude CLI: ${err.message}`
      } as StreamChunk)
      this.emit('complete')
    })
  }

  /**
   * Decomposes a handoff brief into structured sub-tasks.
   * Routes to SDK or CLI based on auth provider configuration.
   */
  async decompose(
    brief: HandoffBrief,
    conversationId: string,
    mode: ConversationMode
  ): Promise<TaskPlan> {
    if (authProvider.supportsSDK()) {
      return this.decomposeViaSDK(brief, conversationId, mode)
    }
    return this.decomposeViaCLI(brief, conversationId, mode)
  }

  /**
   * Builds the decomposition prompt and specialist list from a handoff brief.
   * Shared by both CLI and SDK decomposition paths.
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
   * Shared by both CLI and SDK decomposition paths.
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

      return this.parseDecompositionResult(result, conversationId, brief, mode)
    } catch (error) {
      eventLoggerService.logDecompositionFailed({
        conversationId,
        error: (error as Error).message,
        fallback: 'legacy'
      })
      throw error
    }
  }

  /**
   * CLI path — spawns `claude -p` for decomposition.
   * Original implementation, used when auth mode is Claude Max.
   */
  private async decomposeViaCLI(
    brief: HandoffBrief,
    conversationId: string,
    mode: ConversationMode
  ): Promise<TaskPlan> {
    if (!this.workspacePath) {
      throw new Error('Orchestrator not started — no workspace path set')
    }

    const { prompt } = this.buildDecompositionInputs(brief)

    this.log.info('Decomposing task via CLI for specialists:', brief.specialists.join(', '))

    // ── Event: decomposition started ──
    eventLoggerService.logDecompositionStarted({
      conversationId,
      summary: brief.summary,
      specialists: brief.specialists
    })

    const env = this.buildEnvWithPath()

    let result: string
    try {
      result = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        'claude',
        ['-p', prompt, '--system-prompt', promptBuilder.getDecompositionPrompt(), '--output-format', 'text'],
        {
          cwd: this.workspacePath!,
          stdio: ['ignore', 'pipe', 'pipe'],
          env
        }
      )

      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })
      child.on('exit', (code) => {
        if (code === 0) resolve(stdout.trim())
        else reject(new Error(`Decomposition failed (code ${code}): ${stderr.substring(0, 500)}`))
      })
      child.on('error', reject)

      // 30s timeout for decomposition
      setTimeout(() => {
        try {
          child.kill('SIGTERM')
        } catch {
          /* ignore */
        }
        reject(new Error('Task decomposition timed out'))
      }, 30000)
    })
    } catch (error) {
      // ── Event: decomposition failed (CLI spawn, timeout, or exit code) ──
      eventLoggerService.logDecompositionFailed({
        conversationId,
        error: (error as Error).message,
        fallback: 'legacy'
      })
      throw error
    }

    return this.parseDecompositionResult(result, conversationId, brief, mode)
  }

  /**
   * Override to capture session IDs from result events.
   */
  protected onResultEvent(event: Record<string, unknown>): void {
    const sessionId = event.session_id as string | undefined
    if (sessionId && this.currentConversationId) {
      this.sessionMap.set(this.currentConversationId, sessionId)
      this.evictOldSessions()
      this.log.info('Session ID captured for conversation:', this.currentConversationId, sessionId)
    }

    // Call base implementation for text emission and status
    super.onResultEvent(event)
  }

  protected onSystemEvent(event: Record<string, unknown>): void {
    const sessionId = event.session_id as string | undefined
    if (sessionId && this.currentConversationId) {
      this.sessionMap.set(this.currentConversationId, sessionId)
      this.evictOldSessions()
      this.log.info(
        'System init, session:',
        sessionId,
        'for conversation:',
        this.currentConversationId
      )
    }
  }

  /**
   * Override to capture orchestrator stderr to the event log for debugging.
   * Filters out trivial noise (progress bars, blank lines) and logs substantial errors.
   */
  protected handleError(data: Buffer): void {
    super.handleError(data)
    const text = data.toString().trim()
    // Only log non-trivial stderr (skip blank lines, progress indicators, etc.)
    if (text && text.length > 10 && !text.startsWith('�') && !text.startsWith('Progress:')) {
      eventLoggerService.logOrchestratorStderr({
        conversationId: this.currentConversationId ?? undefined,
        stderr: text
      })
    }
  }

  async stop(): Promise<void> {
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
