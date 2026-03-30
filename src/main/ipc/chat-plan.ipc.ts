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
  costTrackerService
} from '../services'
import type { StreamChunk } from '../services'
import { IPC_CHANNELS } from '../../shared/constants'
import type {
  ConversationMode,
  DecomposedTask,
  ExecutionStrategy,
  HandoffBrief,
  InvestigationReport,
  TaskPlan
} from '../../shared/types'
import { memoryService } from '../services/memory.service'
import { buildEnvWithPath } from '../services/env-utils'
import { chatIpcLogger } from '../logger'
import { eventLoggerService } from '../services/event-logger.service'
import { validateSender } from './validate-sender'
import { forwardChunkToRenderer, isMemoryEnabled } from './chat-shared'

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
  const taskSummary = tasks.map((t) => `- ${t.specialist} (${t.id}): ${t.description}`).join('\n')

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
      args: { conversationId: string; strategy: ExecutionStrategy; tasks: DecomposedTask[] }
    ) => {
      validateSender(event)
      const { conversationId, tasks } = args

      log.info(`Executing plan via SubAgents: tasks=${tasks.length}, conversation=${conversationId}`)

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
      const taskPlan: TaskPlan = {
        conversationId,
        summary: tasks.map((t) => t.description).join('; '),
        mode,
        tasks,
        brief: taskPlanBrief ?? undefined
      }

      const accumulatedContent = { value: '' }

      const onChunk = (chunk: StreamChunk): void => {
        if (chunk.type === 'text' && chunk.content) {
          accumulatedContent.value += chunk.content
        }
        forwardChunkToRenderer(mainWindow, conversationId, 'coordinator', chunk, accumulatedContent)
      }

      const onComplete = async (): Promise<void> => {
        log.info('SubAgent execution complete')

        eventLoggerService.logPlanExecutionCompleted({
          conversationId,
          strategy: 'subagent' as ExecutionStrategy,
          taskCount: tasks.length
        })

        const savedMsg = messageRepository.create(
          conversationId,
          'coordinator',
          accumulatedContent.value || '_No response from SubAgent execution._'
        )

        mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, {
          conversationId,
          messageId: savedMsg.id
        })

        try {
          if (workspacePath && isMemoryEnabled(workspacePath)) {
            const allWs = workspaceRepository.findAll()
            const ws = allWs.find((w) => w.repoPath === workspacePath)
            if (ws) {
              memoryService.create({
                workspaceId: ws.id,
                type: 'project',
                title: `Task execution: ${tasks.length} tasks (SubAgent)`,
                content: tasks.map((t) => `- ${t.specialist}: ${t.description}`).join('\n'),
                tags: ['task-execution'],
                importance: 4
              })
            }
          }
        } catch (e) {
          log.warn('Memory update on task complete failed:', e)
        }

        generalistService.removeListener('chunk', onChunk)
        generalistService.removeListener('subAgentsComplete', onComplete)
      }

      generalistService.on('chunk', onChunk)
      generalistService.on('subAgentsComplete', onComplete)

      try {
        await generalistService.executeWithSubAgents(taskPlan, mode, conversationId)
      } catch (error) {
        log.error('SubAgent plan execution failed:', error)

        eventLoggerService.logPlanExecutionFailed({
          conversationId,
          strategy: 'subagent' as ExecutionStrategy,
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

        generalistService.removeListener('chunk', onChunk)
        generalistService.removeListener('subAgentsComplete', onComplete)
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
        role: 'coordinator'
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
