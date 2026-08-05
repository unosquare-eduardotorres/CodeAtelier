/**
 * memory-reflection — synthesis of many shallow observations into few useful ones.
 *
 * Consolidation only ever decayed, merged and archived: it made the corpus
 * smaller but never smarter. Two hundred tier-0 observations that all circle
 * the same convention stay two hundred observations. This pass reads a cluster
 * of related facts and asks a model to state the convention they imply once.
 *
 * Three deliberate constraints, because this is the only part of the memory
 * system that spends money and the only one that writes text nobody wrote:
 *
 *   1. Opt-in per workspace (`reflectionEnabled` capture setting).
 *   2. Capped clusters per run, and a cheap model.
 *   3. Nothing is promoted unreviewed. A synthesised parent is written
 *      `archived` — invisible to retrieval — and only becomes active when a
 *      human approves it, at which point its children are demoted.
 *
 * Inspired by Letta's sleep-time compute and Zep's community summaries.
 */

import log from 'electron-log'
import { memoryFactRepository } from '../db/repositories/memory-fact.repository'
import { memoryEngineService, cosineSimilarity } from './memory-engine.service'
import { workspaceRepository } from '../db/repositories'
import { runAgenticClaude } from './agentic-claude-runner'
import type { MemoryFact, MemoryFactCategory } from '../../shared/types'

/**
 * The one call synthesis makes to the outside world.
 *
 * Injectable for the same reason `findClusters` takes `input`: the real
 * implementation spawns a CLI, and the behaviour worth testing here is what
 * happens to the database *after* it returns — including the case where the
 * write resolves to an existing fact.
 */
export type SynthesisRunner = typeof runAgenticClaude

const rLog = log.scope('memory-reflection')

// ── Configuration ───────────────────────────────────────────────────────────

/** Facts this similar belong to the same topic. Matches consolidation. */
const CLUSTER_THRESHOLD = 0.85

/**
 * Above this the facts are near-duplicates and consolidation's auto-merge
 * already handles them — synthesising there would just re-word one fact.
 */
const AUTO_MERGE_THRESHOLD = 0.95

/** Smallest cluster worth summarising. Two facts are a merge, not a theme. */
const MIN_CLUSTER_SIZE = 3

/** Clusters synthesised per run. The cap is the cost control. */
const MAX_CLUSTERS_PER_RUN = 3

/** Facts fed to the model from one cluster. */
const MAX_FACTS_PER_PROMPT = 12

/** Tag marking a fact as awaiting reflection review. */
export const SYNTHESIS_TAG = 'synthesis'
export const PENDING_REVIEW_TAG = 'pending-review'

export interface ReflectionResult {
  clustersConsidered: number
  parentsProposed: number
  errors: number
}

export interface Cluster {
  facts: MemoryFact[]
  meanSimilarity: number
}

// ── Service ─────────────────────────────────────────────────────────────────

class MemoryReflectionService {
  private running = false

  /** Whether this workspace has opted in. */
  isEnabled(workspaceId: string): boolean {
    try {
      const settings = workspaceRepository.getSettings(workspaceId) as Record<string, unknown>
      return settings?.memoryReflectionEnabled === true
    } catch {
      return false
    }
  }

  /**
   * Propose parent facts for the densest clusters in a workspace.
   *
   * Returns without doing anything when the workspace has not opted in, so
   * callers can invoke it unconditionally from the idle job.
   */
  async runReflection(workspaceId: string, workspacePath: string): Promise<ReflectionResult> {
    const empty: ReflectionResult = { clustersConsidered: 0, parentsProposed: 0, errors: 0 }

    if (this.running) {
      rLog.info('[runReflection] Already running, skipping')
      return empty
    }
    if (!this.isEnabled(workspaceId)) return empty

    this.running = true
    try {
      const clusters = this.findClusters(workspaceId)
      if (clusters.length === 0) return empty

      // Densest first: the tightest cluster is the one most likely to have a
      // single convention behind it.
      const selected = clusters
        .sort((a, b) => b.meanSimilarity - a.meanSimilarity)
        .slice(0, MAX_CLUSTERS_PER_RUN)

      let proposed = 0
      let errors = 0

      for (const cluster of selected) {
        try {
          const created = await this.synthesizeCluster(workspaceId, workspacePath, cluster)
          if (created) proposed++
        } catch (err) {
          errors++
          rLog.warn('[runReflection] Cluster synthesis failed:', err)
        }
      }

      rLog.info(
        `[runReflection] ${selected.length} cluster(s) considered, ${proposed} parent(s) proposed`
      )
      return { clustersConsidered: selected.length, parentsProposed: proposed, errors }
    } finally {
      this.running = false
    }
  }

