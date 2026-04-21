import type { BrowserWindow } from 'electron'
import type {
  AgentStatus,
  ConversationMode,
  DecomposedTask,
  ExecutionStrategy,
  HandoffBrief,
  InvestigationDepth,
  InvestigationReport,
  StructuredPlan,
  TaskExecutionProgress
} from '../../shared/types'
import { IPC_CHANNELS } from '../../shared/constants'
import {
  conversationRepository,
  conversationSpecialistRepository,
  messageRepository,
  workspaceRepository,
  specialistRepository
} from '../db/repositories'
import { generalistService } from '../services'
import type { StreamChunk } from '../services'
import { specialistPoolService } from './specialist-pool.service'
import { eventLoggerService } from './event-logger.service'
import { forwardChunkToRenderer } from '../ipc/chat-shared'
import { createTextChunk, createCompleteMessage } from '../ipc/chat-protocol'
import { chatIpcLogger } from '../logger'
import { decompositionService } from './decomposition.service'
import { hookEngine } from './hook-engine.service'
import { conversationStateMachine } from './conversation-state-machine'
import { conversationLifecycle } from './conversation-lifecycle'

const log = chatIpcLogger

// ── Disposable Listener Group ──

type PoolEventHandlers = Record<string, (...args: unknown[]) => void>

/**
 * Registers all handlers on the pool emitter and returns a single dispose()
 * function that removes them all. Eliminates multi-site cleanup bugs.
 */
function attachPoolListeners(
  pool: typeof specialistPoolService,
  handlers: PoolEventHandlers
): () => void {
  for (const [event, fn] of Object.entries(handlers)) {
    pool.on(event, fn)
  }
  return () => {
    for (const [event, fn] of Object.entries(handlers)) {
      pool.removeListener(event, fn)
    }
  }
}

// ── Pipeline Options (discriminated union) ──

/** Normal handoff from generalist → specialist delegation */
interface BasePipelineOptions {
  conversationId: string
  requestId?: string
}

export interface HandoffPrepare extends BasePipelineOptions {
  type: 'handoff'
  brief: HandoffBrief
}

/** Investigation fix — auto-switch to build mode and execute fix */
export interface InvestigationFixPrepare extends BasePipelineOptions {
  type: 'investigationFix'
  report: InvestigationReport
  autoExecuteStrategy: ExecutionStrategy
}

/** Direct plan execution — skip generalist round-trip when user clicks "Build This" on inline plan */
export interface PlanExecutionPrepare extends BasePipelineOptions {
  type: 'planExecution'
  plan: StructuredPlan
  /** Raw plan content (JSON string) for context injection */
  planContent: string
}

export type PrepareOptions = HandoffPrepare | InvestigationFixPrepare | PlanExecutionPrepare

export interface ExecuteOptions extends BasePipelineOptions {
  tasks: DecomposedTask[]
  brief?: HandoffBrief | null
  investigationDepth?: InvestigationDepth
}

// ── Pipeline Service ──

