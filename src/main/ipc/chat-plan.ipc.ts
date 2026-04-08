import { spawn } from 'node:child_process'
import { ipcMain, type BrowserWindow } from 'electron'
import { conversationRepository, fileChangeRepository, messageRepository } from '../db/repositories'
import { costTrackerService } from '../services'
import { IPC_CHANNELS } from '../../shared/constants'
import type {
  DecomposedTask,
  ExecutionStrategy,
  HandoffBrief,
  InvestigationDepth,
  InvestigationReport,
  StructuredPlan
} from '../../shared/types'
import { taskPipeline } from '../services/task-pipeline.service'
import { buildEnvWithPath } from '../services/env-utils'
import { chatIpcLogger } from '../logger'
import { validateSender } from './validate-sender'

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
      await taskPipeline.execute({
        conversationId: args.conversationId,
        tasks: args.tasks,
        brief: (args as { brief?: HandoffBrief }).brief ?? null,
        investigationDepth: args.investigationDepth
      })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_EXECUTE_INVESTIGATION_FIX,
    async (
      event,
      args: { conversationId: string; strategy: ExecutionStrategy; report: InvestigationReport }
    ) => {
      validateSender(event)

      await taskPipeline.prepare({
        type: 'investigationFix',
        conversationId: args.conversationId,
        report: args.report,
        autoExecuteStrategy: args.strategy
      })
    }
  )

  // ── Direct plan-to-build: skip generalist round-trip ──
  ipcMain.handle(
    IPC_CHANNELS.CHAT_BUILD_FROM_PLAN,
    async (
      event,
      args: {
        conversationId: string
        plan: StructuredPlan
        planContent: string
      }
    ) => {
      validateSender(event)
      if (!args?.conversationId) throw new Error('Missing conversationId')
      if (!args?.plan) throw new Error('Missing structured plan')

      log.info(
        `[IPC:buildFromPlan] Direct plan execution for conversation=${args.conversationId}, steps=${args.plan.steps?.length ?? 0}`
      )

      await taskPipeline.prepare({
        type: 'planExecution',
        conversationId: args.conversationId,
        plan: args.plan,
        planContent: args.planContent
      })
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
        child.on('exit', (code: number | null) => {
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