  /**
   * Connected components of facts at CLUSTER_THRESHOLD, excluding clusters
   * tight enough for plain deduplication and those already summarised.
   *
   * `input` exists so the clustering can be exercised on stated geometry
   * rather than by monkey-patching the repository singleton — which lands on a
   * different object than the service reads from once the shared test runner
   * resets module mocks between files.
   */
  findClusters(
    workspaceId: string,
    input?: Array<{ fact: MemoryFact; embedding: Float32Array }>
  ): Cluster[] {
    const source = input ?? memoryFactRepository.findWithEmbeddings(workspaceId) ?? []

    // A previously synthesised parent must not become a child of the next
    // synthesis, or the hierarchy compounds into nonsense.
    const embedded = source.filter(({ fact }) => !fact.tags.includes(SYNTHESIS_TAG))

    if (embedded.length < MIN_CLUSTER_SIZE) return []

    const adjacency = new Map<number, Set<number>>()
    const sims = new Map<string, number>()

    for (let i = 0; i < embedded.length; i++) {
      for (let j = i + 1; j < embedded.length; j++) {
        const sim = cosineSimilarity(embedded[i].embedding, embedded[j].embedding)
        if (sim < CLUSTER_THRESHOLD) continue
        if (!adjacency.has(i)) adjacency.set(i, new Set())
        if (!adjacency.has(j)) adjacency.set(j, new Set())
        adjacency.get(i)!.add(j)
        adjacency.get(j)!.add(i)
        sims.set(`${i}-${j}`, sim)
      }
    }

    const visited = new Set<number>()
    const clusters: Cluster[] = []

    for (const start of adjacency.keys()) {
      if (visited.has(start)) continue

      const members: number[] = []
      const stack = [start]
      while (stack.length > 0) {
        const current = stack.pop()!
        if (visited.has(current)) continue
        visited.add(current)
        members.push(current)
        for (const neighbour of adjacency.get(current) ?? []) {
          if (!visited.has(neighbour)) stack.push(neighbour)
        }
      }

      if (members.length < MIN_CLUSTER_SIZE) continue

      // Mean pairwise similarity over the edges we actually recorded.
      let total = 0
      let count = 0
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const key = `${Math.min(members[i], members[j])}-${Math.max(members[i], members[j])}`
          const sim = sims.get(key)
          if (sim !== undefined) {
            total += sim
            count++
          }
        }
      }
      const meanSimilarity = count > 0 ? total / count : 0

      // Near-identical facts are consolidation's job, not reflection's.
      if (meanSimilarity >= AUTO_MERGE_THRESHOLD) continue

      clusters.push({ facts: members.map((idx) => embedded[idx].fact), meanSimilarity })
    }

    return clusters
  }

  /**
   * Ask a cheap model for the one convention a cluster implies, and record it
   * as an unreviewed proposal linked to its sources.
   */
  async synthesizeCluster(
    workspaceId: string,
    workspacePath: string,
    cluster: Cluster,
    runner: SynthesisRunner = runAgenticClaude
  ): Promise<boolean> {
    const facts = cluster.facts.slice(0, MAX_FACTS_PER_PROMPT)
    const prompt = buildSynthesisPrompt(facts)

    const result = await runner({
      workspaceId,
      workspacePath,
      prompt,
      allowedTools: [],
      model: 'claude-haiku-4-5',
      maxTurns: 1,
      timeoutMs: 60_000
    })

    const parsed = parseSynthesis(result.stdout ?? '')
    if (!parsed) {
      rLog.warn('[synthesizeCluster] Model returned nothing usable')
      return false
    }

    // Written archived: a proposal must not reach a prompt before a human has
    // agreed it is true. Approval flips it to active.
    //
    // `skipSimilarity` is load-bearing, not an optimisation. A synthesised
    // parent is near its children by construction — their similarity is what
    // formed the cluster — so the dedup pipeline would almost always resolve
    // this write to one of those children and hand it back as "the fact". The
    // archive and the edges below would then land on a legitimate, possibly
    // long-established fact.
    const parent = await memoryEngineService.writeFact({
      workspaceId,
      category: parsed.category,
      title: parsed.title,
      content: parsed.content,
      tags: [SYNTHESIS_TAG, PENDING_REVIEW_TAG],
      scopePaths: mergeScopePaths(facts),
      sourceType: 'manual',
      sourceRef: 'reflection',
      workspacePath,
      skipSimilarity: true
    })

    if (!parent) return false

    // Defence in depth. `skipSimilarity` should guarantee a fresh row, but the
    // next two statements archive a fact and rewrite its edges — if the write
    // path ever resolves to an existing fact again, refusing here costs one
    // skipped proposal, while proceeding costs real knowledge.
    const isFreshProposal =
      parent.tags.includes(SYNTHESIS_TAG) &&
      parent.tags.includes(PENDING_REVIEW_TAG) &&
      !facts.some((f) => f.id === parent.id)

    if (!isFreshProposal) {
      rLog.error(
        `[synthesizeCluster] Write resolved to existing fact ${parent.id} instead of a new ` +
          `proposal — refusing to archive it. Cluster left untouched.`
      )
      return false
    }

    memoryFactRepository.archiveFact(parent.id)

    // The parent was derived from each source fact.
    for (const fact of facts) {
      memoryFactRepository.createEdge({
        fromId: parent.id,
        toId: fact.id,
        edgeType: 'derived_from',
        confidence: cluster.meanSimilarity
      })
    }

    rLog.info(`[synthesizeCluster] Proposed "${parsed.title}" from ${facts.length} fact(s)`)
    return true
  }

  /** Synthesised parents awaiting review. */
  listPending(workspaceId: string): Array<{ parent: MemoryFact; children: MemoryFact[] }> {
    const archived = memoryFactRepository.findByWorkspace(workspaceId, 'archived')
    const pending = archived.filter(
      (f) => f.tags.includes(SYNTHESIS_TAG) && f.tags.includes(PENDING_REVIEW_TAG)
    )

    return pending.map((parent) => ({
      parent,
      children: memoryFactRepository.findNeighbours(parent.id, 'derived_from')
    }))
  }

  /**
   * Accept a proposal: the parent becomes active and its children are demoted
   * one tier.
   *
   * Children are demoted rather than archived. The parent is a generalisation,
   * and a generalisation is not a replacement — the specific observation may
   * still be the thing someone needs.
   */
  approve(parentId: string): MemoryFact | null {
    const parent = memoryFactRepository.findById(parentId)
    if (!parent) return null

    const children = memoryFactRepository.findNeighbours(parentId, 'derived_from')

    const activated = memoryFactRepository.updateFact(parentId, {
      status: 'active',
      tags: parent.tags.filter((t) => t !== PENDING_REVIEW_TAG)
    })
    // Re-open the validity window that archiving closed.
    memoryFactRepository.reopenValidity(parentId)

    for (const child of children) {
      if (child.tier > 0) {
        memoryFactRepository.updateFact(child.id, {
          tier: (child.tier - 1) as MemoryFact['tier']
        })
      }
    }

    rLog.info(`[approve] Activated "${activated.title}", demoted ${children.length} child fact(s)`)
    return activated
  }

  /** Reject a proposal. The parent stays archived; its edges are removed. */
  reject(parentId: string): void {
    for (const edge of memoryFactRepository.findEdgesForFact(parentId)) {
      memoryFactRepository.deleteEdge(edge.id)
    }
    memoryFactRepository.updateFact(parentId, {
      tags: ['synthesis', 'rejected']
    })
    rLog.info(`[reject] Rejected synthesis proposal ${parentId}`)
  }
}

