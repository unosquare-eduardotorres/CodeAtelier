/**
 * task-dag.ts — pure DAG scheduler primitives for Blueprint BUILD.
 *
 * The BUILD phase historically executed tasks wave-by-wave with a barrier
 * between waves. This module provides the graph primitives that lift the
 * existing within-wave parallel scheduler to the whole task set: a task
 * dispatches as soon as its declared `dependsOn` dependencies are settled,
 * regardless of which wave the deps were grouped into. Waves remain as
 * advisory grouping for the UI.
 *
 * Pure by design: no DB, no Electron, no services. Everything operates on
 * plain task descriptors and predicates supplied by the caller, so the
 * scheduling rules are unit-testable without mocking the world.
 *
 * Readiness rule (the one contract the whole scheduler rests on):
 *   a dependency is satisfied ⇔ its status is 'complete'
 *   OR it is 'skipped' with a `skippedByUserAt` timestamp (a deliberate
 *   user skip is a settled outcome — see BP-TASK-USER-SKIP-01).
 *   A cascade-skip (status 'skipped' written by the failure cascade, no
 *   user timestamp) does NOT satisfy a dependency: the dependent stays
 *   blocked and surfaces as blocked rather than silently mis-ordered.
 */

/** Minimal task shape the DAG needs — matches BlueprintTask's scheduling fields. */
export interface DagTaskInput {
  taskId: string
  wave: number
  dependsOnJson?: string[] | null
}

export interface TaskDagNode {
  taskId: string
  wave: number
  /** Normalized deps: self-references and unknown ids removed, deduped. */
  deps: string[]
  /** Adjacency: taskIds that declare this task as a dependency. */
  dependents: string[]
  /** Structural in-degree over known deps (decremented by markComplete). */
  inDegree: number
  /**
   * Critical-path priority: 1 + max(upwardRank of dependents), leaves = 1.
   * Higher rank = more downstream work is blocked on this task = dispatch
   * first when a slot frees (HEFT-style upward rank; durations are unknown
   * so every task costs 1). Computed once at build time — O(V+E).
   */
  upwardRank: number
}

export interface TaskDag {
  nodes: Map<string, TaskDagNode>
  /** Deps that referenced no task in the set — reported, then ignored. */
  unknownDeps: Array<{ taskId: string; dep: string }>
  /** One representative cycle path when the graph is cyclic, else null. */
  cycle: string[] | null
  /** Topological order over the acyclic portion (cycle nodes excluded). */
  topoOrder: string[]
}

/**
 * Build the DAG: normalize deps (drop self-references, dedupe, record
 * unknowns), build adjacency, run Kahn's algorithm for cycle detection and
 * a topological order, then compute upward ranks from the reversed order.
 */
export function buildTaskDag(tasks: DagTaskInput[]): TaskDag {
  const nodes = new Map<string, TaskDagNode>()
  const unknownDeps: Array<{ taskId: string; dep: string }> = []

  // First pass: nodes with normalized dep lists.
  for (const task of tasks) {
    if (nodes.has(task.taskId)) continue // duplicate taskId — first wins
    nodes.set(task.taskId, {
      taskId: task.taskId,
      wave: task.wave,
      deps: [],
      dependents: [],
      inDegree: 0,
      upwardRank: 1
    })
  }

  for (const task of tasks) {
    const node = nodes.get(task.taskId)
    if (!node) continue // duplicate that lost the first-wins race
    const seen = new Set<string>()
    for (const dep of task.dependsOnJson ?? []) {
      if (dep === task.taskId) continue // self-reference is meaningless
      if (seen.has(dep)) continue // dedupe
      seen.add(dep)
      if (!nodes.has(dep)) {
        unknownDeps.push({ taskId: task.taskId, dep })
        continue // unknown id — reported, ignored for scheduling
      }
      node.deps.push(dep)
    }
    node.inDegree = node.deps.length
  }

  // Adjacency from the normalized deps.
  for (const node of nodes.values()) {
    for (const dep of node.deps) {
      nodes.get(dep)!.dependents.push(node.taskId)
    }
  }

  // Kahn's algorithm — topological order + cycle detection.
  const inDeg = new Map<string, number>()
  for (const node of nodes.values()) inDeg.set(node.taskId, node.deps.length)
  const queue: string[] = []
  for (const [id, d] of inDeg) if (d === 0) queue.push(id)
  const topoOrder: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    topoOrder.push(id)
    for (const dep of nodes.get(id)!.dependents) {
      const next = inDeg.get(dep)! - 1
      inDeg.set(dep, next)
      if (next === 0) queue.push(dep)
    }
  }

  let cycle: string[] | null = null
  if (topoOrder.length < nodes.size) {
    cycle = extractCycle(nodes, inDeg)
  }

  // Upward rank: process in REVERSED topological order so every node's
  // dependents are ranked before it. Cycle nodes (absent from topoOrder)
  // keep rank 1 — they are never dispatched in DAG mode anyway.
  for (let i = topoOrder.length - 1; i >= 0; i--) {
    const node = nodes.get(topoOrder[i])!
    let rank = 1
    for (const dep of node.dependents) {
      const dr = nodes.get(dep)!.upwardRank
      if (dr + 1 > rank) rank = dr + 1
    }
    node.upwardRank = rank
  }

  return { nodes, unknownDeps, cycle, topoOrder }
}

