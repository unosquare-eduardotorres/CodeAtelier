import { ipcMain, type BrowserWindow } from 'electron'
import {
  conversationRepository,
  messageRepository,
  fileChangeRepository,
  workspaceRepository
} from '../db/repositories'
import { generalistService, costTrackerService } from '../services'
import type { StreamChunk } from '../services'
import { IPC_CHANNELS } from '../../shared/constants'
import type {
  ConversationMode,
  DecomposedTask,
  ExecutionStrategy,
  HandoffBrief,
  InvestigationDepth,
  InvestigationReport
} from '../../shared/types'
import { specialistPoolService } from '../services/specialist-pool.service'
import { buildEnvWithPath } from '../services/env-utils'
import { chatIpcLogger } from '../logger'
import { eventLoggerService } from '../services/event-logger.service'
import { validateSender } from './validate-sender'
import { forwardChunkToRenderer } from './chat-shared'

const log = chatIpcLogger

export function registerChatPlanIpc(mainWindow: BrowserWindow): void {
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
      args: {
        conversationId: string
        strategy: ExecutionStrategy
        tasks: DecomposedTask[]
        investigationDepth?: InvestigationDepth
      }
    ) => {
      validateSender(event)
      const { conversationId, tasks } = args

      log.info(
        `Executing plan via SubAgents: tasks=${tasks.length}, conversation=${conversationId}`
      )

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

      const taskPlanBrief = (args as { brief?: HandoffBrief }).brief ?? null
      const accumulatedContent = { value: '' }
      specialistPoolService.setWorkspacePath(workspacePath)
      // Pass workspaceId so specialists can access MCP tools (code-graph, semantic-search)
      const ws = workspaceRepository.findAll().find((w) => w.repoPath === workspacePath)
      if (ws) specialistPoolService.setWorkspaceId(ws.id)
      specialistPoolService.setConversationBrief(taskPlanBrief)
      specialistPoolService.setConversationId(conversationId)
      if (args.investigationDepth) {
        specialistPoolService.setInvestigationDepth(args.investigationDepth)
      }

      const poolOnChunk = ({
        taskId,
        specialist: specialistId,
        chunk: taskChunk,
        toolActivity
      }: {
        taskId: string
        specialist: string
        chunk: string | StreamChunk
        toolActivity?: {
          type: 'tool_use' | 'tool_result'
          toolName?: string
          toolId?: string
          input?: string
        }
      }): void => {
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
          mainWindow,
          conversationId,
          'specialist',
          normalizedChunk,
          accumulatedContent,
          workspacePath ?? undefined,
          { specialist: specialistId, taskId }
        )
      }

      const poolOnComplete = async (): Promise<void> => {
        log.info('Direct pool execution complete')

        if (!accumulatedContent.value.trim()) {
          log.warn(`[PIPELINE:empty-specialist-output] conversationId=${conversationId} — specialist produced no text`)
        }

        eventLoggerService.logPlanExecutionCompleted({
          conversationId,
          strategy: 'subagent' as ExecutionStrategy,
          taskCount: tasks.length
        })

        const savedMsg = messageRepository.create(
          conversationId,
          'generalist',
          accumulatedContent.value || '_No response from specialist execution._'
        )

        mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, {
          conversationId,
          messageId: savedMsg.id
        })

        // Strategy ι: Extract just the investigation report JSON from the specialist output
        // for injection, instead of the full raw output. This reduces the lazy injection payload
        // from ~4K chars to ~200 chars (structured report) or ~1K chars (fallback).
        // Saves ~230-860 tokens on the next user message.
        try {
          const rawOutput = accumulatedContent.value
          const reportMatch = rawOutput.match(/```investigation-report\s*\n([\s\S]*?)```/)
          let contextToInject: string

          if (reportMatch) {
            // Structured report found — inject only the parsed report (compact)
            contextToInject = `Investigation result: ${reportMatch[1].trim()}`
            log.info(
              `[PIPELINE:context-injection-dedup] Extracted investigation report (${contextToInject.length} chars vs ${rawOutput.length} raw)`
            )
          } else {
            // No structured report — truncate raw output to 1K chars
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
              `[PIPELINE:context-injection] Injected ${contextToInject.length} chars of specialist results into generalist context`
            )
          }
        } catch (e) {
          log.warn('Context injection after specialist execution failed:', e)
        }

        specialistPoolService.removeListener('taskChunk', poolOnChunk)
        specialistPoolService.removeListener('allComplete', poolOnComplete)
        specialistPoolService.removeListener('taskRetry', poolOnRetry)
        specialistPoolService.removeListener('taskProgress', poolOnTaskProgress)
      }

      // Forward task retry events to renderer for UI visibility
      const poolOnRetry = (retryInfo: {
        taskId: string
        specialist: string
        attempt: number
        maxRetries: number
        escalation?: { fromModel: string; toModel: string }
        reason: string
      }): void => {
        mainWindow.webContents.send(IPC_CHANNELS.AGENT_TASK_RETRY, retryInfo)
      }

      // Forward task progress events to renderer for UI updates (e.g. "1/3 done")
      const poolOnTaskProgress = (progress: {
        taskId: string
        specialist: string
        status: string
      }): void => {
        mainWindow.webContents.send(IPC_CHANNELS.CHAT_TASK_PROGRESS, progress)
      }

      specialistPoolService.on('taskChunk', poolOnChunk)
      specialistPoolService.on('allComplete', poolOnComplete)
      specialistPoolService.on('taskRetry', poolOnRetry)
      specialistPoolService.on('taskProgress', poolOnTaskProgress)

      try {
        const hasDependencies = tasks.some((task) => (task.dependsOn?.length ?? 0) > 0)
        if (hasDependencies) {
          await specialistPoolService.executeSequential(tasks, mode)
        } else {
          await specialistPoolService.executeParallel(tasks, mode)
        }
      } catch (error) {
        log.error('SubAgent plan execution failed:', error)

        eventLoggerService.logPlanExecutionFailed({
          conversationId,
          strategy: 'subagent' as ExecutionStrategy,
          error: (error as Error).message
        })

        const errorMsg = `**Execution Error:** ${(error as Error).message}`
        const savedMsg = messageRepository.create(conversationId, 'generalist', errorMsg)

        mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
          conversationId,
          chunk: errorMsg,
          role: 'generalist'
        })
        mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, {
          conversationId,
          messageId: savedMsg.id
        })

        specialistPoolService.removeListener('taskChunk', poolOnChunk)
        specialistPoolService.removeListener('allComplete', poolOnComplete)
        specialistPoolService.removeListener('taskRetry', poolOnRetry)
        specialistPoolService.removeListener('taskProgress', poolOnTaskProgress)
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_EXECUTE_INVESTIGATION_FIX,
    async (
      event,
      args: { conversationId: string; strategy: ExecutionStrategy; report: InvestigationReport }
    ) => {
      validateSender(event)
      const { conversationId, strategy, report } = args

      // Auto-switch to build mode
      const conversation = conversationRepository.findById(conversationId)
      if (conversation?.mode === 'plan') {
        conversationRepository.updateMode(conversationId, 'build')
        generalistService.switchMode('build')
        log.info('Auto-switched to build mode for investigation fix')
      }

      // Build fix-oriented HandoffBrief
      const fixBrief: HandoffBrief = {
        summary: `Fix: ${report.proposedFix}`,
        decisions: [],
        constraints: [],
        filesDiscussed: report.filesAffected.map((f) => f.path),
        recentMessages: [],
        specialists: [],
        mode: 'build'
      }

      // Notify renderer of mode change
      mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
        conversationId,
        chunk: '\n> **Mode switched to Build** — executing fix plan.\n\n',
        role: 'generalist'
      })

      // Decompose into fix tasks
      const taskPlan = await generalistService.decompose(fixBrief, conversationId, 'build')

      // Send plan WITH autoExecute flag — renderer will call CHAT_EXECUTE_PLAN with proper listeners
      mainWindow.webContents.send(IPC_CHANNELS.CHAT_TASK_PLAN, {
        ...taskPlan,
        brief: fixBrief,
        autoExecute: strategy
      })

      // DO NOT call specialistPoolService.execute*() here — that path has no listeners.
      // The renderer's onTaskPlan handler will auto-execute via executePlan() which calls
      // CHAT_EXECUTE_PLAN — the properly wired path with all event listeners.
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