// ── Prompt and parsing ──────────────────────────────────────────────────────

function buildSynthesisPrompt(facts: MemoryFact[]): string {
  const list = facts
    .map((f, i) => `${i + 1}. [${f.category}] ${f.title}\n   ${f.content}`)
    .join('\n\n')

  return [
    'You are consolidating a project knowledge base.',
    '',
    'Below are several related facts recorded separately about one codebase.',
    'They overlap. State the single underlying rule or decision they imply.',
    '',
    'Rules:',
    '- Write ONE fact that generalises them, not a list and not a summary of each.',
    '- If they do NOT share a single underlying rule, reply exactly: NONE',
    '- Be specific and actionable. Name the concrete convention.',
    '- Do not invent anything not supported by the inputs.',
    '',
    'Respond as JSON only, no prose, no code fence:',
    '{"category":"decision|convention|gotcha|preference|reference",',
    ' "title":"short imperative title",',
    ' "content":"one paragraph stating the rule and why"}',
    '',
    '## Facts',
    '',
    list
  ].join('\n')
}

const VALID_CATEGORIES: MemoryFactCategory[] = [
  'decision',
  'convention',
  'gotcha',
  'preference',
  'reference'
]

interface Synthesis {
  category: MemoryFactCategory
  title: string
  content: string
}

/** Parse the model's JSON reply, tolerating fences and surrounding prose. */
export function parseSynthesis(text: string): Synthesis | null {
  if (!text || /^\s*NONE\s*$/im.test(text)) return null

  const match = /\{[\s\S]*\}/.exec(text.replace(/```(?:json)?/gi, ''))
  if (!match) return null

  try {
    const data = JSON.parse(match[0]) as Record<string, unknown>
    const title = typeof data.title === 'string' ? data.title.trim() : ''
    const content = typeof data.content === 'string' ? data.content.trim() : ''
    if (title.length < 3 || content.length < 20) return null

    const category = VALID_CATEGORIES.includes(data.category as MemoryFactCategory)
      ? (data.category as MemoryFactCategory)
      : 'convention'

    return { category, title, content }
  } catch {
    return null
  }
}

/** Union of the children's scope paths, capped. */
export function mergeScopePaths(facts: MemoryFact[]): string[] {
  const out = new Set<string>()
  for (const fact of facts) {
    for (const path of fact.scopePaths) out.add(path)
  }
  return [...out].slice(0, 10)
}

export const memoryReflectionService = new MemoryReflectionService()
