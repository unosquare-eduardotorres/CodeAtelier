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
import { chatIpcLogger } from '../logger'
import { decompositionService } from './decomposition.service'
import { hookEngine } from './hook-engine.service'

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
export interface HandoffPrepare {
  type: 'handoff'
  conversationId: string
  brief: HandoffBrief
}

/** Investigation fix — auto-switch to build mode and execute fix */
export interface InvestigationFixPrepare {
  type: 'investigationFix'
  conversationId: string
  report: InvestigationReport
  autoExecuteStrategy: ExecutionStrategy
}

/** Direct plan execution — skip generalist round-trip when user clicks "Build This" on inline plan */
export interface PlanExecutionPrepare {
  type: 'planExecution'
  conversationId: string
  plan: StructuredPlan
  /** Raw plan content (JSON string) for context injection */
  planContent: string
}

export type PrepareOptions = HandoffPrepare | InvestigationFixPrepare | PlanExecutionPrepare

export interface ExecuteOptions {
  conversationId: string
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
    const { conversationId } = options

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
        const effectiveMode: ConversationMode =
          conversation?.mode === 'build' ? 'build' : 'plan'

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
          log.info('[PIPELINE:plan-execution] No conversation overrides — decomposition LLM will select specialists')
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
            mode: brief.mode
          })
          log.info(`[PIPELINE:handoff-sent-to-renderer] conversationId=${conversationId}`)
          // Switch streaming identity to generalist during decomposition
          this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
            conversationId,
            chunk: '',
            role: 'generalist'
          })
          break

        case 'delegation': {
          const specialistNames = brief.specialists
            .map((id) => {
              const spec = specialistRepository.findByAgentId(id) ?? specialistRepository.findById(id)
              return spec?.displayName ?? id
            })
            .join(', ')
          this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
            conversationId,
            chunk: `Delegating to **${specialistNames}** for ${brief.mode === 'plan' ? 'review' : 'implementation'}.\n\n`,
            role: 'generalist'
          })
          break
        }

        case 'modeSwitch':
          this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
            conversationId,
            chunk: '\n> **Mode switched to Build** — executing fix plan.\n\n',
            role: 'generalist'
          })
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
          taskCount: taskPlan.tasks.length,
          mode: taskPlan.mode
        })
        .catch((err) => log.warn('Hook error (plan_created):', err))

      // ── Step 6: Auto-execute directly — no floating card ──
      // In plan mode, specialist will produce a ```plan block → inline card in MessageBubble
      // In build mode, specialist executes changes directly
      log.info(
        `[PIPELINE:auto-executing] taskCount=${taskPlan.tasks.length} mode=${taskPlan.mode}`
      )
      await this.execute({
        conversationId,
        tasks: taskPlan.tasks,
        brief,
        investigationDepth: taskPlan.investigationDepth
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
      this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
        conversationId,
        chunk: `\n\n**Error:** Task decomposition failed. ${(error as Error).message}`,
        role: 'generalist'
      })
      this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, {
        conversationId,
        messageId: savedMsg.id
      })
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
    const { conversationId, tasks, brief = null, investigationDepth } = options

    log.info(`Executing plan: tasks=${tasks.length}, conversation=${conversationId}`)

    const startTime = Date.now()

    eventLoggerService.logPlanExecutionStarted({
      conversationId,
      strategy: 'subagent' as ExecutionStrategy,
      taskCount: tasks.length
    })

    // Emit task list to renderer for progress card
    this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_BUILD_TASKS, {
      conversationId,
      tasks
    })

    const conversation = conversationRepository.findById(conversationId)
    const mode: ConversationMode = (conversation?.mode as ConversationMode) ?? 'build'
    const workspacePath = generalistService.getWorkspacePath()
    if (!workspacePath) {
      throw new Error('No workspace path — generalist not started')
    }

    // ── Configure specialist pool ──
    const accumulatedContent = { value: '' }
    const taskResultMap = new Map<string, { status: string; error?: string; specialist: string }>()

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
          { specialist: specialistId, taskId }
        )

        // Feed Agent Monitor output panel
        if (normalizedChunk.type === 'text' && normalizedChunk.content) {
          this.mainWindow.webContents.send(IPC_CHANNELS.AGENT_TASK_CHUNK, {
            agentId: specialistId,
            taskId,
            text: normalizedChunk.content
          })
        }
      },

      allComplete: async (): Promise<void> => {
        try {
          await this.onExecutionComplete(
            conversationId,
            tasks,
            mode,
            accumulatedContent,
            taskResultMap,
            startTime
          )
        } finally {
          dispose?.()
        }
      },

      taskRetry: (retryInfo: any): void => {
        this.mainWindow.webContents.send(IPC_CHANNELS.AGENT_TASK_RETRY, retryInfo)
      },

      taskProgress: (progress: any): void => {
        const p = progress as TaskExecutionProgress
        if (p.status === 'completed' || p.status === 'failed') {
          taskResultMap.set(p.taskId, {
            status: p.status,
            error: p.error,
            specialist: p.specialist
          })
        }
        this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_TASK_PROGRESS, p)
      },

      agentStatus: (agentStatus: any): void => {
        this.mainWindow.webContents.send(
          IPC_CHANNELS.AGENT_STATUS_UPDATE,
          agentStatus as AgentStatus
        )
      },

      abandonmentDetected: (data: any): void => {
        this.mainWindow.webContents.send(IPC_CHANNELS.AGENT_ABANDONMENT_DETECTED, data)
      },

      gateFailure: (data: any): void => {
        this.mainWindow.webContents.send(IPC_CHANNELS.AGENT_GATE_FAILURE, data)
      },

      bugCouncilActivated: (data: any): void => {
        this.mainWindow.webContents.send(IPC_CHANNELS.BUG_COUNCIL_ACTIVATED, data)
      },

      bugCouncilComplete: (data: any): void => {
        this.mainWindow.webContents.send(IPC_CHANNELS.BUG_COUNCIL_COMPLETE, data)
      }
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */

    dispose = attachPoolListeners(specialistPoolService, handlers)

    // ── Run execution ──
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

      eventLoggerService.logPlanExecutionFailed({
        conversationId,
        strategy: 'subagent' as ExecutionStrategy,
        error: (error as Error).message
      })

      const errorMsg = `**Execution Error:** ${(error as Error).message}`
      const savedMsg = messageRepository.create(conversationId, 'generalist', errorMsg)
      this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
        conversationId,
        chunk: errorMsg,
        role: 'generalist'
      })
      this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, {
        conversationId,
        messageId: savedMsg.id
      })
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
    taskResultMap: Map<string, { status: string; error?: string; specialist: string }>,
    startTime?: number
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
          error: result?.error
        }
      }),
      totalDuration: startTime ? Date.now() - startTime : 0,
      mode
    }

    const summaryJson = JSON.stringify(buildSummary)
    const summaryBlock = `\`\`\`build-summary\n${summaryJson}\n\`\`\``

    // Determine primary specialist for attribution (last task's specialist, or first)
    const primarySpecialist = tasks.length > 0 ? tasks[tasks.length - 1].specialist : undefined

    this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
      conversationId,
      chunk: `\n\n${summaryBlock}\n`,
      role: 'specialist',
      specialist: primarySpecialist
    })
    accumulatedContent.value += `\n\n${summaryBlock}\n`

    const savedMsg = messageRepository.create(
      conversationId,
      'specialist',
      accumulatedContent.value || '_No response from specialist execution._',
      primarySpecialist
    )
    this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, {
      conversationId,
      messageId: savedMsg.id
    })

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
        const taskDescriptions = tasks
          .map((t) => `- ${t.specialist}: ${t.description}`)
          .join('\n')
        await generalistService.injectContext(
          `[Specialist execution complete — ${tasks.length} task(s)]\n\nTasks executed:\n${taskDescriptions}\n\nResults summary:\n${contextToInject}`,
          conversationId
        )
        log.info(
          `[PIPELINE:context-injection] Injected ${contextToInject.length} chars`
        )
      }
    } catch (e) {
      log.warn('Context injection after specialist execution failed:', e)
    }
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
