import { ipcMain, type BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import {
  conversationRepository,
  messageRepository,
  fileChangeRepository,
  workspaceRepository
} from '../db/repositories'
import {
  generalistService,
  orchestratorService,
  specialistPoolService,
  costTrackerService
} from '../services'
import type { StreamChunk } from '../services'
import { IPC_CHANNELS } from '../../shared/constants'
import type {
  ConversationMode,
  DecomposedTask,
  ExecutionStrategy,
  HandoffBrief,
  TaskExecutionProgress
} from '../../shared/types'
import { memoryService } from '../services/memory.service'
import { buildEnvWithPath } from '../services/env-utils'
import { chatIpcLogger } from '../logger'
import { eventLoggerService } from '../services/event-logger.service'
import { validateSender } from './validate-sender'
import { forwardChunkToRenderer, isMemoryEnabled, isPostReviewEnabled } from './chat-shared'

const log = chatIpcLogger

/**
 * Spawns a short-lived review agent in plan mode to examine the combined
 * specialist output and report issues. Opt-in via workspace setting.
 */
async function runPostSpecialistReview(
  mainWindow: BrowserWindow,
  conversationId: string,
  tasks: DecomposedTask[],
  workspacePath: string
): Promise<void> {
  const taskSummary = tasks
    .map((t) => `- ${t.specialist} (${t.id}): ${t.description}`)
    .join('\n')

  const reviewPrompt = `Review the changes made by the following specialist tasks for integration issues, bugs, or convention violations:

${taskSummary}

Check:
1. Are there any obvious integration conflicts between the tasks?
2. Do the changes follow the project conventions from CLAUDE.md?
3. Are there any missing imports, type errors, or broken references?
4. Any security concerns?

Be concise. Only report actual issues found — do not speculate. If everything looks good, say so briefly.`

  const env = buildEnvWithPath()

  return new Promise<void>((resolve) => {
    const child = spawn(
      'claude',
      ['-p', reviewPrompt, '--permission-mode', 'plan', '--output-format', 'text'],
      { cwd: workspacePath, stdio: ['ignore', 'pipe', 'pipe'], env }
    )

    let output = ''
    child.stdout?.on('data', (data: Buffer) => {
      output += data.toString()
    })
    child.stderr?.on('data', (data: Buffer) => {
      log.warn('Review agent stderr:', data.toString().substring(0, 200))
    })
    child.on('exit', (code) => {
      if (code === 0 && output.trim()) {
        const reviewContent = `## 🔍 Post-Execution Review\n\n${output.trim()}`
        const savedMsg = messageRepository.create(conversationId, 'coordinator', reviewContent)
        mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
          conversationId,
          chunk: reviewContent,
          role: 'coordinator'
        })
        mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, {
          conversationId,
          messageId: savedMsg.id
        })
      }
      resolve()
    })
    child.on('error', () => resolve())

    // 60s timeout for review
    setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      resolve()
    }, 60000)
  })
}

/**
 * Fallback: runs the orchestrator in single-process mode (legacy behavior)
 * when task decomposition fails.
 */
export async function runLegacyOrchestrator(
  mainWindow: BrowserWindow,
  conversationId: string,
  handoff: HandoffBrief
): Promise<void> {
  const orchestratorContent = { value: '' }

  const onOrchestratorChunk = (chunk: StreamChunk): void => {
    forwardChunkToRenderer(mainWindow, conversationId, 'coordinator', chunk, orchestratorContent)
  }

  const onOrchestratorComplete = (): void => {
    const savedMsg = messageRepository.create(
      conversationId,
      'coordinator',
      orchestratorContent.value || '_No response received from orchestrator._'
    )

    mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, {
      conversationId,
      messageId: savedMsg.id
    })

    orchestratorService.removeListener('chunk', onOrchestratorChunk)
    orchestratorService.removeListener('complete', onOrchestratorComplete)
  }

  orchestratorService.on('chunk', onOrchestratorChunk)
  orchestratorService.on('complete', onOrchestratorComplete)
  await orchestratorService.send(handoff.summary, conversationId, handoff.mode)
}

