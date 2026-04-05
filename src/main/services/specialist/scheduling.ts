/**
 * Pluggable scheduling strategies for specialist task assignment.
 *
 * Extends the existing topological sort (dependency ordering) with
 * dynamic scheduling strategies that can reassign tasks to better-suited
 * specialists at execution time.
 *
 * Strategies:
 * - round-robin: Simple rotation across available specialists
 * - least-busy: Assign to the specialist with fewest active tasks
 * - capability-match: Score specialists by keyword relevance to task
 * - dependency-first: Prioritize tasks on the critical path (BFS)
 *
 * Usage:
 *   const strategy = createScheduler('capability-match', specialists)
 *   const ranked = strategy.rankTasks(pendingTasks, activeLoad)
 *   const bestAgent = strategy.selectAgent(task, availableAgents)
 */
import type { DecomposedTask } from '../../../shared/types'

// ── Strategy Types ──

export type SchedulingStrategyName =
  | 'round-robin'
  | 'least-busy'
  | 'capability-match'
  | 'dependency-first'

export interface AgentCapability {
  agentId: string
  /** Keywords/tags that describe this specialist's strengths */
  keywords: string[]
  /** Current number of active tasks */
  activeTaskCount: number
  /** Max concurrent tasks this agent supports */
  maxConcurrent: number
}

export interface SchedulingContext {
  /** All pending tasks */
  pendingTasks: DecomposedTask[]
  /** Currently running task IDs */
  activeTasks: Set<string>
  /** Completed task IDs (for dependency checking) */
  completedTasks: Set<string>
  /** Available agent capabilities */
  agents: AgentCapability[]
}

export interface TaskPriority {
  task: DecomposedTask
  /** Priority score — higher = should run sooner */
  score: number
  /** Recommended agent override (if strategy suggests reassignment) */
  recommendedAgent?: string
  /** Reason for the priority/assignment */
  reason: string
}

export interface SchedulingStrategy {
  readonly name: SchedulingStrategyName
  /**
   * Rank pending tasks by priority.
   * Returns tasks sorted by descending score (highest priority first).
   */
  rankTasks(context: SchedulingContext): TaskPriority[]
  /**
   * Select the best agent for a given task.
   * Returns the agent ID, or undefined to keep the current assignment.
   */
  selectAgent(task: DecomposedTask, agents: AgentCapability[]): string | undefined
}

// ── Round-Robin Strategy ──

class RoundRobinStrategy implements SchedulingStrategy {
  readonly name = 'round-robin' as const
  private roundIndex = 0

  rankTasks(context: SchedulingContext): TaskPriority[] {
    return context.pendingTasks
      .filter((t) => t.dependsOn.every((dep) => context.completedTasks.has(dep)))
      .map((task, i) => ({
        task,
        score: context.pendingTasks.length - i, // FIFO order
        reason: 'round-robin: FIFO ordering'
      }))
  }

  selectAgent(task: DecomposedTask, agents: AgentCapability[]): string | undefined {
    if (agents.length === 0) return undefined
    const available = agents.filter((a) => a.activeTaskCount < a.maxConcurrent)
    if (available.length === 0) return undefined
    const agent = available[this.roundIndex % available.length]
    this.roundIndex++
    return agent.agentId
  }
}

// ── Least-Busy Strategy ──

class LeastBusyStrategy implements SchedulingStrategy {
  readonly name = 'least-busy' as const

  rankTasks(context: SchedulingContext): TaskPriority[] {
    return context.pendingTasks
      .filter((t) => t.dependsOn.every((dep) => context.completedTasks.has(dep)))
      .map((task) => {
        // Prioritize tasks whose assigned agent has low load
        const agent = context.agents.find((a) => a.agentId === task.specialist)
        const load = agent ? agent.activeTaskCount / agent.maxConcurrent : 0.5
        return {
          task,
          score: 1 - load, // Lower load = higher priority
          reason: `least-busy: agent load ${Math.round(load * 100)}%`
        }
      })
      .sort((a, b) => b.score - a.score)
  }

  selectAgent(_task: DecomposedTask, agents: AgentCapability[]): string | undefined {
    const available = agents.filter((a) => a.activeTaskCount < a.maxConcurrent)
    if (available.length === 0) return undefined
    // Sort by load (ascending) — pick the least busy
    available.sort((a, b) => a.activeTaskCount - b.activeTaskCount)
    return available[0].agentId
  }
}

// ── Capability-Match Strategy ──

class CapabilityMatchStrategy implements SchedulingStrategy {
  readonly name = 'capability-match' as const

  rankTasks(context: SchedulingContext): TaskPriority[] {
    return context.pendingTasks
      .filter((t) => t.dependsOn.every((dep) => context.completedTasks.has(dep)))
      .map((task) => {
        const agent = context.agents.find((a) => a.agentId === task.specialist)
        const matchScore = agent ? this.computeMatchScore(task, agent) : 0
        return {
          task,
          score: matchScore,
          reason: `capability-match: score ${matchScore.toFixed(2)} for ${task.specialist}`
        }
      })
      .sort((a, b) => b.score - a.score)
  }

