import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AgentStatus,
  ConversationMode,
  DecomposedTask,
  Skill,
  TaskPlan
} from '../../shared/types'
import { AGENT_IDS } from '../../shared/constants'
import { orchestratorLogger } from '../logger'
import { skillRepository, specialistRepository } from '../db/repositories'
import {
  PLAN_MODE_SYSTEM_PROMPT,
  BUILD_MODE_SYSTEM_PROMPT,
  DECOMPOSITION_SYSTEM_PROMPT
} from './system-prompts'
import { AgentBaseService } from './agent-base.service'
import type { StreamChunk } from './agent-base.service'

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
    this.currentConversationId = conversationId ?? null
    this.emit('statusUpdate', this.getStatus())

    // ── Skill matching and routing ──
    let skillContext = ''
    try {
      const activeSkills = skillRepository.findActive()
      if (activeSkills.length > 0) {
        const matchedSkill = await this.matchSkill(message, activeSkills)
        if (matchedSkill) {
          const specialists = specialistRepository.findSpecialistsForSkill(matchedSkill.id)
          const targetSpecialist = specialists
            .filter((s) => s.isActive)
            .sort((a, b) => a.priority - b.priority)[0]

          skillContext = `\n\n[Skill Match] The task best matches the "${matchedSkill.name}" skill (${matchedSkill.description}).`
          if (targetSpecialist) {
            skillContext += ` Route to specialist: ${targetSpecialist.displayName} (${targetSpecialist.agentId}, priority ${targetSpecialist.priority}).`
            if (targetSpecialist.prompt) {
              skillContext += `\nSpecialist instructions: ${targetSpecialist.prompt}`
            }
          }
        }
      }
    } catch (error) {
      this.log.error('Skill matching failed, proceeding without:', error)
    }

    const augmentedMessage = skillContext ? `${message}${skillContext}` : message

    const args = [
      '-p',
      augmentedMessage,
      '--output-format',
      'stream-json',
      '--verbose',
      '--allowedTools',
      'WebSearch,WebFetch'
    ]

    if (mode === 'build') {
      args.push('--dangerously-skip-permissions')
    } else {
      args.push('--permission-mode', 'plan')
    }

    const existingSession = conversationId ? this.sessionMap.get(conversationId) : null
    if (existingSession) {
      args.push('--resume', existingSession)
    }

    const systemPromptValue = mode === 'plan' ? PLAN_MODE_SYSTEM_PROMPT : BUILD_MODE_SYSTEM_PROMPT
    if (!existingSession) {
      let workspaceContext = ''
      try {
        const claudeMdPath = join(this.workspacePath!, 'CLAUDE.md')
        workspaceContext = readFileSync(claudeMdPath, 'utf-8')
      } catch {
        // No CLAUDE.md in workspace — that's fine
      }

      const fullSystemPrompt = workspaceContext
        ? `${systemPromptValue}\n\n---\n\n## Workspace Project Context (from CLAUDE.md)\n\n${workspaceContext}`
        : systemPromptValue

      args.push('--system-prompt', fullSystemPrompt)
    }

    const env = this.buildEnvWithPath()

    this.log.info(
      'Spawning claude with args:',
      args.filter((a) => a !== augmentedMessage && a !== systemPromptValue).join(' ')
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
   * Decomposes a handoff summary into structured sub-tasks via a short `claude -p` call.
   * Returns a TaskPlan with decomposed tasks assigned to specialists.
   */
  async decompose(
    summary: string,
    specialists: string[],
    conversationId: string,
    mode: ConversationMode
  ): Promise<TaskPlan> {
    if (!this.workspacePath) {
      throw new Error('Orchestrator not started — no workspace path set')
    }

    // Build specialist list for the prompt
    const activeSpecialists = specialistRepository.findActive()
    const relevantSpecialists =
      specialists.length > 0
        ? activeSpecialists.filter((s) => specialists.includes(s.agentId))
        : activeSpecialists

    const specialistList = relevantSpecialists
      .map(
        (s) =>
          `- "${s.agentId}" — ${s.displayName}: ${s.prompt?.substring(0, 150) || 'General specialist'}`
      )
      .join('\n')

    const prompt = `Task to decompose: "${summary}"

Available specialists:
${specialistList}

Decompose this task into sub-tasks and respond with ONLY valid JSON.`

    this.log.info('Decomposing task for specialists:', specialists.join(', '))

    const env = this.buildEnvWithPath()

    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        'claude',
        ['-p', prompt, '--system-prompt', DECOMPOSITION_SYSTEM_PROMPT, '--output-format', 'text'],
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

    // Validate and normalize tasks
    const tasks: DecomposedTask[] = parsed.tasks.map((t, i) => ({
      id: t.id || `t${i + 1}`,
      specialist: t.specialist,
      description: t.description,
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : []
    }))

    this.log.info(`Decomposed into ${tasks.length} tasks`)

    return {
      conversationId,
      summary,
      mode,
      tasks
    }
  }

  /**
   * Uses an LLM call to semantically match the user message against active skills.
   */
  private async matchSkill(message: string, skills: Skill[]): Promise<Skill | null> {
    if (skills.length === 0) return null
    if (skills.length === 1) return skills[0]

    const skillList = skills
      .map((s, i) => `${i + 1}. "${s.name}" - ${s.description || 'No description'}`)
      .join('\n')

    const prompt = `Given the following user message and available skills, respond with ONLY the number of the best-matching skill. If none match well, respond with "0".

User message: "${message.substring(0, 500)}"

Available skills:
${skillList}

Respond with only a number (e.g., "1" or "0"):`

    try {
      const env = this.buildEnvWithPath()

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
          else reject(new Error(`Skill matching failed with code ${code}`))
        })
        child.on('error', reject)

        setTimeout(() => {
          try {
            child.kill('SIGTERM')
          } catch {
            /* ignore */
          }
          reject(new Error('Skill matching timed out'))
        }, 15000)
      })

      const index = parseInt(result, 10)
      if (index > 0 && index <= skills.length) {
        this.log.info(`Matched skill: ${skills[index - 1].name}`)
        return skills[index - 1]
      }
      return null
    } catch (error) {
      this.log.error('Skill matching error:', error)
      return null
    }
  }

  /**
   * Override to capture session IDs from result events.
   */
  protected onResultEvent(event: Record<string, unknown>): void {
    const sessionId = event.session_id as string | undefined
    if (sessionId && this.currentConversationId) {
      this.sessionMap.set(this.currentConversationId, sessionId)
      this.log.info('Session ID captured for conversation:', this.currentConversationId, sessionId)
    }

    // Call base implementation for text emission and status
    super.onResultEvent(event)
  }

  protected onSystemEvent(event: Record<string, unknown>): void {
    const sessionId = event.session_id as string | undefined
    if (sessionId && this.currentConversationId) {
      this.sessionMap.set(this.currentConversationId, sessionId)
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
