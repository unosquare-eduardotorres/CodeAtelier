import { execSync, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import log from 'electron-log/main'

const hookLog = log.scope('HookEngine')

export type HookEvent =
  | 'specialist_start'
  | 'specialist_complete'
  | 'specialist_failed'
  | 'gate_passed'
  | 'gate_failed'
  | 'escalation'
  | 'pre_merge'
  | 'post_merge'
  | 'plan_created'
  | 'checkpoint_approved'
  | 'checkpoint_rejected'
  | 'abandonment_detected'
  | 'task_loop_complete'
  // MPA (Multi-Phased Agent) lifecycle events
  | 'mpa_plan_complete'
  | 'mpa_build_start'
  | 'mpa_build_complete'
  | 'mpa_verify_complete'
  | 'mpa_goal_achieved'
  | 'mpa_goal_failed'

export interface HookDefinition {
  event: HookEvent
  name: string
  command: string
  blocking: boolean
  condition?: { mode?: 'plan' | 'build' | 'danger'; model?: string; agent?: string }
  timeout?: number // default 30000
}

export interface HookResult {
  hook: string
  event: HookEvent
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
}

/**
 * Declarative hook engine — loads user-defined hooks from workspace config
 * and executes them at lifecycle events (specialist start/complete, gates, merges, etc.).
 *
 * Hooks are defined in `.agentstudio/hooks.json` at the workspace root.
 * Blocking hooks run synchronously and can gate operations; non-blocking hooks fire-and-forget.
 */
class HookEngine extends EventEmitter {
  private hooks: HookDefinition[] = []
  private workspacePath: string | null = null

  constructor() {
    super()
  }

  async loadHooks(workspacePath: string): Promise<void> {
    this.workspacePath = workspacePath
    const hookFile = join(workspacePath, '.agentstudio', 'hooks.json')
    try {
      const raw = await readFile(hookFile, 'utf-8')
      const parsed = JSON.parse(raw) as { hooks?: HookDefinition[] }
      this.hooks = parsed.hooks ?? []
      if (this.hooks.length > 0) {
        hookLog.info(`Loaded ${this.hooks.length} hook(s) from ${hookFile}`)
      }
    } catch {
      this.hooks = [] // No hooks file — that's fine
    }
  }

  async executeHooks(
    event: HookEvent,
    context: Record<string, string> = {}
  ): Promise<HookResult[]> {
    // F8: Filter by event AND evaluate condition fields (mode, model, agent).
    // Previously only filtered by event, ignoring condition — hooks defined with
    // condition: { mode: 'build' } would incorrectly execute during plan mode.
    const matching = this.hooks.filter((h) => {
      if (h.event !== event) return false
      if (!h.condition) return true
      if (h.condition.mode && context.mode !== h.condition.mode) return false
      if (h.condition.model && context.model !== h.condition.model) return false
      if (h.condition.agent && context.agent !== h.condition.agent) return false
      return true
    })
    if (matching.length === 0) return []

    const results: HookResult[] = []
    for (const hook of matching) {
      const hookId = `${hook.name}-${Date.now()}`

      // Emit lifecycle: started
      this.emit('hookLifecycle', {
        hookId,
        hookName: hook.name,
        hookEvent: event,
        phase: 'started' as const,
        output: undefined
      })

      // Interpolate ${VAR} in command
      let cmd = hook.command
      for (const [key, val] of Object.entries(context)) {
        cmd = cmd.replaceAll(`\${${key}}`, val)
      }

      const start = Date.now()
      if (hook.blocking) {
        // Synchronous — blocks until complete
        try {
          const stdout = execSync(cmd, {
            cwd: this.workspacePath ?? undefined,
            encoding: 'utf-8',
            timeout: hook.timeout ?? 30000
          })
          hookLog.info(`Hook "${hook.name}" completed (${Date.now() - start}ms)`)
          const result: HookResult = {
            hook: hook.name,
            event,
            exitCode: 0,
            stdout,
            stderr: '',
            durationMs: Date.now() - start
          }
          results.push(result)

          // Emit lifecycle: response
          this.emit('hookLifecycle', {
            hookId,
            hookName: hook.name,
            hookEvent: event,
            phase: 'response' as const,
            output: stdout.slice(0, 500),
            outcome: 'success'
          })
        } catch (err: unknown) {
          const stderr = err instanceof Error ? err.message : String(err)
          hookLog.warn(`Hook "${hook.name}" failed: ${stderr.slice(0, 200)}`)
          results.push({
            hook: hook.name,
            event,
            exitCode: 1,
            stdout: '',
            stderr,
            durationMs: Date.now() - start
          })

          // Emit lifecycle: response (failure)
          this.emit('hookLifecycle', {
            hookId,
            hookName: hook.name,
            hookEvent: event,
            phase: 'response' as const,
            output: stderr.slice(0, 500),
            outcome: 'failure'
          })
        }
      } else {
        // Fire-and-forget
        try {
          const child = spawn('sh', ['-c', cmd], {
            cwd: this.workspacePath ?? undefined,
            stdio: 'ignore',
            detached: true
          })
          child.unref()
          hookLog.info(`Hook "${hook.name}" fired (non-blocking)`)
        } catch (err) {
          hookLog.warn(`Failed to spawn hook "${hook.name}":`, err)
        }
        results.push({
          hook: hook.name,
          event,
          exitCode: null,
          stdout: '',
          stderr: '',
          durationMs: 0
        })

        // Emit lifecycle: response (fire-and-forget — no stdout)
        this.emit('hookLifecycle', {
          hookId,
          hookName: hook.name,
          hookEvent: event,
          phase: 'response' as const,
          output: undefined,
          outcome: 'fired'
        })
      }
    }
    return results
  }

  getLoadedHooks(): HookDefinition[] {
    return [...this.hooks]
  }
}

export const hookEngine = new HookEngine()
