/**
 * DOC-CLASSIFICATION (Agentic MapReduce, map step input): classify reference
 * documents into REFERENCE context vs PLAN units before the TASKS phase.
 *
 * 8acc incident: 11 docs were ingested flat - 4 were context (README,
 * storyboard, BRIEF) and 7 were per-scene implementation plans. The TASKS
 * model read them all in one shot, spent its output budget narrating, and
 * produced a raw transcript instead of task JSON (30-min timeout, then a
 * swallowed persist error). Classifying first lets the pipeline (a) cap the
 * context docs, and (b) process each plan doc as its own map unit.
 *
 * Pure heuristics - no LLM call, deterministic, unit-testable.
 */

/** How a document participates in task decomposition. */
export type DocRole = 'reference' | 'plan'

export interface ClassifiedDoc {
  /** Original index in the input array - stable identity for logging. */
  index: number
  name: string
  role: DocRole
  /** Bytes of the file content (0 when unknown at classification time). */
  size: number
}

/** Filename signals that mark a document as an implementation PLAN unit. */
const PLAN_NAME_PATTERNS: RegExp[] = [
  /\bscene[-_ ]?\d+\b/i,
  /\btask[-_ ]?\d+\b/i,
  /\bepic\b/i,
  /\bfeature[-_ ]?\d+\b/i,
  /\bstory[-_ ]?\d+\b/i,
  /\bfr[-_ ]?\d+\b/i,
  /^\d{1,2}[-_]/
]

/** Filename signals that mark a document as REFERENCE context. */
const REFERENCE_NAME_PATTERNS: RegExp[] = [
  /^readme\b/i,
  /^brief\b/i,
  /^storyboard\b/i,
  /\bbuild[-_ ]?order\b/i,
  /\bconventions?\b/i,
  /\bguidelines?\b/i,
  /\barchitecture\b/i,
  /\bglossary\b/i,
  /\bstandards?\b/i
]

/**
 * Classify one document by filename. Reference wins ties: a doc that looks
 * like both (e.g. BUILD-ORDER.md matching task patterns) is safer as
 * context than as a decomposition unit.
 */
export function classifyDocByName(name: string): DocRole {
  const base = name.trim().toLowerCase()
  if (REFERENCE_NAME_PATTERNS.some((p) => p.test(base))) return 'reference'
  if (PLAN_NAME_PATTERNS.some((p) => p.test(base))) return 'plan'
  return 'reference'
}

/**
 * Classify a batch of documents. Deterministic: same input, same output.
 * The index preserves the caller ordering for stable logging.
 */
export function classifyDocs(
  docs: Array<{ name: string; size?: number }>
): ClassifiedDoc[] {
  return docs.map((d, index) => ({
    index,
    name: d.name,
    role: classifyDocByName(d.name),
    size: d.size ?? 0
  }))
}

/** Split classified docs into the two map-reduce partitions. */
export function partitionDocs(classified: ClassifiedDoc[]): {
  reference: ClassifiedDoc[]
  plans: ClassifiedDoc[]
} {
  return {
    reference: classified.filter((d) => d.role === 'reference'),
    plans: classified.filter((d) => d.role === 'plan')
  }
}

// — Reduce step: merge per-doc task waves into one graph —

export interface MergedTask {
  taskId: string
  wave: number
  description: string
  userStory?: string | null
  files?: string[]
  isParallel?: boolean
  dependsOn?: string[]
}

export interface MergeResult {
  tasks: MergedTask[]
  /** Non-fatal merge notes for the tasks-phase artifact (dedupes, renumbering). */
  warnings: string[]
}

/**
 * Reduce step: merge per-document task lists into ONE wave-ordered graph.
 *
 * Deterministic rules (no LLM):
 *  1. Wave offsets - each doc's waves are stacked sequentially: doc 1's
 *     waves keep their numbers; doc 2's waves continue after doc 1's max.
 *     Cross-doc dependencies are impossible to violate this way, and the
 *     build DAG stays acyclic by construction.
 *  2. Task-ID renumbering - IDs are reassigned T001..Tnnn in final order so
 *     docs cannot collide (doc A's T001 vs doc B's T001). Original IDs are
 *     rewritten inside dependsOn too.
 *  3. Dedupe - identical file sets across docs collapse into the FIRST
 *     occurrence (same deliverable described twice); a warning is recorded.
 */
export function mergeDocTaskLists(
  perDoc: Array<{ docName: string; tasks: MergedTask[] }>,
  opts: { startWave?: number } = {}
): MergeResult {
  const warnings: string[] = []
  const merged: MergedTask[] = []
  const idRewrites = new Map<string, string>()
  let waveOffset = (opts.startWave ?? 1) - 1
  let seq = 0

  for (const { tasks } of perDoc) {
    if (tasks.length === 0) continue
    const docMaxWave = Math.max(...tasks.map((t) => t.wave))

    for (const task of [...tasks].sort((a, b) => a.wave - b.wave)) {
      seq++
      const newId = 'T' + String(seq).padStart(3, '0')
      idRewrites.set(task.taskId, newId)
      merged.push({
        ...task,
        taskId: newId,
        wave: waveOffset + task.wave
      })
    }
    waveOffset += docMaxWave
  }

  // Rewrite dependsOn ids AFTER all renumbering is known
  for (const task of merged) {
    if (!task.dependsOn?.length) continue
    task.dependsOn = task.dependsOn
      .map((dep) => idRewrites.get(dep) ?? dep)
      .filter((dep, i, arr) => arr.indexOf(dep) === i)
  }

  // Dedupe by identical sorted file sets
  const seenFileSets = new Map<string, string>()
  const deduped: MergedTask[] = []
  for (const task of merged) {
    const key = (task.files ?? []).slice().sort().join('|')
    if (key && seenFileSets.has(key)) {
      warnings.push(
        'duplicate file set (' + key + ') in ' + task.taskId +
          ' - already covered by ' + seenFileSets.get(key) + '; dropped'
      )
      continue
    }
    if (key) seenFileSets.set(key, task.taskId)
    deduped.push(task)
  }

  return { tasks: deduped, warnings }
}
