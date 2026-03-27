import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { dbLogger } from '../logger'
import { memoryRepository, dreamRunRepository } from '../db/repositories'
import { DREAM_MODEL_ID } from '../../shared/constants'
import { DREAM_SYSTEM_PROMPT } from './dream-prompts'
import type { DreamRun, DreamProgress, DreamTriggerType } from '../../shared/types'
import { buildEnvWithPath } from './env-utils'

const log = dbLogger

/** Maximum memories to process per dream run */
const MAX_MEMORIES_PER_RUN = 200
/** Timeout for the dream claude -p process (5 minutes) */
const DREAM_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Service that manages the "dream" consolidation process.
 *
 * Dreams are background processes that review, merge, prune, and synthesize
 * memories to keep the memory system clean and useful. They run via a
 * read-only `claude -p` process that only writes to the memories table.
 *
 * Events:
 * - 'progress': DreamProgress — phase updates
 * - 'complete': DreamRun — final result
 */
class DreamService extends EventEmitter {
  private currentProcess: ReturnType<typeof spawn> | null = null
  private currentRunId: string | null = null

  /**
   * Run a dream consolidation cycle for the given workspace.
   * Returns the completed DreamRun record.
   */
  async run(workspaceId: string, triggerType: DreamTriggerType): Promise<DreamRun> {
    // Check if already running
    const existing = dreamRunRepository.findRunning(workspaceId)
    if (existing) {
      throw new Error('A dream is already running for this workspace')
    }

    // Create the run record
    const dreamRun = dreamRunRepository.create(workspaceId, triggerType)
    this.currentRunId = dreamRun.id

    log.info(`Dream run ${dreamRun.id} started (trigger: ${triggerType})`)
    this.emitProgress('review', 'Reviewing memories...', 0, 0, 0)

    try {
      // Fetch all memories for this workspace
      const memories = memoryRepository.findByWorkspace(workspaceId)
      if (memories.length < 5) {
        log.info('Not enough memories to consolidate — skipping dream')
        const completed = dreamRunRepository.complete(dreamRun.id, {
          memoriesCreated: 0,
          memoriesMerged: 0,
          memoriesPruned: 0,
          tokenUsage: 0
        })
        this.emitProgress('complete', 'Not enough memories to consolidate', 0, 0, 0)
        this.emit('complete', completed)
        return completed
      }

      // Prepare the memory payload (truncate to stay within budget)
      const memoryPayload = memories.slice(0, MAX_MEMORIES_PER_RUN).map((m) => ({
        id: m.id,
        type: m.type,
        title: m.title,
        content: m.content.substring(0, 500),
        tags: m.tags,
        importance: m.importance,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt
      }))

      this.emitProgress('consolidate', `Analyzing ${memoryPayload.length} memories...`, 0, 0, 0)

      // Run the consolidation via claude -p
      const prompt = `Here are the current memories to consolidate:\n\n${JSON.stringify(memoryPayload, null, 2)}`
      const result = await this.spawnConsolidator(prompt)

      // Parse and apply the consolidation actions
      const stats = this.applyActions(result, workspaceId)

      this.emitProgress(
        'complete',
        `Dream complete: ${stats.created} created, ${stats.merged} merged, ${stats.pruned} pruned`,
        stats.created,
        stats.merged,
        stats.pruned
      )

      const completed = dreamRunRepository.complete(dreamRun.id, {
        memoriesCreated: stats.created,
        memoriesMerged: stats.merged,
        memoriesPruned: stats.pruned,
        tokenUsage: stats.tokenEstimate
      })

      this.emit('complete', completed)
      log.info(`Dream run ${dreamRun.id} completed:`, stats)
      return completed
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      log.error(`Dream run ${dreamRun.id} failed:`, error)

      const failed = dreamRunRepository.fail(dreamRun.id, msg)
      this.emitProgress('complete', `Dream failed: ${msg}`, 0, 0, 0)
      this.emit('complete', failed)
      return failed
    } finally {
      this.currentProcess = null
      this.currentRunId = null
    }
  }