export function registerChatPlanIpc(mainWindow: BrowserWindow): void {
  // ── Forward specialist pool events to renderer ──
  specialistPoolService.on('abandonmentDetected', (data) => {
    mainWindow.webContents.send(IPC_CHANNELS.AGENT_ABANDONMENT_DETECTED, data)
  })

  specialistPoolService.on('gateFailure', (data) => {
    mainWindow.webContents.send(IPC_CHANNELS.AGENT_GATE_FAILURE, data)
  })

  // ── Forward cost tracker budget events to renderer ──
  costTrackerService.on('budgetWarning', (data) => {
    mainWindow.webContents.send(IPC_CHANNELS.COST_BUDGET_WARNING, data)
  })

  costTrackerService.on('budgetExceeded', (data) => {
    mainWindow.webContents.send(IPC_CHANNELS.COST_BUDGET_EXCEEDED, data)
  })

  // ── Execute task plan (user chose sequential or parallel) ──
  ipcMain.handle(
    IPC_CHANNELS.CHAT_EXECUTE_PLAN,
    async (
      event,
      args: { conversationId: string; strategy: ExecutionStrategy; tasks: DecomposedTask[] }
    ) => {
      validateSender(event)

      const { conversationId, strategy, tasks } = args
      log.info(
        `Executing plan: strategy=${strategy}, tasks=${tasks.length}, conversation=${conversationId}`
      )

      // ── Event: plan execution started ──
      eventLoggerService.logPlanExecutionStarted({
        conversationId,
        strategy,
        taskCount: tasks.length
      })

      // Determine mode from conversation
      const conversation = conversationRepository.findById(conversationId)
      const mode: ConversationMode = (conversation?.mode as ConversationMode) ?? 'build'

      // Set workspace path on the pool service
      const workspacePath = generalistService.getWorkspacePath()
      if (!workspacePath) {
        throw new Error('No workspace path — generalist not started')
      }
      specialistPoolService.setWorkspacePath(workspacePath)
      specialistPoolService.setConversationId(conversationId)

      // Pass the enriched handoff brief to the specialist pool for context injection
      const taskPlanBrief = (args as { brief?: HandoffBrief }).brief ?? null
      specialistPoolService.setConversationBrief(taskPlanBrief)

      // ── Per-task content tracking for message segmentation ──
      const taskContents = new Map<string, string>()
      /** Tracks final status of each task for context injection into generalist */
      const taskStatuses = new Map<string, string>()

      // Forward task progress events to the renderer
      const onTaskProgress = (progress: TaskExecutionProgress): void => {
        mainWindow.webContents.send(IPC_CHANNELS.CHAT_TASK_PROGRESS, progress)

        // Track final status for context injection into generalist
        taskStatuses.set(progress.taskId, progress.status)

        // When a task completes or fails, save its accumulated content as a separate message
        if (progress.status === 'completed' || progress.status === 'failed') {
          const taskContent = taskContents.get(progress.taskId)
          if (taskContent) {
            const task = tasks.find((t) => t.id === progress.taskId)
            const statusEmoji = progress.status === 'completed' ? '✅' : '❌'
            const header = `### ${statusEmoji} ${progress.specialist} — ${task?.description ?? progress.taskId}\n\n`
            const savedMsg = messageRepository.create(
              conversationId,
              'specialist',
              header + taskContent,
              progress.specialist
            )

            // Complete this task's message in the renderer
            mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, {
              conversationId,
              messageId: savedMsg.id,
              taskId: progress.taskId
            })

            taskContents.delete(progress.taskId)
          }
        }

        // Emit agent status updates so the AgentMonitor panel tracks each specialist
        mainWindow.webContents.send(IPC_CHANNELS.AGENT_STATUS_UPDATE, {
          agentId: `${progress.specialist}-${progress.taskId}`,
          agentType: progress.specialist,
          status:
            progress.status === 'running'
              ? 'writing'
              : progress.status === 'completed'
                ? 'completed'
                : progress.status === 'failed'
                  ? 'failed'
                  : 'idle',
          currentTask: tasks.find((t) => t.id === progress.taskId)?.description,
          elapsedMs: 0,
          tokenUsage: 0,
          model: progress.model,
          complexityTier: progress.complexityTier
        })
      }

      // Forward streaming chunks from each specialist to the chat AND agent monitor
      const onTaskChunk = (data: { taskId: string; specialist: string; chunk: string }): void => {
        // Accumulate per-task content for message segmentation
        const existing = taskContents.get(data.taskId) ?? ''
        taskContents.set(data.taskId, existing + data.chunk)

        mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
          conversationId,
          chunk: data.chunk,
          role: 'coordinator',
          taskId: data.taskId,
          specialist: data.specialist
        })

        // Also send to agent monitor for live output display
        // Use composite key matching AGENT_STATUS_UPDATE's agentId format
        mainWindow.webContents.send(IPC_CHANNELS.AGENT_TASK_CHUNK, {
          agentId: `${data.specialist}-${data.taskId}`,
          taskId: data.taskId,
          text: data.chunk
        })
      }

      const onAllComplete = async (): Promise<void> => {
        log.info('All specialist tasks completed')

        // ── Event: plan execution completed ──
        eventLoggerService.logPlanExecutionCompleted({
          conversationId,
          strategy,
          taskCount: tasks.length
        })

        // Save a SHORT summary message — individual task content already saved per-task
        const summaryLines = tasks
          .map((t) => `- **${t.specialist}** (${t.id}): ${t.description}`)
          .join('\n')
        const summaryContent = `## ✅ All Tasks Complete (${strategy})\n\n${summaryLines}`
        const savedMsg = messageRepository.create(conversationId, 'coordinator', summaryContent)

        mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, {
          conversationId,
          messageId: savedMsg.id
        })

        // Log task execution as a project memory
        try {
          const wpPath = generalistService.getWorkspacePath()
          if (wpPath && isMemoryEnabled(wpPath)) {
            const allWs = workspaceRepository.findAll()
            const ws = allWs.find((w) => w.repoPath === wpPath)
            if (ws) {
              memoryService.create({
                workspaceId: ws.id,
                type: 'project',
                title: `Task execution: ${tasks.length} tasks (${strategy})`,
                content: tasks.map((t) => `- ${t.specialist}: ${t.description}`).join('\n'),
                tags: ['task-execution'],
                importance: 4
              })
            }
          }
        } catch (e) {
          log.warn('Memory update on task complete failed:', e)
        }

        // Post-specialist code review (opt-in via workspace settings)
        try {
          const wpPath = generalistService.getWorkspacePath()
          if (wpPath && isPostReviewEnabled(wpPath)) {
            log.info('Post-specialist review enabled — spawning review agent')
            runPostSpecialistReview(mainWindow, conversationId, tasks, wpPath).catch((e) => {
              log.warn('Post-specialist review failed:', e)
            })
          }
        } catch (e) {
          log.warn('Post-review check failed:', e)
        }

        // ── Feed results back to generalist for follow-up context ──
        try {
          const taskResultLines = tasks
            .map((t) => {
              const rawStatus = taskStatuses.get(t.id) ?? 'unknown'
              const status = rawStatus === 'completed' ? '✅ completed' : `❌ ${rawStatus}`
              return `- ${t.specialist} (${t.id}): ${t.description} → ${status}`
            })
            .join('\n')

          const contextMessage = [
            `[SYSTEM CONTEXT UPDATE — Orchestrator/Specialist Execution Complete]`,
            ``,
            `The following task plan was executed (strategy: ${strategy}):`,
            ``,
            taskResultLines,
            ``,
            `Internalize these results. The user may ask follow-up questions about task outcomes.`,
            `Do NOT use tools to investigate. Do NOT produce a visible response.`,
            `Simply wait for the user's next message.`
          ].join('\n')

          await generalistService.injectContext(contextMessage, conversationId)
        } catch (feedbackErr) {
          log.warn('Failed to inject task results into generalist:', feedbackErr)
        }

        // Clean up
        specialistPoolService.removeListener('taskProgress', onTaskProgress)
        specialistPoolService.removeListener('taskChunk', onTaskChunk)
        specialistPoolService.removeListener('taskRetry', onTaskRetry)
        specialistPoolService.removeListener('allComplete', onAllComplete)
      }

      // Forward retry events to renderer
      const onTaskRetry = (data: {
        taskId: string
        specialist: string
        attempt: number
        maxRetries: number
      }): void => {
        mainWindow.webContents.send(IPC_CHANNELS.AGENT_TASK_RETRY, data)
        // Also send as a chat chunk so the user sees the retry notification
        mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
          conversationId,
          chunk: `\n> **${data.specialist}** failed — retrying (attempt ${data.attempt + 1}/${data.maxRetries + 1})...\n\n`,
          role: 'coordinator'
        })
      }

      specialistPoolService.on('taskProgress', onTaskProgress)
      specialistPoolService.on('taskChunk', onTaskChunk)
      specialistPoolService.on('taskRetry', onTaskRetry)
      specialistPoolService.on('allComplete', onAllComplete)

      try {
        if (strategy === 'parallel') {
          await specialistPoolService.executeParallel(tasks, mode)
        } else {
          await specialistPoolService.executeSequential(tasks, mode)
        }
      } catch (error) {
        log.error('Plan execution failed:', error)

        // ── Event: plan execution failed ──
        eventLoggerService.logPlanExecutionFailed({
          conversationId,
          strategy,
          error: (error as Error).message
        })

        const errorMsg = `**Execution Error:** ${(error as Error).message}`
        const savedMsg = messageRepository.create(conversationId, 'coordinator', errorMsg)

        mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
          conversationId,
          chunk: errorMsg,
          role: 'coordinator'
        })
        mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, {
          conversationId,
          messageId: savedMsg.id
        })
      }
    }
  )

  // ── PR Description Auto-Generation ──
  ipcMain.handle(
    IPC_CHANNELS.CHAT_GENERATE_PR_DESCRIPTION,
    async (event, args: { conversationId: string }) => {
      validateSender(event)
      if (!args?.conversationId) throw new Error('Missing conversationId')

      const conversation = conversationRepository.findById(args.conversationId)
      if (!conversation) throw new Error('Conversation not found')

      // Gather context: conversation messages + file changes
      const messages = messageRepository.findByConversation(args.conversationId)
      const fileChanges = fileChangeRepository.findByConversation(args.conversationId)

      const prompt = `You are writing a GitHub Pull Request description. Be concise and professional.

Based on this conversation between a developer and an AI assistant, generate a PR description.

## Conversation Summary (last ${Math.min(messages.length, 20)} messages):
${messages
  .slice(-20)
  .map((m) => `[${m.role}]: ${m.contentMd.slice(0, 500)}`)
  .join('\n')}

## Files Changed (${fileChanges.length}):
${fileChanges.map((fc) => `- ${fc.changeType}: ${fc.filePath}`).join('\n')}

Generate a PR description in this format:
## Summary
<2-4 bullet points describing what was done and why>

## Changes
<grouped list of changes by area/feature>

## Notes
<any important notes for reviewers, or "None" if nothing special>

Respond with ONLY the markdown content, no preamble.`

      // Spawn claude -p (one-shot, no streaming)
      const env = buildEnvWithPath()
      const result = await new Promise<string>((resolve, reject) => {
        const child = spawn('claude', ['-p', prompt, '--output-format', 'text'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env
        })

        let stdout = ''
        child.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString()
        })
        child.on('exit', (code) => {
          if (code === 0) resolve(stdout.trim())
          else reject(new Error(`PR description generation failed (code ${code})`))
        })
        child.on('error', reject)

        // 30s timeout
        setTimeout(() => {
          try {
            child.kill('SIGTERM')
          } catch {
            /* ignore */
          }
          reject(new Error('PR description generation timed out'))
        }, 30000)
      })

      return { description: result }
    }
  )
}
