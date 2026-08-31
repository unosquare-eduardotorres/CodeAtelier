import {
  classifyDocs,
  partitionDocs,
  mergeDocTaskLists
} from '../../shared/doc-classification'
import type { MergedTask } from '../../shared/doc-classification'

export type { MergedTask }
import { loadAllReferenceDocuments } from './blueprint-document-loader'


/** One map unit: a plan doc plus its loaded content. */
export interface PlanDocUnit {
  name: string
  content: string
}

/** Result of classifying + partitioning a blueprint reference-doc set. */
export interface DocPartition {
  reference: Array<{ name: string; content: string }>
  plans: PlanDocUnit[]
}

/**
 * MAP-STEP PREP (Agentic MapReduce for TASKS): load the blueprint reference
 * documents, classify each as reference-context or plan-unit, and partition.
 * Classification itself is deterministic (shared/doc-classification.ts).
 */
/** Structural doc shape (matches the loader's unexported ReferenceDocument). */
interface DocInput {
  type: string
  path: string
  name?: string
}

export async function partitionReferenceDocs(
  workspacePath: string,
  docs: DocInput[]
): Promise<DocPartition> {
  const classified = classifyDocs(docs.map((d) => ({ name: d.name || d.path })))
  const { reference, plans } = partitionDocs(classified)
  const byName = new Map(
    (docs as Array<{ type: 'file' | 'workspace-file' | 'url'; path: string; name?: string }>).map(
      (d) => [d.name || d.path, d]
    )
  )
  const load = async (names: string[]): Promise<Array<{ name: string; content: string }>> => {
    const targets = names.map((n) => byName.get(n)).filter((d) => !!d)
    const loaded = await loadAllReferenceDocuments(workspacePath, targets)
    return loaded
      .filter((ld) => !ld.failed)
      .map((ld) => ({ name: ld.doc.name || ld.doc.path, content: ld.content }))
  }
  return {
    reference: await load(reference.map((d) => d.name)),
    plans: await load(plans.map((d) => d.name))
  }
}

/**
 * MAP PROMPT: decompose ONE plan document into waves. Focused context -
 * reference docs and prior artifacts enter as summaries, not inlines.
 */
export function buildMapPrompt(params: {
  docName: string
  docContent: string
  referenceSummary: string
  priorArtifactsSummary: string
  docIndex: number
  totalDocs: number
}): string {
  const { docName, docContent, referenceSummary, priorArtifactsSummary, docIndex, totalDocs } = params
  return [
    'Decompose ONE implementation document into wave-ordered tasks.',
    '',
    'You are processing document ' + (docIndex + 1) + ' of ' + totalDocs + ': ' + docName + '.',
    'Other documents are processed separately - do NOT create tasks for them.',
    '',
    '## Context (summaries only - full artifacts are on disk)',
    priorArtifactsSummary,
    '',
    '## Reference context',
    referenceSummary,
    '',
    '## The document to decompose',
    docContent,
    '',
    '## Your output',
    'Emit a `blueprint-tasks` JSON block with waves for THIS document only.',
    'Each task: atomic (1-5 files), explicit file paths, same-wave tasks have zero file overlap.',
    'Use task IDs T001.. within this document - they will be renumbered during merge.',
    'Then emit a `blueprint-phase-complete` block.'
  ].filter(Boolean).join('\n')
}

/**
 * REDUCE: merge per-doc task lists deterministically, then reshape into
 * the waves-nested JSON the existing persist path expects.
 */
export function reduceToWavesJson(
  perDoc: Array<{ docName: string; tasks: MergedTask[] }>
): { waves: Array<{ wave: number; tasks: MergedTask[] }>; warnings: string[] } {
  const { tasks, warnings } = mergeDocTaskLists(perDoc)
  const byWave = new Map<number, MergedTask[]>()
  for (const t of tasks) {
    const list = byWave.get(t.wave) ?? []
    list.push(t)
    byWave.set(t.wave, list)
  }
  return {
    waves: [...byWave.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([wave, ts]) => ({ wave, tasks: ts })),
    warnings
  }
}
