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
   * Sends a message by spawning a new `claude -p` process with `--output-format stream-json`.
   * Uses `--resume` with session ID for multi-turn conversation continuity.
   * Performs semantic skill matching to augment the prompt with relevant skill context.
   */
  async send(
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
      args.push('--permission-mode', 'auto')
    } else {
      args.push('--permission-mode', 'plan')
    }

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
   * Decomposes a handoff brief into structured sub-tasks via a short `claude -p` call.
   * Accepts a full HandoffBrief with decisions, constraints, files discussed, and recent messages.
   * Returns a TaskPlan with decomposed tasks assigned to specialists.
   */
  async decompose(
    brief: HandoffBrief,
    conversationId: string,
    mode: ConversationMode
  ): Promise<TaskPlan> {
    if (!this.workspacePath) {
      throw new Error('Orchestrator not started — no workspace path set')
    }

    // Build specialist list for the prompt
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
    // Long conversations can dump enormous history into the decomposition prompt.
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

    this.log.info('Decomposing task for specialists:', brief.specialists.join(', '))

    const env = this.buildEnvWithPath()

    const result = await new Promise<string>((resolve, reject) => {
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
      throw new Error('Failed to parse task decomposition — LLM returned invalid JSON')
    }

    if (!parsed.tasks || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
      throw new Error('Task decomposition returned no tasks')
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

    return {
      conversationId,
      summary: brief.summary,
      mode,
      tasks: enrichedTasks,
      brief
    }
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
