/**
 * Typed hook system for specialist lifecycle events.
 *
 * Replaces hardcoded EventEmitter patterns with configurable, per-specialist hooks.
 * Hooks can modify context (beforeRun), post-process output (afterRun),
 * or observe tool calls (onToolCall/onToolResult).
 *
 * Usage:
 *   const hooks = new SpecialistHookRunner()
 *   hooks.register('frontend-architect', {
 *     beforeRun: async (ctx) => { ctx.systemPrompt += '\nExtra instructions' },
 *     afterRun: async (result) => { console.log('Completed:', result.taskId) },
 *   })
 *
 *   // In specialist execution:
 *   await hooks.runBeforeRun('frontend-architect', context)
 *   // ... execute specialist ...
 *   await hooks.runAfterRun('frontend-architect', result)
 */
import type {
  ConversationMode,
  DecomposedTask,
  ModelTier
} from '../../../shared/types'

// ── Hook Context Types ──

/** Context passed to beforeRun hooks — mutable fields can be modified by hooks */
export interface BeforeRunContext {
  /** The task being executed */
  task: DecomposedTask
  /** Execution mode */
  mode: ConversationMode
  /** System prompt (mutable — hooks can append/modify) */
  systemPrompt: string
  /** Full prompt sent to the specialist (mutable) */
  fullPrompt: string
  /** Working directory */
  cwd: string
  /** Model being used */
  model: string
  /** Model tier */
  modelTier?: ModelTier
  /** Attempt number (0-based) */
  attempt: number
  /** Conversation ID if available */
  conversationId?: string
}

/** Result passed to afterRun hooks — read-only observation */
export interface AfterRunResult {
  /** The task that completed */
  task: DecomposedTask
  /** Full specialist output */
  output: string
  /** Whether the task succeeded */
  success: boolean
  /** Error message if failed */
  error?: string
  /** Token usage */
  tokenUsage: {
    input: number
    output: number
    cacheRead: number
    cacheCreation: number
  }
  /** Duration in ms */
  durationMs: number
  /** Number of tool calls made */
  toolCallCount: number
  /** Attempt number */
  attempt: number
}

/** Tool call observation hook context */
interface ToolCallContext {
  task: DecomposedTask
  toolName: string
  toolInput?: string
  toolCallIndex: number
}

/** Tool result observation hook context */
interface ToolResultContext {
  task: DecomposedTask
  toolName: string
  result?: string
  toolCallIndex: number
}

// ── Hook Definitions ──

interface SpecialistHooks {
  /**
   * Called before a specialist starts execution.
   * Can modify the context (prompt, model, etc.).
   * Throwing an error will abort the specialist execution.
   */
  beforeRun?: (context: BeforeRunContext) => Promise<void> | void

  /**
   * Called after a specialist completes (success or failure).
   * Read-only — cannot modify the result.
   */
  afterRun?: (result: AfterRunResult) => Promise<void> | void

  /**
   * Called when a specialist makes a tool call.
   * Observation only — cannot block the call.
   */
  onToolCall?: (context: ToolCallContext) => void

  /**
   * Called when a tool returns a result.
   * Observation only.
   */
  onToolResult?: (context: ToolResultContext) => void
}

// ── Hook Runner ──

export class SpecialistHookRunner {
  /** Hooks registered for specific specialist agent IDs */
  private perAgent = new Map<string, SpecialistHooks[]>()
  /** Global hooks that run for ALL specialists */
  private globalHooks: SpecialistHooks[] = []

  /**
   * Register hooks for a specific specialist agent.
   * Multiple hook sets can be registered per agent — they run in order.
   * Returns an unregister function.
   */
  register(agentId: string, hooks: SpecialistHooks): () => void {
    const existing = this.perAgent.get(agentId) ?? []
    existing.push(hooks)
    this.perAgent.set(agentId, existing)

    return (): void => {
      const arr = this.perAgent.get(agentId)
      if (arr) {
        const idx = arr.indexOf(hooks)
        if (idx >= 0) arr.splice(idx, 1)
      }
    }
  }

  /**
   * Register global hooks that run for ALL specialists.
   * Global hooks run BEFORE per-agent hooks.
   * Returns an unregister function.
   */
  registerGlobal(hooks: SpecialistHooks): () => void {
    this.globalHooks.push(hooks)
    return (): void => {
      const idx = this.globalHooks.indexOf(hooks)
      if (idx >= 0) this.globalHooks.splice(idx, 1)
    }
  }

  /**
   * Run all beforeRun hooks for a specialist.
   * Global hooks run first, then per-agent hooks.
   * Hooks can mutate the context object.
   */
  async runBeforeRun(agentId: string, context: BeforeRunContext): Promise<void> {
    const allHooks = this.getHooksForAgent(agentId)
    for (const hooks of allHooks) {
      if (hooks.beforeRun) {
        await hooks.beforeRun(context)
      }
    }
  }

  /**
   * Run all afterRun hooks for a specialist.
   * Errors in hooks are caught and logged (never crash the pipeline).
   */
  async runAfterRun(agentId: string, result: AfterRunResult): Promise<void> {
    const allHooks = this.getHooksForAgent(agentId)
    for (const hooks of allHooks) {
      if (hooks.afterRun) {
        try {
          await hooks.afterRun(result)
        } catch {
          // Never let a hook crash the pipeline
        }
      }
    }
  }

  /** Fire onToolCall hooks (sync, best-effort). */
  fireToolCall(agentId: string, context: ToolCallContext): void {
    const allHooks = this.getHooksForAgent(agentId)
    for (const hooks of allHooks) {
      if (hooks.onToolCall) {
        try {
          hooks.onToolCall(context)
        } catch {
          // Observation hooks must never crash
        }
      }
    }
  }

  /** Fire onToolResult hooks (sync, best-effort). */
  fireToolResult(agentId: string, context: ToolResultContext): void {
    const allHooks = this.getHooksForAgent(agentId)
    for (const hooks of allHooks) {
      if (hooks.onToolResult) {
        try {
          hooks.onToolResult(context)
        } catch {
          // Observation hooks must never crash
        }
      }
    }
  }

  /** Remove all hooks (for testing or reset). */
  clear(): void {
    this.perAgent.clear()
    this.globalHooks.length = 0
  }

  private getHooksForAgent(agentId: string): SpecialistHooks[] {
    const perAgent = this.perAgent.get(agentId) ?? []
    return [...this.globalHooks, ...perAgent]
  }
}

/** Singleton hook runner for the specialist pipeline */
export const specialistHookRunner = new SpecialistHookRunner()