  selectAgent(task: DecomposedTask, agents: AgentCapability[]): string | undefined {
    const available = agents.filter((a) => a.activeTaskCount < a.maxConcurrent)
    if (available.length === 0) return undefined

    // Score each agent by keyword relevance to the task
    const scored = available.map((agent) => ({
      agent,
      score: this.computeMatchScore(task, agent)
    }))

    scored.sort((a, b) => b.score - a.score)

    // Only suggest reassignment if the best match is significantly better
    // than the currently assigned agent
    const currentAgent = scored.find((s) => s.agent.agentId === task.specialist)
    const bestMatch = scored[0]

    if (currentAgent && bestMatch.score <= currentAgent.score * 1.3) {
      return undefined // Current assignment is good enough
    }

    return bestMatch.agent.agentId
  }

  private computeMatchScore(task: DecomposedTask, agent: AgentCapability): number {
    const descLower = task.description.toLowerCase()
    let score = 0

    for (const keyword of agent.keywords) {
      if (descLower.includes(keyword.toLowerCase())) {
        score += 1
      }
    }

    // Bonus for exact specialist match (the decomposer assigned it for a reason)
    if (agent.agentId === task.specialist) {
      score += 2
    }

    // Penalty for high load
    const loadPenalty = agent.activeTaskCount / Math.max(agent.maxConcurrent, 1)
    score *= 1 - loadPenalty * 0.3

    return score
  }
}

// ── Dependency-First Strategy (Critical Path) ──

class DependencyFirstStrategy implements SchedulingStrategy {
  readonly name = 'dependency-first' as const

  rankTasks(context: SchedulingContext): TaskPriority[] {
    // Build reverse dependency map: task → set of tasks that depend on it
    const dependents = new Map<string, Set<string>>()
    for (const task of context.pendingTasks) {
      for (const dep of task.dependsOn) {
        const set = dependents.get(dep) ?? new Set()
        set.add(task.id)
        dependents.set(dep, set)
      }
    }

    // BFS to count downstream tasks (transitive dependents)
    const downstreamCount = new Map<string, number>()
    for (const task of context.pendingTasks) {
      let count = 0
      const visited = new Set<string>()
      const queue = [task.id]

      while (queue.length > 0) {
        const current = queue.shift()!
        const deps = dependents.get(current)
        if (deps) {
          for (const dep of deps) {
            if (!visited.has(dep)) {
              visited.add(dep)
              count++
              queue.push(dep)
            }
          }
        }
      }

      downstreamCount.set(task.id, count)
    }

    return context.pendingTasks
      .filter((t) => t.dependsOn.every((dep) => context.completedTasks.has(dep)))
      .map((task) => ({
        task,
        score: downstreamCount.get(task.id) ?? 0,
        reason: `dependency-first: ${downstreamCount.get(task.id) ?? 0} downstream tasks`
      }))
      .sort((a, b) => b.score - a.score)
  }

  selectAgent(_task: DecomposedTask, _agents: AgentCapability[]): string | undefined {
    // Dependency-first doesn't reassign — it only prioritizes order
    return undefined
  }
}

// ── Strategy Factory ──

/**
 * Create a scheduling strategy by name.
 */
export function createScheduler(name: SchedulingStrategyName): SchedulingStrategy {
  switch (name) {
    case 'round-robin':
      return new RoundRobinStrategy()
    case 'least-busy':
      return new LeastBusyStrategy()
    case 'capability-match':
      return new CapabilityMatchStrategy()
    case 'dependency-first':
      return new DependencyFirstStrategy()
    default:
      throw new Error(`Unknown scheduling strategy: ${name}`)
  }
}

/**
 * Composite scheduler — combines multiple strategies with weighted scoring.
 * Useful for blending e.g. capability-match (70%) + least-busy (30%).
 */
export class CompositeScheduler implements SchedulingStrategy {
  readonly name = 'capability-match' as SchedulingStrategyName // primary
  private strategies: Array<{ strategy: SchedulingStrategy; weight: number }>

  constructor(strategies: Array<{ name: SchedulingStrategyName; weight: number }>) {
    this.strategies = strategies.map((s) => ({
      strategy: createScheduler(s.name),
      weight: s.weight
    }))
  }

  rankTasks(context: SchedulingContext): TaskPriority[] {
    // Collect scores from all strategies
    const taskScores = new Map<string, { task: DecomposedTask; weightedScore: number; reasons: string[] }>()

    for (const { strategy, weight } of this.strategies) {
      const ranked = strategy.rankTasks(context)
      for (const item of ranked) {
        const existing = taskScores.get(item.task.id) ?? {
          task: item.task,
          weightedScore: 0,
          reasons: []
        }
        existing.weightedScore += item.score * weight
        existing.reasons.push(`${strategy.name}(${(item.score * weight).toFixed(2)})`)
        taskScores.set(item.task.id, existing)
      }
    }

    return [...taskScores.values()]
      .map((item) => ({
        task: item.task,
        score: item.weightedScore,
        reason: `composite: ${item.reasons.join(' + ')}`
      }))
      .sort((a, b) => b.score - a.score)
  }

  selectAgent(task: DecomposedTask, agents: AgentCapability[]): string | undefined {
    // Use the first strategy that returns a recommendation
    for (const { strategy } of this.strategies) {
      const recommendation = strategy.selectAgent(task, agents)
      if (recommendation) return recommendation
    }
    return undefined
  }
}
