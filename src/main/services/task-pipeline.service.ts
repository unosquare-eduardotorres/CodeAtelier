import type { BrowserWindow } from 'electron'
import type {
  AgentStatus,
  ConversationMode,
  DecomposedTask,
  ExecutionStrategy,
  HandoffBrief,
  InvestigationDepth,
  InvestigationReport,
  TaskExecutionProgress
} from '../../shared/types'
import { IPC_CHANNELS } from '../../shared/constants'
import {
  conversationRepository,
  messageRepository,
  workspaceRepository,
  specialistRepository
} from '../db/repositories'
import { generalistService } from '../services'
import type { StreamChunk } from '../services'
import { specialistPoolService } from './specialist-pool.service'
import { eventLoggerService } from './event-logger.service'
import { isInvestigationIntent } from './specialist'
import { forwardChunkToRenderer } from '../ipc/chat-shared'
import { chatIpcLogger } from '../logger'

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

export type PrepareOptions = HandoffPrepare | InvestigationFixPrepare

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
        const isInvestigation = isInvestigationIntent(brief.summary)
        const effectiveMode: ConversationMode =
          conversation?.mode === 'build' && !isInvestigation ? 'build' : 'plan'

        if (effectiveMode !== brief.mode) {
          log.info(
            `[PIPELINE:mode-resolve] effectiveMode=${effectiveMode} (conversation=${conversation?.mode}, investigation=${isInvestigation}, brief=${brief.mode})`
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
    }

    const { brief, effectiveMode, autoExecuteStrategy, enrichMessages, notifications } = config

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
              const spec = specialistRepository.findByAgentId(id)
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

    // ── Step 5: Decompose ──
    try {
      log.info(`[PIPELINE:decompose-starting] specialists=${brief.specialists.join(',')}`)
      const taskPlan = await generalistService.decompose(brief, conversationId, effectiveMode)
      log.info(`[PIPELINE:decompose-complete] taskCount=${taskPlan.tasks.length}`)

      // ── Step 6: Present to renderer ──
      const autoExecute =
        autoExecuteStrategy ?? (taskPlan.mode === 'build' ? ('sequential' as ExecutionStrategy) : undefined)
      if (autoExecute) {
        this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_TASK_PLAN, {
          ...taskPlan,
          brief,
          autoExecute
        })
      } else {
        this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_TASK_PLAN, taskPlan)
      }
      log.info(
        `[PIPELINE:task-plan-sent] taskCount=${taskPlan.tasks.length} autoExecute=${!!autoExecute}`
      )
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

    eventLoggerService.logPlanExecutionStarted({
      conversationId,
      strategy: 'subagent' as ExecutionStrategy,
      taskCount: tasks.length
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
      },

      allComplete: async (): Promise<void> => {
        try {
          await this.onExecutionComplete(
            conversationId,
            tasks,
            mode,
            accumulatedContent,
            taskResultMap
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
    taskResultMap: Map<string, { status: string; error?: string; specialist: string }>
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

    // Build structured completion summary
    const summaryLines: string[] = []
    summaryLines.push(`## Execution Complete\n`)
    summaryLines.push(`**${tasks.length} task(s)** executed in ${mode} mode.\n`)

    for (const task of tasks) {
      const result = taskResultMap.get(task.id)
      const status = result?.status === 'failed' ? '❌' : '✅'
      summaryLines.push(`${status} **${task.specialist}**: ${task.description}`)
      if (result?.error) {
        summaryLines.push(`  → Error: ${result.error}`)
      }
    }

    const summaryBlock = summaryLines.join('\n')

    this.mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
      conversationId,
      chunk: `\n\n---\n\n${summaryBlock}\n`,
      role: 'generalist'
    })
    accumulatedContent.value += `\n\n---\n\n${summaryBlock}\n`

    const savedMsg = messageRepository.create(
      conversationId,
      'generalist',
      accumulatedContent.value || '_No response from specialist execution._'
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
        contextToInject = rawOutput.substring(0, 1000)
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