  /**
   * Cancel the currently running dream.
   */
  cancel(_workspaceId: string): void {
    if (this.currentProcess) {
      try {
        this.currentProcess.kill('SIGTERM')
      } catch {
        // ignore
      }
      this.currentProcess = null
    }

    if (this.currentRunId) {
      dreamRunRepository.cancel(this.currentRunId)
      this.currentRunId = null
    }

    this.emitProgress('complete', 'Dream cancelled', 0, 0, 0)
  }

  /**
   * Parse consolidation actions from the LLM output and apply them to the DB.
   */
  private applyActions(
    text: string,
    workspaceId: string
  ): { created: number; merged: number; pruned: number; tokenEstimate: number } {
    let created = 0
    let merged = 0
    let pruned = 0
    const tokenEstimate = Math.ceil(text.length / 4) // rough estimate

    const lines = text.split('\n').filter((l) => l.trim().startsWith('{'))

    for (const line of lines) {
      try {
        const action = JSON.parse(line.trim())

        switch (action.action) {
          case 'merge': {
            if (action.keepId && Array.isArray(action.removeIds)) {
              // Update the kept memory
              memoryRepository.update(action.keepId, {
                title: action.mergedTitle,
                content: action.mergedContent,
                importance: action.mergedImportance
              })
              // Delete the merged-away memories
              for (const removeId of action.removeIds) {
                memoryRepository.delete(removeId)
              }
              merged += action.removeIds.length
            }
            break
          }
          case 'prune': {
            if (action.id) {
              // Safety: don't prune high-importance memories
              const mem = memoryRepository.findById(action.id)
              if (mem && mem.importance < 8) {
                memoryRepository.delete(action.id)
                pruned++
              }
            }
            break
          }
          case 'create': {
            if (action.type && action.title && action.content) {
              const memWorkspaceId =
                action.type === 'user' || action.type === 'feedback' ? null : workspaceId
              memoryRepository.create({
                workspaceId: memWorkspaceId,
                type: action.type,
                title: action.title,
                content: action.content,
                tags: Array.isArray(action.tags) ? action.tags : [],
                sourceAgentId: 'dream',
                importance: typeof action.importance === 'number' ? action.importance : 5
              })
              created++
            }
            break
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    return { created, merged, pruned, tokenEstimate }
  }

  /**
   * Spawn a read-only claude -p process for memory consolidation.
   */
  private spawnConsolidator(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const env = buildEnvWithPath()

      const child = spawn(
        'claude',
        [
          '-p',
          prompt,
          '--system-prompt',
          DREAM_SYSTEM_PROMPT,
          '--model',
          DREAM_MODEL_ID,
          '--output-format',
          'text',
          '--permission-mode',
          'plan' // Read-only — dream cannot modify code
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env
        }
      )

      this.currentProcess = child
      log.info(`Dream consolidator spawned (prompt: ${prompt.length} chars)`)

      const timer = setTimeout(() => {
        log.warn('Dream consolidator timed out')
        try {
          child.kill('SIGTERM')
        } catch {
          // ignore
        }
        reject(new Error('Dream consolidation timed out'))
      }, DREAM_TIMEOUT_MS)

      let stdout = ''
      let stderr = ''

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })

      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      child.on('exit', (code) => {
        clearTimeout(timer)
        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim())
        } else {
          reject(
            new Error(`Dream consolidation failed (exit ${code}): ${stderr.trim() || 'No output'}`)
          )
        }
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        reject(new Error(`Failed to spawn dream consolidator: ${err.message}`))
      })
    })
  }

  private emitProgress(
    phase: DreamProgress['phase'],
    message: string,
    memoriesCreated: number,
    memoriesMerged: number,
    memoriesPruned: number
  ): void {
    const progress: DreamProgress = {
      phase,
      message,
      memoriesCreated,
      memoriesMerged,
      memoriesPruned
    }
    this.emit('progress', progress)
  }
}

export const dreamService = new DreamService()