/**
 * Walk remaining edges to extract one representative cycle path.
 * Starts from any node with unprocessed in-edges and follows deps until a
 * node repeats; the slice from the repeat is the cycle.
 */
function extractCycle(
  nodes: Map<string, TaskDagNode>,
  remainingInDeg: Map<string, number>
): string[] {
  let start: string | undefined
  for (const [id, d] of remainingInDeg) {
    if (d > 0) {
      start = id
      break
    }
  }
  if (start === undefined) return []

  const seen = new Map<string, number>()
  const path: string[] = []
  let cur = start
  while (!seen.has(cur)) {
    seen.set(cur, path.length)
    path.push(cur)
    const node = nodes.get(cur)
    // Follow any dep that still has unprocessed in-edges (is part of, or
    // leads into, the cyclic residue). Fall back to the first dep.
    const next = node?.deps.find((d) => (remainingInDeg.get(d) ?? 0) > 0) ?? node?.deps[0]
    if (!next) break
    cur = next
  }
  const idx = seen.get(cur) ?? 0
  return path.slice(idx)
}

/** Re-expose cycle detection for callers that rebuild satisfaction state. */
export function detectCycle(dag: TaskDag): string[] | null {
  return dag.cycle
}

/**
 * Deterministic rank ordering: higher upwardRank first (critical path),
 * tie-break lower wave, then lexicographic taskId. Exported so callers
 * (and tests) sort candidate lists identically.
 */
export function compareByRank(a: TaskDagNode, b: TaskDagNode): number {
  if (b.upwardRank !== a.upwardRank) return b.upwardRank - a.upwardRank
  if (a.wave !== b.wave) return a.wave - b.wave
  return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0
}

/**
 * All tasks whose dependencies are satisfied per the predicate, in rank
 * order. Predicate-based (not structural) so resume state — tasks already
 * 'complete' or user-skipped before this run started — needs no replay:
 * the caller simply answers the predicate from live status.
 *
 * The caller is expected to filter out already-dispatched/terminal tasks;
 * this function has no mutable scheduling state.
 */
export function readyTasks(dag: TaskDag, isSatisfied: (taskId: string) => boolean): string[] {
  const ready: TaskDagNode[] = []
  for (const node of dag.nodes.values()) {
    if (node.deps.every((d) => isSatisfied(d))) ready.push(node)
  }
  ready.sort(compareByRank)
  return ready.map((n) => n.taskId)
}

/**
 * Structural release: mark a task complete, decrement dependents' in-degree,
 * and return the dependents that just reached in-degree 0 (in rank order).
 *
 * Purely bookkeeping — readiness decisions still run through `readyTasks`
 * with the caller's predicate. Returns [] for unknown ids (defensive).
 */
export function markComplete(dag: TaskDag, taskId: string): string[] {
  const node = dag.nodes.get(taskId)
  if (!node) return []
  const newlyReady: TaskDagNode[] = []
  for (const dep of node.dependents) {
    const d = dag.nodes.get(dep)
    if (!d) continue
    d.inDegree = Math.max(0, d.inDegree - 1)
    if (d.inDegree === 0) newlyReady.push(d)
  }
  newlyReady.sort(compareByRank)
  return newlyReady.map((n) => n.taskId)
}

/**
 * Transitive dependents of the roots (excluding the roots themselves) —
 * the reachability set the failure cascade skips: only tasks that actually
 * depend on a failed task are skipped; healthy peers keep running.
 */
export function collectTransitiveDependents(dag: TaskDag, roots: string[]): Set<string> {
  const out = new Set<string>()
  const stack = [...roots]
  while (stack.length > 0) {
    const id = stack.pop()!
    const node = dag.nodes.get(id)
    if (!node) continue
    for (const dep of node.dependents) {
      if (!out.has(dep)) {
        out.add(dep)
        stack.push(dep)
      }
    }
  }
  return out
}

/**
 * The readiness status rule, encoded once. `status` values match
 * BlueprintTaskStatus; anything else (pending/running/failed/cascade-skipped)
 * leaves the dependency unsatisfied.
 */
export function isDepSatisfied(status: string, skippedByUserAt?: string | null): boolean {
  if (status === 'complete') return true
  if (status === 'skipped') return Boolean(skippedByUserAt)
  return false
}