export class TaskPipelineService {
  private mainWindow: BrowserWindow

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow
  }

  /**
   * Phase 1: Prepare a task plan.
   *
   * Uses derive-then-run pattern:
   * 1. Switch on variant type to derive all config values
   * 2. Run linear step pipeline with derived config
   *
   * Steps: logEvent → enrichMessages → sendNotifications → persistMode → decompose → sendTaskPlan
   */
  async prepare(options: PrepareOptions): Promise<void> {
    const { conversationId, requestId } = options

    // ── Derive config from variant type ──
    type NotificationType = 'handoff' | 'delegation' | 'modeSwitch'

    interface PrepareConfig {
      brief: HandoffBrief
      effectiveMode: ConversationMode
      autoExecuteStrategy?: ExecutionStrategy
      enrichMessages: boolean
      notifications: NotificationType[]
    }

    let config: PrepareConfig

    switch (options.type) {
      case 'handoff': {
        const { brief } = options
        const conversation = conversationRepository.findById(conversationId)

        // Respect the user's explicit mode choice.
        // Only default to plan when conversation mode is not set to build.
        // When user is in build mode, honor it — even for investigation-like summaries.
        const effectiveMode: ConversationMode = conversation?.mode === 'build' ? 'build' : 'plan'

        if (effectiveMode !== brief.mode) {
          log.info(
            `[PIPELINE:mode-resolve] effectiveMode=${effectiveMode} (conversation=${conversation?.mode}, brief=${brief.mode})`
          )
        }
        brief.mode = effectiveMode

        config = {
          brief,
          effectiveMode,
          autoExecuteStrategy: effectiveMode === 'build' ? 'sequential' : undefined,
          enrichMessages: brief.specialists.length > 1,
          notifications: ['handoff', 'delegation']
        }
        break
      }

      case 'investigationFix': {
        const { report, autoExecuteStrategy } = options

        // Auto-switch generalist to build mode
        const conversation = conversationRepository.findById(conversationId)
        if (conversation?.mode === 'plan') {
          conversationRepository.updateMode(conversationId, 'build')
          generalistService.switchMode('build')
          log.info('Auto-switched to build mode for investigation fix')
        }

        // Build fix-oriented HandoffBrief from investigation report
        const fixBrief: HandoffBrief = {
          summary: `Fix: ${report.proposedFix}`,
          decisions: [],
          constraints: [],
          filesDiscussed: report.filesAffected.map((f) => f.path),
          recentMessages: [],
          specialists: [],
          mode: 'build'
        }

        config = {
          brief: fixBrief,
          effectiveMode: 'build',
          autoExecuteStrategy,
          enrichMessages: false,
          notifications: ['modeSwitch']
        }
        break
      }

      case 'planExecution': {
        const { plan, planContent } = options

        // Switch to build mode
        const conversation = conversationRepository.findById(conversationId)
        if (conversation?.mode === 'plan') {
          conversationRepository.updateMode(conversationId, 'build')
          generalistService.switchMode('build')
          log.info('[PIPELINE:plan-execution] Switched to build mode for direct plan execution')
        }

        // Resolve specialists from conversation overrides, or let decomposition LLM choose.
        // conversation_specialists stores UUIDs (specialist.id), but downstream code
        // (decomposition, delegation, handoff) expects agentId slugs (e.g. "react-architect").
        const overrides = conversationSpecialistRepository.findByConversation(conversationId)
        let specialists: string[]
        if (overrides.length > 0) {
          specialists = overrides
            .filter((o) => o.isActive)
            .map((o) => {
              const spec = specialistRepository.findById(o.specialistId)
              return spec?.agentId ?? o.specialistId
            })
            .filter(Boolean) as string[]
        } else {
          // No conversation overrides — let decomposition LLM choose from active roster
          specialists = []
          log.info(
            '[PIPELINE:plan-execution] No conversation overrides — decomposition LLM will select specialists'
          )
        }

        // Collect files from plan steps and filesChanged
        const filesFromSteps = (plan.steps ?? []).map((s) => s.file).filter(Boolean) as string[]
        const filesFromChanges = (plan.filesChanged ?? []).map((f) => f.file)
        const filesFromScope = plan.files ?? []
        const allFiles = [...new Set([...filesFromSteps, ...filesFromChanges, ...filesFromScope])]

        // Collect decisions from plan
        const decisions = (plan.decisions ?? []).map((d) => `${d.what}: ${d.why}`)

        // Build brief from structured plan — no generalist round-trip needed
        const planBrief: HandoffBrief = {
          summary: plan.summary || plan.title,
          decisions,
          constraints: [],
          filesDiscussed: allFiles,
          recentMessages: [],
          specialists,
          mode: 'build'
        }

        // Inject plan content as a recent message for specialist context
        planBrief.recentMessages = [
          {
            role: 'assistant',
            content: `Here is the implementation plan:\n\n${planContent.substring(0, 4000)}`
          }
        ]

        config = {
          brief: planBrief,
          effectiveMode: 'build',
          autoExecuteStrategy: 'sequential',
          enrichMessages: specialists.length > 1,
          notifications: ['handoff', 'delegation']
        }
        break
      }
    }

    const { brief, effectiveMode, enrichMessages, notifications } = config

    // ── Step 1: Event logging ──
    eventLoggerService.logHandoffDetected({
      conversationId,
      summary: brief.summary,
      specialists: brief.specialists,
      mode: brief.mode
    })

    // ── Step 2: Enrich with recent messages ──
    if (enrichMessages) {
      try {
        const allMessages = messageRepository.findByConversation(conversationId)
        brief.recentMessages = allMessages
          .slice(-10)
          .map((m) => ({ role: m.role, content: m.contentMd.substring(0, 2000) }))
        log.info(`Enriched handoff with ${brief.recentMessages.length} recent messages`)
      } catch (error) {
        log.warn('Failed to enrich handoff with recent messages:', error)
      }
    } else if (brief.specialists.length <= 1 && options.type === 'handoff') {
      log.info(
        '[PIPELINE:skip-recent-messages] Single-specialist handoff — skipping recentMessages enrichment (Strategy F)'
      )
    }

    // ── Step 3: Send UI notifications ──
    for (const notification of notifications) {
      switch (notification) {
        case 'handoff':
          this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_HANDOFF, {
            conversationId,
            summary: brief.summary,
            specialists: brief.specialists,
            mode: brief.mode,
            ...(requestId ? { requestId } : {})
          })
          log.info(`[PIPELINE:handoff-sent-to-renderer] conversationId=${conversationId}`)
          // Switch streaming identity to generalist during decomposition
          this.mainWindow.webContents.send(
            IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
            createTextChunk({ conversationId, requestId, text: '', role: 'generalist' })
          )
          break

        case 'delegation': {
          const specialistNames = brief.specialists
            .map((id) => {
              const spec =
                specialistRepository.findByAgentId(id) ?? specialistRepository.findById(id)
              return spec?.displayName ?? id
            })
            .join(', ')
          this.mainWindow.webContents.send(
            IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
            createTextChunk({
              conversationId,
              requestId,
              text: `Delegating to **${specialistNames}** for ${brief.mode === 'plan' ? 'review' : 'implementation'}.\n\n`,
              role: 'generalist'
            })
          )
          break
        }

        case 'modeSwitch':
          this.mainWindow.webContents.send(
            IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
            createTextChunk({
              conversationId,
              requestId,
              text: '\n> **Mode switched to Build** — executing fix plan.\n\n',
              role: 'generalist'
            })
          )
          break
      }
    }

    // ── Step 4: Persist mode to DB ──
    try {
      conversationRepository.updateMode(conversationId, effectiveMode)
    } catch (error) {
      log.error('Failed to update conversation mode:', error)
    }

    // ── Step 5: Decompose (via extracted DecompositionService) ──
    try {
      log.info(`[PIPELINE:decompose-starting] specialists=${brief.specialists.join(',')}`)
      const workspacePath = generalistService.getWorkspacePath()
      if (!workspacePath) throw new Error('Generalist not started — no workspace path set')
      const workspace = workspaceRepository.findAll().find((w) => w.repoPath === workspacePath)
      const workspaceId = workspace?.id ?? null
      const settings = workspace ? JSON.parse(workspace.settingsJson || '{}') : {}
      const taskPlan = await decompositionService.decompose(brief, conversationId, effectiveMode, {
        workspacePath,
        workspaceId,
        repomapEnabled: !!settings.repomapEnabled,
        semanticSearchEnabled: !!settings.semanticSearchEnabled
      })
      log.info(`[PIPELINE:decompose-complete] taskCount=${taskPlan.tasks.length}`)

      // Fire plan_created hook (non-blocking)
      hookEngine
        .executeHooks('plan_created', {
          taskCount: String(taskPlan.tasks.length),
          mode: taskPlan.mode
        })
        .catch((err) => log.warn('Hook error (plan_created):', err))

      // ── Step 6: Auto-execute directly — no floating card ──
      // In plan mode, specialist will produce a ```plan block → inline card in MessageBubble
      // In build mode, specialist executes changes directly
      log.info(`[PIPELINE:auto-executing] taskCount=${taskPlan.tasks.length} mode=${taskPlan.mode}`)
      await this.execute({
        conversationId,
        tasks: taskPlan.tasks,
        brief,
        investigationDepth: taskPlan.investigationDepth,
        requestId
      })
    } catch (error) {
      log.error('Task decomposition failed:', error)
      eventLoggerService.logDecompositionFailed({
        conversationId,
        error: (error as Error).message,
        fallback: 'none'
      })
      const savedMsg = messageRepository.create(
        conversationId,
        'generalist',
        `**Error:** Task decomposition failed.\n\n${(error as Error).message}`
      )
      this.mainWindow.webContents.send(
        IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
        createTextChunk({
          conversationId,
          requestId,
          text: `\n\n**Error:** Task decomposition failed. ${(error as Error).message}`,
          role: 'generalist'
        })
      )
      this.mainWindow.webContents.send(
        IPC_CHANNELS.CHAT_MESSAGE_COMPLETE,
        createCompleteMessage({ conversationId, messageId: savedMsg.id, requestId })
      )
    }
  }

  /**
   * Phase 2: Execute a task plan.
   *
   * Steps:
   * 1. Resolve workspace/mode from DB
   * 2. Configure specialist pool
   * 3. Attach disposable listener group (chunk, complete, retry, progress, agentStatus)
   * 4. Run executeSequential or executeParallel
   * 5. On complete: build summary, save message, inject context, dispose listeners
   * 6. On error: surface to user, dispose listeners
   */
  async execute(options: ExecuteOptions): Promise<void> {
    const { conversationId, tasks, brief = null, investigationDepth, requestId } = options

    log.info(`Executing plan: tasks=${tasks.length}, conversation=${conversationId}`)

    // Register specialist pool cleanup with centralized lifecycle
    conversationLifecycle.onDispose(() => {
      specialistPoolService.stopAll().catch((e) => {
        log.warn('[TaskPipeline] Lifecycle dispose: pool stopAll failed:', e)
      })
    })

    const startTime = Date.now()

    eventLoggerService.logPlanExecutionStarted({
      conversationId,
      strategy: 'subagent' as ExecutionStrategy,
      taskCount: tasks.length
    })

    // Emit task list to renderer for progress card
    this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_BUILD_TASKS, {
      conversationId,
      tasks,
      ...(requestId ? { requestId } : {})
    })

    const conversation = conversationRepository.findById(conversationId)
    const mode: ConversationMode = (conversation?.mode as ConversationMode) ?? 'build'
    const workspacePath = generalistService.getWorkspacePath()
    if (!workspacePath) {
      throw new Error('No workspace path — generalist not started')
    }

    // ── Configure specialist pool ──
    const accumulatedContent = { value: '' }
    const taskResultMap = new Map<string, { status: string; error?: string; specialist: string; duration?: number }>()

    specialistPoolService.setWorkspacePath(workspacePath)
    const ws = workspaceRepository.findAll().find((w) => w.repoPath === workspacePath)
    if (ws) specialistPoolService.setWorkspaceId(ws.id)
    specialistPoolService.setConversationBrief(brief)
    specialistPoolService.setConversationId(conversationId)
    if (investigationDepth) {
      specialistPoolService.setInvestigationDepth(investigationDepth)
    }

    // ── Attach disposable listener group ──
    let dispose: (() => void) | null = null
    // Guard against double-fire of allComplete — executeParallel can resolve
    // from both the onDone callback and the tryStartReady guard in a race.
    let completionEmitted = false

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const handlers: PoolEventHandlers = {
      taskChunk: (data: any): void => {
        const {
          taskId,
          specialist: specialistId,
          chunk: taskChunk,
          toolActivity
        } = data as {
          taskId: string
          specialist: string
          chunk: string | StreamChunk
          toolActivity?: {
            type: 'tool_use' | 'tool_result'
            toolName?: string
            toolId?: string
            input?: string
          }
        }

        let normalizedChunk: StreamChunk
        if (typeof taskChunk === 'string') {
          if (toolActivity?.type === 'tool_use') {
            normalizedChunk = {
              type: 'tool_use',
              toolName: toolActivity.toolName,
              toolId: toolActivity.toolId,
              toolInput: toolActivity.input
            }
          } else if (toolActivity?.type === 'tool_result') {
            normalizedChunk = {
              type: 'tool_result',
              toolName: toolActivity.toolName,
              toolId: toolActivity.toolId,
              content: toolActivity.input
            }
          } else {
            normalizedChunk = { type: 'text', content: taskChunk }
          }
        } else {
          normalizedChunk = taskChunk
        }

        if (normalizedChunk.type === 'text' && normalizedChunk.content) {
          accumulatedContent.value += normalizedChunk.content
        }
        forwardChunkToRenderer(
          this.mainWindow,
          conversationId,
          'specialist',
          normalizedChunk,
          accumulatedContent,
          workspacePath ?? undefined,
          { specialist: specialistId, taskId },
          'specialist-executing',
          requestId
        )

        // Feed Agent Monitor output panel
        if (normalizedChunk.type === 'text' && normalizedChunk.content) {
          this.mainWindow.webContents.send(IPC_CHANNELS.AGENT_TASK_CHUNK, {
            agentId: specialistId,
            taskId,
            text: normalizedChunk.content,
            ...(requestId ? { requestId } : {})
          })
        }
      },

      allComplete: async (): Promise<void> => {
        // Guard: prevent duplicate summary messages + CHAT_MESSAGE_COMPLETE
        // if allComplete fires twice due to executeParallel race
        if (completionEmitted) {
          log.warn('[PIPELINE:allComplete-duplicate] Ignoring duplicate allComplete event')
          return
        }
        completionEmitted = true

        conversationStateMachine.transition('allComplete')
        const elapsed = startTime ? Date.now() - startTime : 0
        log.info(
          `[PIPELINE:allComplete-received] conversationId=${conversationId} elapsed=${elapsed}ms ` +
            `accumulated=${accumulatedContent.value.length} chars`
        )
        try {
          await this.onExecutionComplete(
            conversationId,
            tasks,
            mode,
            accumulatedContent,
            taskResultMap,
            startTime,
            requestId
          )
        } finally {
          dispose?.()
        }
      },

      taskRetry: (retryInfo: any): void => {
        this.mainWindow.webContents.send(IPC_CHANNELS.AGENT_TASK_RETRY, {
          ...(retryInfo ?? {}),
          ...(requestId ? { requestId } : {})
        })
      },

      taskProgress: (progress: any): void => {
        const p = progress as TaskExecutionProgress
        if (p.status === 'completed' || p.status === 'failed') {
          const duration =
            p.startedAt && p.completedAt ? p.completedAt - p.startedAt : undefined
          taskResultMap.set(p.taskId, {
            status: p.status,
            error: p.error,
            specialist: p.specialist,
            duration
          })
        }
        this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_TASK_PROGRESS, {
          ...p,
          ...(requestId ? { requestId } : {})
        })
      },

      agentStatus: (agentStatus: any): void => {
        this.mainWindow.webContents.send(
          IPC_CHANNELS.AGENT_STATUS_UPDATE,
          {
            ...(agentStatus as AgentStatus),
            ...(requestId ? { requestId } : {})
          }
        )
      },

      abandonmentDetected: (data: any): void => {
        this.mainWindow.webContents.send(IPC_CHANNELS.AGENT_ABANDONMENT_DETECTED, {
          ...(data ?? {}),
          ...(requestId ? { requestId } : {})
        })
      },

      gateFailure: (data: any): void => {
        this.mainWindow.webContents.send(IPC_CHANNELS.AGENT_GATE_FAILURE, {
          ...(data ?? {}),
          ...(requestId ? { requestId } : {})
        })
      },

      bugCouncilActivated: (data: any): void => {
        this.mainWindow.webContents.send(IPC_CHANNELS.BUG_COUNCIL_ACTIVATED, {
          ...(data ?? {}),
          ...(requestId ? { requestId } : {})
        })
      },

      bugCouncilComplete: (data: any): void => {
        this.mainWindow.webContents.send(IPC_CHANNELS.BUG_COUNCIL_COMPLETE, {
          ...(data ?? {}),
          ...(requestId ? { requestId } : {})
        })
      }
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */

    dispose = attachPoolListeners(specialistPoolService, handlers)

    // ── Run execution ──
    conversationStateMachine.transition('executionStarted')
    try {
      const hasDependencies = tasks.some((task) => (task.dependsOn?.length ?? 0) > 0)
      if (hasDependencies) {
        await specialistPoolService.executeSequential(tasks, mode)
      } else {
        await specialistPoolService.executeParallel(tasks, mode)
      }
    } catch (error) {
      dispose()
      log.error('Plan execution failed:', error)
      conversationStateMachine.transition('executionError')

      // Clear handoff state in renderer on pipeline failure
      this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_HANDOFF, {
        conversationId,
        summary: '',
        specialists: [],
        mode: 'plan',
        cleared: true,
        ...(requestId ? { requestId } : {})
      })

      eventLoggerService.logPlanExecutionFailed({
        conversationId,
        strategy: 'subagent' as ExecutionStrategy,
        error: (error as Error).message
      })

      const errorMsg = `**Execution Error:** ${(error as Error).message}`
      const savedMsg = messageRepository.create(conversationId, 'generalist', errorMsg)
      this.mainWindow.webContents.send(
        IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
        createTextChunk({ conversationId, requestId, text: errorMsg, role: 'generalist' })
      )
      this.mainWindow.webContents.send(
        IPC_CHANNELS.CHAT_MESSAGE_COMPLETE,
        createCompleteMessage({ conversationId, messageId: savedMsg.id, requestId })
      )
      conversationStateMachine.transition('errorHandled')
    }
  }

  /**
   * Shared completion handler — builds summary, saves message,
   * injects context into generalist.
   */
  private async onExecutionComplete(
    conversationId: string,
    tasks: DecomposedTask[],
    mode: ConversationMode,
    accumulatedContent: { value: string },
    taskResultMap: Map<string, { status: string; error?: string; specialist: string; duration?: number }>,
    startTime?: number,
    requestId?: string
  ): Promise<void> {
    log.info('Pipeline execution complete')

    if (!accumulatedContent.value.trim()) {
      log.warn(`[PIPELINE:empty-specialist-output] conversationId=${conversationId}`)
    }

    eventLoggerService.logPlanExecutionCompleted({
      conversationId,
      strategy: 'subagent' as ExecutionStrategy,
      taskCount: tasks.length
    })

    // Build structured completion summary as build-summary JSON block
    const buildSummary = {
      tasks: tasks.map((task) => {
        const result = taskResultMap.get(task.id)
        return {
          taskId: task.id,
          specialist: task.specialist,
          description: task.description,
          status: result?.status === 'failed' ? ('failed' as const) : ('completed' as const),
          error: result?.error,
          duration: result?.duration
        }
      }),
      totalDuration: startTime ? Date.now() - startTime : 0,
      mode
    }

    const summaryJson = JSON.stringify(buildSummary)
    const summaryBlock = `\`\`\`build-summary\n${summaryJson}\n\`\`\``

    // Determine primary specialist for attribution (last task's specialist, or first)
    const primarySpecialist = tasks.length > 0 ? tasks[tasks.length - 1].specialist : undefined

    this.mainWindow.webContents.send(
      IPC_CHANNELS.CHAT_MESSAGE_CHUNK,
      createTextChunk({
        conversationId,
        requestId,
        text: `\n\n${summaryBlock}\n`,
        role: 'specialist',
        specialist: primarySpecialist
      })
    )
    accumulatedContent.value += `\n\n${summaryBlock}\n`

    const savedMsg = messageRepository.create(
      conversationId,
      'specialist',
      accumulatedContent.value || '_No response from specialist execution._',
      primarySpecialist
    )
    this.mainWindow.webContents.send(
      IPC_CHANNELS.CHAT_MESSAGE_COMPLETE,
      createCompleteMessage({ conversationId, messageId: savedMsg.id, requestId })
    )

    // Context injection into generalist (Strategy ι)
    try {
      const rawOutput = accumulatedContent.value
      const reportMatch = rawOutput.match(/```investigation-report\s*\n([\s\S]*?)```/)
      let contextToInject: string

      if (reportMatch) {
        contextToInject = `Investigation result: ${reportMatch[1].trim()}`
        log.info(
          `[PIPELINE:context-injection-dedup] Extracted investigation report (${contextToInject.length} chars vs ${rawOutput.length} raw)`
        )
      } else {
        contextToInject = rawOutput.substring(0, 3000)
      }

      if (contextToInject.trim()) {
        const taskDescriptions = tasks.map((t) => `- ${t.specialist}: ${t.description}`).join('\n')
        await generalistService.injectContext(
          `[Specialist execution complete — ${tasks.length} task(s)]\n\nTasks executed:\n${taskDescriptions}\n\nResults summary:\n${contextToInject}`,
          conversationId
        )
        log.info(`[PIPELINE:context-injection] Injected ${contextToInject.length} chars`)
      }
    } catch (e) {
      log.warn('Context injection after specialist execution failed:', e)
    }

    conversationStateMachine.transition('messageFinalised')
  }
}

// ── Singleton with lazy initialization ──

let _instance: TaskPipelineService | null = null

export function initTaskPipeline(mainWindow: BrowserWindow): TaskPipelineService {
  _instance = new TaskPipelineService(mainWindow)
  return _instance
}

export const taskPipeline = new Proxy({} as TaskPipelineService, {
  get(_target, prop) {
    if (!_instance)
      throw new Error('TaskPipeline not initialized — call initTaskPipeline(mainWindow) first')
    return (_instance as unknown as Record<string, unknown>)[prop as string]
  }
})
